#!/usr/bin/env node
/**
 * 启动链路行为探针：真起一遍程序，断言用户可观察的结果，然后收干净。
 *
 *   node tools/smoke.mjs                      服务 + 页面 + 渲染/ASR/转码闭环
 *   node tools/smoke.mjs --desktop           再加：真起 Electron 窗口 + 界面行为
 *   node tools/smoke.mjs --port 6001 --render-port 6002
 *
 * 覆盖：渲染服务健康接口 → 编辑器页面与构建资源 → 一次真实渲染请求 →
 *       本地识别与转码端点 → 未知接口 404 →（可选）桌面窗口加载编辑器、
 *       工具栏/时间轴/预览/设置面板的真实 DOM 行为与截图。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const DESKTOP = argv.includes("--desktop");
const PORT = Number(valueOf("--port") ?? 5193);
const RENDER_PORT = Number(valueOf("--render-port") ?? 5194);
const CDP_PORT = Number(valueOf("--cdp-port") ?? 9223);
const EDITOR = `http://127.0.0.1:${PORT}`;
const RENDER = `http://127.0.0.1:${RENDER_PORT}`;
const ELECTRON_EXE = path.join(ROOT, "resources", "runtime", "electron", "electron.exe");
const FFMPEG = path.join(ROOT, "resources", "bin", "ffmpeg.exe");
const PROBE_DIR = path.join(ROOT, "output", ".probe");

const results = [];
const check = (name, condition, detail = "") => {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? "√" : "×"} ${name}${detail ? " —— " + detail : ""}`);
};

async function waitFor(probe, timeoutMs = 25000, label = "服务") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} 在 ${timeoutMs / 1000}s 内未就绪`);
}

/** 纯 JS 造一段 16k 单声道静音 WAV，不依赖 ffmpeg 也能验证识别端点 */
function silentWav(seconds = 0.6, rate = 16000) {
  const samples = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** 造一段有高低起伏的测试音频 WAV：不依赖仓库外的素材，全新 clone 也能跑波形断言 */
function toneWav(seconds = 2.4, rate = 16000) {
  const samples = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const env = 0.12 + 0.8 * Math.abs(Math.sin(2 * Math.PI * 1.7 * t));
    const carrier =
      0.6 * Math.sin(2 * Math.PI * 660 * t) +
      0.3 * Math.sin(2 * Math.PI * 1320 * t) +
      0.1 * Math.sin(2 * Math.PI * 330 * t);
    const v = Math.round(env * carrier * 26000);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, v)), 44 + i * 2);
  }
  return buf;
}

/** 通过 CDP 在真实窗口里求值，只看 DOM 与可观察结果 */
async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const id = Math.floor(Math.random() * 1e6);
  const value = await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.onerror = reject;
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.close();
  return value;
}

const evalJs = async (wsUrl, expression) => {
  const r = await cdp(wsUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

/** 在单条持久 CDP 会话里跑多步 DOM 操作（nodeId 只在会话内有效） */
const withCdp = async (wsUrl, fn) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
};

const document = {
  schemaVersion: 1,
  id: "project_smoke",
  name: "启动探针",
  video: { width: 2560, height: 1440, fps: 30 },
  assets: [],
  tracks: [
    {
      id: "track_smoke",
      kind: "subtitle",
      name: "字幕轨",
      clips: [
        {
          id: "clip_smoke",
          trackId: "track_smoke",
          kind: "subtitle",
          startMs: 0,
          endMs: 1000,
          inMs: 0,
          data: { text: "启动探针" },
        },
      ],
    },
  ],
  selection: { clips: [], tracks: [] },
  settings: { logicalShortEdge: 1440 },
};

const launch = spawn(
  process.execPath,
  [
    path.join(ROOT, "tools", "launch.mjs"),
    "--no-open",
    "--port",
    String(PORT),
    "--render-port",
    String(RENDER_PORT),
  ],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
launch.stdout.on("data", (c) => (output += c.toString()));
launch.stderr.on("data", (c) => (output += c.toString()));

let electron = null;
let electronOutput = "";
let exitCode = 0;

try {
  console.log(`启动链路探针（编辑器 ${EDITOR} / 渲染 ${RENDER}${DESKTOP ? " / 桌面窗口" : ""}）`);
  await waitFor(async () => {
    const a = await fetch(`${RENDER}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    const b = await fetch(EDITOR, { signal: AbortSignal.timeout(1500) });
    return a.ok && b.ok;
  }, 25000, "两个服务");
  check("两个服务都在 25 秒内就绪", true);

  const health = await fetch(`${RENDER}/api/v1/health`);
  const healthBody = await health.json();
  check("健康接口返回 ok 与渲染后端", health.status === 200 && healthBody.ok === true, healthBody.provider);
  check(
    "本地识别 / ffmpeg / 转码服务均已就绪",
    healthBody.services?.asr === true && healthBody.services?.ffmpeg === true && healthBody.services?.transcode === true,
    JSON.stringify(healthBody.services ?? {}),
  );

  const page = await fetch(EDITOR);
  const html = await page.text();
  check("编辑器首页可访问且有挂载点", page.status === 200 && html.includes('id="root"'));

  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  check("首页引用了构建产物资源", Boolean(asset), asset ?? "未找到 /assets/ 引用");
  if (asset) {
    const res = await fetch(EDITOR + asset);
    const body = await res.text();
    check("构建资源可正常加载", res.status === 200 && body.length > 100, `${res.status} / ${body.length} 字节`);
  }

  const render = await fetch(`${RENDER}/api/v1/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "req_smoke",
      document,
      fromMs: 0,
      toMs: 500,
      fps: 30,
      width: 2560,
      height: 1440,
    }),
  });
  const renderBody = await render.json();
  check(
    "真实渲染请求成功并返回帧数",
    render.status === 200 && renderBody.result?.ok === true && renderBody.result.frames > 0,
    `frames=${renderBody.result?.frames}`,
  );

  const asrStart = await fetch(`${RENDER}/api/v1/asr?backend=cpu&vadMaxSeg=8000`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: silentWav(),
  });
  const asrBody = await asrStart.json();
  let asrJob = null;
  if (asrBody.jobId) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const poll = await fetch(`${RENDER}/api/v1/asr/${asrBody.jobId}/progress`);
      const data = await poll.json();
      if (data.progress?.done) {
        asrJob = data.progress;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  check(
    "语音识别端点受理任务并回传阶段",
    asrStart.status === 202 && asrBody.ok === true && Boolean(asrJob) &&
      Array.isArray(asrJob.history) && asrJob.history.length >= 1,
    `${asrStart.status} / ${(asrJob?.history ?? []).join("→") || "-"}`,
  );
  check(
    "静音音频给出明确提示",
    asrJob?.stage === "error" && String(asrJob.error ?? "").includes("没有识别到语音"),
    String(asrJob?.error ?? asrJob?.detail ?? "").slice(0, 60),
  );

  if (fs.existsSync(FFMPEG)) {
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    const webm = path.join(PROBE_DIR, "clip.webm");
    execFileSync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=0.4",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=0.4",
      "-c:v", "libvpx", "-b:v", "250k", "-c:a", "libopus", webm,
    ]);
    const transcode = await fetch(`${RENDER}/api/v1/media/transcode?format=mp4`, {
      method: "POST",
      headers: { "Content-Type": "video/webm" },
      body: fs.readFileSync(webm),
    });
    const mp4 = Buffer.from(await transcode.arrayBuffer());
    check("视频转码端点产出合法 MP4", transcode.status === 200 && mp4.subarray(4, 8).toString() === "ftyp", `${mp4.length} 字节`);
  }

  const unknown = await fetch(`${RENDER}/api/v1/nope`);
  check("未知接口返回 404", unknown.status === 404);

  if (DESKTOP) {
    check("Electron 运行时已安装", fs.existsSync(ELECTRON_EXE), ELECTRON_EXE);
    if (!fs.existsSync(ELECTRON_EXE)) throw new Error("缺少 Electron 运行时，先跑 安装依赖.bat");

    // 本机环境可能带 ELECTRON_RUN_AS_NODE=1，带上去 electron.exe 会退化成纯 Node、不开窗口
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      JEEK_EDITOR_URL: EDITOR,
      JEEK_RENDER_URL: RENDER,
      JEEK_RENDER_PORT: String(RENDER_PORT),
    });

    electron = spawn(
      ELECTRON_EXE,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        path.join(ROOT, "apps", "desktop"),
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    electron.stdout.on("data", (c) => (electronOutput += c.toString()));
    electron.stderr.on("data", (c) => (electronOutput += c.toString()));

    const pages = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      const list = await res.json();
      return list.some((p) => p.type === "page" && String(p.url).startsWith(EDITOR)) ? list : null;
    }, 30000, "Electron 窗口");
    const loaded = pages.find((p) => p.type === "page" && String(p.url).startsWith(EDITOR));
    check("桌面窗口加载了编辑器页面", Boolean(loaded), loaded?.url ?? "未找到目标页面");

    if (loaded?.webSocketDebuggerUrl) {
      const ws = loaded.webSocketDebuggerUrl;
      // 后台窗口的 rAF 会被节流，播放/滚动一类按帧推进的检查会偶发失真
      await cdp(ws, "Page.bringToFront").catch(() => {});
      const waitJs = async (expression, timeoutMs = 15000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const value = await evalJs(ws, expression);
          if (value) return value;
          await new Promise((r) => setTimeout(r, 200));
        }
        return null;
      };

      const mounted = await waitJs("document.querySelector('.jeek-app') ? 1 : 0");
      check("React 界面已挂载", mounted === 1, mounted ? "五段结构已渲染" : "未找到 .jeek-app");
      if (!mounted) {
        console.log("  [诊断] 页面文本：" + String(await evalJs(ws, "document.body.innerText.slice(0,320)")));
        console.log("  [诊断] 根节点：" + String(await evalJs(ws, "document.querySelector('#root')?.innerHTML.slice(0,220)")));
      }

      const brand = String((await evalJs(ws, "document.querySelector('.jeek-brand-name')?.textContent ?? ''")) ?? "");
      const sub = String((await evalJs(ws, "document.querySelector('.jeek-brand-sub')?.textContent ?? ''")) ?? "");
      const buttons = Number(await evalJs(ws, "document.querySelectorAll('.jeek-toolbar button').length")) || 0;
      check("顶栏品牌与工具行结构完整", brand.includes("吉客字幕剪辑") && sub.includes("Jeek Sub Cut") && buttons >= 6, `${brand} / ${buttons} 个按钮`);

      /* ---- 工具行图标化：6 个图标按钮、分组竖线、图标本体上也有悬浮提示 ---- */
      const toolIcons = await evalJs(ws, `(() => {
        const acts = [...document.querySelectorAll('.jeek-toolbar .jeek-tool-ico')].map((b) => b.dataset.act);
        return {
          acts,
          seps: document.querySelectorAll('.jeek-toolbar .jeek-tool-sep').length,
          textBtn: [...document.querySelectorAll('.jeek-toolbar .jeek-btn-secondary')].length,
        };
      })()`);
      check(
        "工具行全部改成图标按钮并分组",
        ["import.open", "audio.import", "audio.record", "project.open", "export.project", "export.srt"]
          .every((a) => toolIcons?.acts?.includes(a))
          && toolIcons.seps === 2
          && toolIcons.textBtn === 0,
        `图标 ${toolIcons?.acts?.length} 个 / 分割线 ${toolIcons?.seps} 条 / 文字按钮 ${toolIcons?.textBtn} 个`,
      );

      const tipOnIcon = await evalJs(ws, `(async () => {
        const btn = document.querySelector('.jeek-tool-ico[data-act="import.open"]');
        const shape = btn?.querySelector('svg path, svg rect');
        if (!shape) return { ok: false, why: '没有图标图形' };
        const b = shape.getBoundingClientRect();
        const at = { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
        shape.dispatchEvent(new MouseEvent('mouseover', at));
        shape.dispatchEvent(new MouseEvent('mousemove', at));
        await new Promise((r) => setTimeout(r, 160));
        const pop = document.querySelector('.jeek-tip-pop');
        const text = pop?.textContent ?? '';
        shape.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 140));
        return { ok: true, hasTip: Boolean(pop), text: text.slice(0, 16), cleared: !document.querySelector('.jeek-tip-pop') };
      })()`);
      check(
        "指针落在图标本体上悬浮提示不消失",
        Boolean(tipOnIcon?.ok) && tipOnIcon.hasTip === true && tipOnIcon.text.includes("导入字幕") && tipOnIcon.cleared,
        JSON.stringify(tipOnIcon),
      );

      const emptyState = await evalJs(ws, `(() => {
        const lane = document.querySelector('.jeek-tl-lane');
        const list = document.querySelector('.jeek-list-empty');
        const noClip = document.querySelectorAll('.jeek-tl-clip').length === 0;
        const laneText = lane ? lane.textContent.trim() : 'x';
        return Boolean(lane && list) && noClip && laneText === '' && list.textContent.includes('手动添加字幕');
      })()`);
      check("起手是空轨道（轨道内无提示文字）并给出引导文案", emptyState === true);

      const emptyLayout = await evalJs(ws, `(() => {
        const vp = document.querySelector('.jeek-tl-viewport');
        const track = document.querySelector('.jeek-tl-track');
        const bottom = document.querySelector('.jeek-bottom');
        const add = document.querySelector('.jeek-add-card');
        const time = (document.querySelector('.jeek-ctrl-time')?.textContent ?? '').replace(/\\s+/g, '');
        return {
          overflowX: vp ? vp.scrollWidth - vp.clientWidth : -1,
          cw: vp?.clientWidth ?? -1,
          sw: vp?.scrollWidth ?? -1,
          tw: track ? Math.round(track.getBoundingClientRect().width) : -1,
          styleW: track ? track.style.width : '',
          bottomGap: bottom && add ? Math.round(bottom.getBoundingClientRect().bottom - add.getBoundingClientRect().bottom) : -99,
          time,
        };
      })()`);
      check(
        "空态时间轴没有滚动条，播放时长是 0:00",
        Boolean(emptyLayout) && emptyLayout.overflowX <= 1 && emptyLayout.time.endsWith("/0:00"),
        JSON.stringify(emptyLayout),
      );
      check("底部文本框始终贴在底部模块最下方", emptyLayout?.bottomGap === 0, `间距 ${emptyLayout?.bottomGap}px`);
      await cdp(ws, "Page.captureScreenshot", { format: "png" }).then((s) =>
        fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-empty.png"), Buffer.from(s.data, "base64")),
      );

      // 走真实交互：填文本 → 点「＋ 添加字幕」，连做三次
      let added = 0;
      for (const text of ["第一句台词", "第二句台词", "第三句台词"]) {
        added +=
          Number(
            await evalJs(
              ws,
              `(async () => {
                const box = document.querySelector('.jeek-add-text');
                const btn = document.querySelector('.jeek-add-btn');
                if (!box || !btn) return 0;
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(box, ${JSON.stringify(text)});
                box.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise((r) => setTimeout(r, 80));
                btn.click();
                await new Promise((r) => setTimeout(r, 320));
                return 1;
              })()`,
            ),
          ) || 0;
      }
      const clips = Number(await evalJs(ws, "document.querySelectorAll('.jeek-tl-clip').length")) || 0;
      const cards = Number(await evalJs(ws, "document.querySelectorAll('.jeek-sub-card').length")) || 0;
      check("点三次「＋ 添加字幕」后时间轴与列表一致", added === 3 && clips === 3 && cards === 3, `时间轴 ${clips} / 列表 ${cards}`);

      // 回到第一条（添加完播放头停在末尾，那里没有字幕）
      await evalJs(ws, `(() => {
        const card = document.querySelector('.jeek-sub-card');
        card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return true;
      })()`);
      // 旧版第 0 帧的入场进度为 0（淡入从全透明起），先真播过 0.2s 入场窗口再看画面
      const togglePlay = `document.querySelector('.jeek-player-ctrl .jeek-ctrl-btn')?.click(); true`;
      await evalJs(ws, togglePlay);
      await new Promise((r) => setTimeout(r, 700));
      await evalJs(ws, togglePlay);
      await new Promise((r) => setTimeout(r, 250));
      const painted = await evalJs(ws, `(() => {
        const c = document.querySelector('.jeek-player canvas');
        if (!c) return 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let bright = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
        return bright;
      })()`);
      check("预览画布真的画出了字幕像素", painted > 500, `${painted} 个亮像素`);

      await evalJs(ws, `(() => {
        const input = document.querySelector('.jeek-sub-text');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '探针改过的字幕');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 350));
      const synced = await evalJs(ws, `[...document.querySelectorAll('.jeek-tl-clip-text')].some(e => e.textContent.includes('探针改过的字幕'))`);
      check("改字幕文本后时间轴卡片同步更新", synced === true);

      // 播放头根因验证：按 End 应精确停在「最后一张卡片的末端」，不多一帧也不少一帧。
      // 直接比对播放头竖线（.jeek-tl-head）的屏幕 X 与最后一张卡片右缘的屏幕 X，二者应重合。
      await evalJs(ws, `(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 250));
      const endProbe = await evalJs(ws, `(() => {
        const head = document.querySelector('.jeek-tl-head');
        const clips = document.querySelectorAll('.jeek-tl-clip');
        if (!head || !clips.length) return JSON.stringify({ ok: false });
        const hr = head.getBoundingClientRect();
        let maxRight = 0;
        clips.forEach((c) => { const r = c.getBoundingClientRect(); if (r.right > maxRight) maxRight = r.right; });
        return JSON.stringify({ ok: true, headLeft: hr.left, lastRight: maxRight, diff: Math.abs(hr.left - maxRight) });
      })()`);
      let endOk = false;
      let endDetail = "未取到位置";
      try {
        const p = JSON.parse(endProbe);
        endOk = p.ok && p.diff <= 2;
        endDetail = p.ok ? `播放头 X=${p.headLeft?.toFixed(1)} / 末卡右缘 X=${p.lastRight?.toFixed(1)} / 差=${p.diff?.toFixed(2)}px` : "无播放头或卡片";
      } catch { /* keep endDetail */ }
      check("按 End 播放头精确停在卡片末端（不多一帧/不少一帧）", endOk, endDetail);

      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const lightShot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
      const lightPath = path.join(PROBE_DIR, "editor-ui-light.png");
      fs.writeFileSync(lightPath, Buffer.from(lightShot.data, "base64"));
      check("默认浅色主题截图已生成", fs.statSync(lightPath).size > 10000, lightPath);

      const toggle = `document.querySelector('[aria-label="切换浅色/深色主题"]')?.click(); true`;
      await evalJs(ws, toggle);
      await new Promise((r) => setTimeout(r, 300));
      const dark = await evalJs(ws, `document.documentElement.classList.contains('dark')`);
      check("主题切换真的改变界面状态", dark === true);
      const darkShot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-dark.png"), Buffer.from(darkShot.data, "base64"));
      await evalJs(ws, toggle);
      await new Promise((r) => setTimeout(r, 250));

      const openPanel = async (selector) => {
        await evalJs(ws, `${selector}?.click(); true`);
        await new Promise((r) => setTimeout(r, 350));
        return Boolean(await evalJs(ws, `document.querySelector('.jeek-mask .jeek-modal') ? 1 : 0`));
      };
      const closePanel = async () => {
        await evalJs(ws, `document.querySelector('.jeek-mask .jeek-modal-x')?.click(); true`);
        await new Promise((r) => setTimeout(r, 300));
        return Boolean(await evalJs(ws, `document.querySelector('.jeek-mask') ? 1 : 0`));
      };

      if (await openPanel(`document.querySelector('[title="设置"]')`)) {
        const rows = Number(await evalJs(ws, "document.querySelectorAll('.jeek-set-row').length")) || 0;
        const about = String((await evalJs(ws, "document.querySelector('.jeek-about-ver')?.textContent ?? ''")) ?? "");
        check("设置面板列出视频选项与版本", rows >= 3 && about.length > 0, `${rows} 项 / ${about.trim()}`);
        await cdp(ws, "Page.captureScreenshot", { format: "png" }).then((s) =>
          fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-settings.png"), Buffer.from(s.data, "base64")),
        );
        check("关闭设置面板后遮罩消失", (await closePanel()) === false);
      } else {
        check("设置面板可打开", false, "未找到遮罩");
      }

      if (await openPanel(`document.querySelector('.jeek-export-btn')`)) {
        const controls = Number(await evalJs(ws, "document.querySelectorAll('.jeek-export-control').length")) || 0;
        const thumb = Boolean(await evalJs(ws, `document.querySelector('.jeek-export-thumb') ? 1 : 0`));
        check("导出面板展示缩略图与编码设置", controls >= 6 && thumb, `${controls} 组设置`);
        await cdp(ws, "Page.captureScreenshot", { format: "png" }).then((s) =>
          fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-export.png"), Buffer.from(s.data, "base64")),
        );
        await closePanel();
      } else {
        check("导出面板可打开", false, "未找到遮罩");
      }

      if (await openPanel(`document.querySelector('.jeek-toolbar [data-act="audio.record"]')`)) {
        const hasMeter = Boolean(await evalJs(ws, `document.querySelector('.jeek-meter') ? 1 : 0`));
        check("录音面板带有电平表", hasMeter === true);
        // 旧版录音窗口修订后的形态：实时波形 + 四个降噪开关排一行 + 已录段数
        const recShape = await evalJs(ws, `(() => {
          const canvas = document.querySelector('.jeek-rec-canvas');
          const checks = [...document.querySelectorAll('.jeek-rec-check')].map(el => Math.round(el.getBoundingClientRect().top));
          const count = document.querySelector('.jeek-rec-count')?.textContent ?? '';
          return JSON.stringify({ canvas: Boolean(canvas), checks, count });
        })()`);
        const shape = JSON.parse(recShape || "{}");
        check(
          "录音面板带实时波形、四个开关排一行与已录段数",
          shape.canvas === true
            && Array.isArray(shape.checks)
            && shape.checks.length === 4
            && new Set(shape.checks).size === 1
            && String(shape.count).includes("已录制"),
          recShape,
        );
        await closePanel();
      } else {
        check("录音面板可打开", false, "未找到遮罩");
      }

      if (await openPanel(`document.querySelector('[data-act="font.catalog"]')`)) {
        const fontInfo = await evalJs(ws, `(() => {
          const rows = [...document.querySelectorAll('.jeek-font-row')];
          const tags = rows.map((r) => r.querySelector('.jeek-font-tag')?.textContent ?? '');
          return {
            rows: rows.length,
            builtin: tags.filter((t) => t === '内置' || t === '系统').length,
            system: tags.filter((t) => t === '系统').length,
            editable: rows.filter((r) => r.querySelector('[data-act="font.rename"]')).length,
            faces: document.querySelectorAll('#jeek-font-faces').length,
            faceRules: (document.getElementById('jeek-font-faces')?.textContent ?? '').split('@font-face').length - 1,
            hasImport: Boolean(document.querySelector('[data-act="font.import"]')),
          };
        })()`);
        check(
          "字体目录只列系统字体，不附带第三方字体",
          fontInfo?.rows === 5 && fontInfo?.builtin === 5 && fontInfo?.system === 5,
          `${fontInfo?.rows} 款 / 内置 ${fontInfo?.builtin} 款（系统 ${fontInfo?.system}）`,
        );
        check(
          "字体目录：系统字体不可改名，可导入本地字体、无随程序分发的 @font-face",
          fontInfo?.editable === 0
            && fontInfo?.hasImport === true
            && fontInfo?.faceRules === 0,
          `可改名 ${fontInfo?.editable} / 非系统 ${(fontInfo?.rows ?? 0) - (fontInfo?.system ?? 0)} 款 · @font-face ${fontInfo?.faceRules} 条`,
        );
        // 全局字体下拉显示系统字体的中文名，而不是英文族名
        const fontSelectNames = await evalJs(ws, `[...document.querySelectorAll('.jeek-select option')].map((o) => o.textContent)`);
        check(
          "全局字体下拉显示系统字体中文名（如微软雅黑，而非 Microsoft YaHei）",
          Array.isArray(fontSelectNames)
            && fontSelectNames.some((t) => t.includes("微软雅黑"))
            && fontSelectNames.some((t) => /[一-龥]/.test(t)),
          JSON.stringify(fontSelectNames),
        );
        await closePanel();
      } else {
        check("字体目录面板可打开", false, "未找到遮罩");
      }

      /* ---- 左栏画布色值：预设四色 + 拾色器跟随 ---- */
      const canvasColor = await evalJs(ws, `(async () => {
        const presets = [...document.querySelectorAll('.jeek-preset')];
        const hex = document.querySelector('.jeek-hex-input');
        const picker = document.querySelector('.jeek-color-row input[type=color]');
        if (!presets.length || !hex || !picker) return { ok: false };
        const width = Math.round(hex.getBoundingClientRect().width);
        const original = hex.value;
        presets[1].click();
        await new Promise((r) => setTimeout(r, 240));
        const picked = { hex: hex.value, picker: picker.value };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(hex, original);
        hex.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        return {
          ok: true,
          count: presets.length,
          labels: presets.map((p) => p.getAttribute('aria-label') ?? ''),
          width,
          picked,
        };
      })()`);
      check(
        "画布背景预设四个（黑、白 + 两个彩色），点预设后色值框与拾色器一起跟着变",
        canvasColor?.ok === true
          && canvasColor.count === 4
          && canvasColor.labels.includes("纯黑")
          && canvasColor.labels.includes("纯白")
          && canvasColor.picked?.hex?.toLowerCase() === "#ffffff"
          && canvasColor.picked?.picker?.toLowerCase() === "#ffffff",
        `${(canvasColor?.labels ?? []).join(" / ")} → 色值 ${canvasColor?.picked?.hex} · 拾色器 ${canvasColor?.picked?.picker}`,
      );
      check("十六进制色值框缩短到只装 6 位色值的宽度", (canvasColor?.width ?? 999) <= 90, `${canvasColor?.width}px`);

      /* ---- 调色板：随机分配 + 恢复默认（两段确认） ---- */
      const paletteRun = await evalJs(ws, `(async () => {
        const reset = document.querySelector('[data-act="palette.reset"]');
        const random = document.querySelector('[data-act="palette.random"]');
        if (!reset || !random) return { ok: false };
        const countOf = () => document.querySelectorAll('.jeek-swatch').length;
        const start = countOf();
        reset.click();
        await new Promise((r) => setTimeout(r, 240));
        const armed = { text: reset.textContent.trim(), confirm: reset.classList.contains('is-confirm') };
        document.querySelector('.jeek-swatch-add')?.click();
        await new Promise((r) => setTimeout(r, 260));
        const added = countOf();
        reset.click();
        await new Promise((r) => setTimeout(r, 320));
        return {
          ok: true,
          start,
          armed,
          added,
          after: { text: reset.textContent.trim(), confirm: reset.classList.contains('is-confirm'), count: countOf() },
          randomText: random.textContent.trim(),
        };
      })()`);
      check(
        "调色板下方按钮为「随机分配」，旁边新增「恢复默认」",
        paletteRun?.ok === true && paletteRun.randomText === "随机分配" && paletteRun.start >= 1,
        `随机按钮「${paletteRun?.randomText}」· 起手 ${paletteRun?.start} 色`,
      );
      check(
        "「恢复默认」点一次只变成「确认恢复」，再点一次才清掉新增与改过的颜色",
        paletteRun?.armed?.confirm === true
          && paletteRun.armed.text === "确认恢复"
          && paletteRun.added === paletteRun.start + 1
          && paletteRun.after.count === 5
          && paletteRun.after.text === "恢复默认"
          && paletteRun.after.confirm === false,
        `确认态「${paletteRun?.armed?.text}」· 加色 ${paletteRun?.start}→${paletteRun?.added} · 恢复后 ${paletteRun?.after?.count} 色`
          + ` · 「${paletteRun?.after?.text}」`,
      );

      // 随机分配要真的写进字幕颜色：调色板就绪后每条都该落在调色板里
      const randomPaint = await evalJs(ws, `(async () => {
        const btn = document.querySelector('[data-act="palette.random"]');
        if (!btn) return { ok: false };
        const palette = [...document.querySelectorAll('.jeek-swatch input[type=color]')].map((i) => i.value.toLowerCase());
        const clipColors = () => [...document.querySelectorAll('.jeek-sub-color')].map((i) => i.value.toLowerCase());
        const before = clipColors();
        btn.click();
        await new Promise((r) => setTimeout(r, 460));
        const after = clipColors();
        return {
          ok: true,
          count: after.length,
          all: after.length > 0 && after.every((c) => palette.includes(c)),
          changed: after.join(",") !== before.join(","),
          before,
          after,
        };
      })()`);
      check(
        "「随机分配」把调色板里的颜色真的分给了每条字幕",
        randomPaint?.ok === true && randomPaint.all === true && randomPaint.changed === true,
        `${(randomPaint?.before ?? []).join(",")} → ${(randomPaint?.after ?? []).join(",")}`,
      );

      /* ---- 字幕列表：编辑开关、拆分后不再抢焦点、点时间轴退出编辑 ---- */
      const listEditOn = await evalJs(ws, `(async () => {
        const toggle = document.querySelector('[data-act="list.edit"]');
        if (!toggle) return { ok: false };
        const visible = () => [...document.querySelectorAll('.jeek-sub-line2')].filter((el) => getComputedStyle(el).display !== 'none').length;
        const before = visible();
        toggle.click();
        await new Promise((r) => setTimeout(r, 280));
        const off = visible();
        toggle.click();
        await new Promise((r) => setTimeout(r, 280));
        return { ok: true, before, off, back: visible() };
      })()`);
      check(
        "字幕列表顶部「编辑」开关：默认关闭（每条一行），打开后出现字号颜色行、再关掉只剩一行",
        listEditOn?.ok === true && listEditOn.before === 0 && listEditOn.off > 0 && listEditOn.back === 0,
        `第二行 ${listEditOn?.before} → ${listEditOn?.off} → ${listEditOn?.back}`,
      );

      const splitFocus = await evalJs(ws, `(async () => {
        const input = document.querySelector('.jeek-sub-text');
        if (!input) return { ok: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '前半句后半句');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 220));
        input.focus();
        input.setSelectionRange(4, 4);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 340));
        const active = document.activeElement;
        return {
          ok: true,
          cards: document.querySelectorAll('.jeek-sub-card').length,
          editing: Boolean(active?.classList?.contains('jeek-sub-text')),
          tag: active?.tagName ?? '',
        };
      })()`);
      check(
        "回车拆分后退出文本编辑状态（不再自动进入下一条）",
        splitFocus?.ok === true && splitFocus.cards >= 2 && splitFocus.editing === false,
        `${splitFocus?.cards} 条字幕 · 活动元素 ${splitFocus?.tag}`,
      );
      // 拆完立刻撤回，保持后面的卡片顺序与时间轴布局和检查前一致
      await evalJs(ws, `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 320));
        document.activeElement?.blur?.();
        return true;
      })()`);

      const blurOnTimeline = await evalJs(ws, `(async () => {
        const input = document.querySelector('.jeek-sub-text');
        const lane = document.querySelector('.jeek-tl-track');
        if (!input || !lane) return { ok: false };
        input.focus();
        await new Promise((r) => setTimeout(r, 140));
        const focused = document.activeElement === input;
        const b = lane.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: b.left + 6, clientY: b.top + b.height - 8 };
        lane.dispatchEvent(new MouseEvent('mousedown', at));
        window.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
        await new Promise((r) => setTimeout(r, 260));
        const active = document.activeElement;
        return {
          ok: true,
          focused,
          editing: Boolean(active?.classList?.contains('jeek-sub-text')),
          tag: active?.tagName ?? '',
        };
      })()`);
      check(
        "点时间轴就退出字幕文本编辑（不用再点回列表）",
        blurOnTimeline?.ok === true && blurOnTimeline.focused === true && blurOnTimeline.editing === false,
        `活动元素 ${blurOnTimeline?.tag}`,
      );

      /* ---- 时间轴工具行：自动填充与其它按钮同配色、设置终点箭头朝左 ---- */
      const toolLook = await evalJs(ws, `(() => {
        const fill = document.querySelector('[data-act="timeline.fill"]');
        const end = document.querySelector('[data-act="range.end"]');
        const paths = end ? [...end.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '') : [];
        return {
          fillPrimary: Boolean(fill?.classList.contains('is-primary')),
          fillClass: fill?.className ?? '',
          paths,
        };
      })()`);
      check(
        "自动填充按钮不再用主色，和其它工具按钮同配色",
        toolLook?.fillPrimary === false && !String(toolLook?.fillClass ?? "").includes("is-primary"),
        toolLook?.fillClass ?? "未找到按钮",
      );
      check(
        "「设置终点」图标是竖线在右、箭头朝左",
        Array.isArray(toolLook?.paths) && toolLook.paths.length >= 2 && toolLook.paths.some((d) => d.includes("l-4 4")),
        (toolLook?.paths ?? []).join(" | "),
      );

      if (await openPanel(`document.querySelector('[data-act="asr.open"]')`)) {
        const fields = Number(await evalJs(ws, "document.querySelectorAll('.jeek-mask .jeek-field').length")) || 0;
        check("语音转字幕面板带四项参数", fields === 4, `${fields} 项`);
        const flow = await evalJs(ws, `(() => {
          const steps = [...document.querySelectorAll('.jeek-mask .jeek-asr-step')];
          return {
            count: steps.length,
            taps: steps.filter((s) => Boolean(s.getAttribute('data-tip'))).length,
            cursor: steps.length ? getComputedStyle(steps[0]).cursor : '',
            text: steps.map((s) => s.textContent.trim()).join('/'),
          };
        })()`);
        check(
          "语音转字幕面板带三步流程说明（不可点选）",
          flow?.count === 3 && flow.taps === 3 && flow.cursor === "default",
          `${flow?.text} · 提示 ${flow?.taps} 条 · 光标 ${flow?.cursor}`,
        );
        fs.mkdirSync(PROBE_DIR, { recursive: true });
        await cdp(ws, "Page.captureScreenshot", { format: "png" }).then((s) =>
          fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-asr.png"), Buffer.from(s.data, "base64")),
        );
        await closePanel();
      } else {
        check("语音转字幕面板可打开", false, "未找到遮罩");
      }

      /* ---- 播放链路：画面与播放头必须一起走，不能只有声音 ---- */
      const seekZero = `(() => {
        const p = document.querySelector('.jeek-progress');
        if (!p) return false;
        const b = p.getBoundingClientRect();
        const at = { bubbles: true, clientX: b.left + 12, clientY: b.top + b.height / 2 };
        p.dispatchEvent(new MouseEvent('mousedown', at));
        window.dispatchEvent(new MouseEvent('mouseup', at));
        return true;
      })()`;
      const sample = `(() => {
        const c = document.querySelector('.jeek-player canvas');
        const info = { time: document.querySelector('.jeek-tl-time')?.textContent?.trim() || '', sum: 0 };
        if (c) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4 * 7) info.sum += d[i] + d[i + 1] + d[i + 2];
        }
        return info;
      })()`;
      await evalJs(ws, seekZero);
      await new Promise((r) => setTimeout(r, 250));
      const beforePlay = await evalJs(ws, sample);
      await evalJs(ws, `document.querySelector('.jeek-player-ctrl .jeek-ctrl-btn')?.click(); true`);
      await new Promise((r) => setTimeout(r, 1600));
      const afterPlay = await evalJs(ws, sample);
      await evalJs(ws, `document.querySelector('.jeek-player-ctrl .jeek-ctrl-btn')?.click(); true`);
      check("点播放后播放头真的推进", beforePlay?.time !== afterPlay?.time, `${beforePlay?.time} → ${afterPlay?.time}`);
      check("点播放后画面跟着变", beforePlay?.sum !== afterPlay?.sum, `${beforePlay?.sum} → ${afterPlay?.sum}`);

      /* ---- 时间轴交互：缩放倍率、真拖改时长与撤销、播放头跟随 ---- */
      const zoomMeta = await evalJs(ws, `(() => {
        const r = document.querySelector('.jeek-tl-zoom-range');
        const label = document.querySelector('.jeek-tl-zoom-val');
        return r ? { min: r.min, max: r.max, step: r.step, value: r.value, text: label?.textContent?.trim() ?? '' } : null;
      })()`);
      check(
        "缩放是 1~20 倍率，最左端显示「自动」",
        Boolean(zoomMeta) && zoomMeta.min === "1" && zoomMeta.max === "20" && zoomMeta.step === "0.05" && zoomMeta.value === "1" && zoomMeta.text === "自动",
        JSON.stringify(zoomMeta),
      );
      const zoomWidth = Number(await evalJs(ws, "Math.round(document.querySelector('.jeek-tl-zoom-range')?.getBoundingClientRect().width ?? 0)")) || 0;
      check("缩放滑块加长到 208px（原 104px 的 2 倍）", Math.abs(zoomWidth - 208) <= 2, `${zoomWidth}px`);

      const zoomed = await evalJs(ws, `(async () => {
        const r = document.querySelector('.jeek-tl-zoom-range');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(r, '2.5');
        r.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 260));
        return {
          text: document.querySelector('.jeek-tl-zoom-val')?.textContent?.trim() ?? '',
          track: document.querySelector('.jeek-tl-track')?.getBoundingClientRect().width ?? 0,
          viewport: document.querySelector('.jeek-tl-viewport')?.clientWidth ?? 1,
        };
      })()`);
      check(
        "放大后标签为 ×2.5 且轨道按比例变宽",
        zoomed?.text === "×2.5" && zoomed.track > zoomed.viewport * 2,
        `${zoomed?.text} / 轨道 ${Math.round(zoomed?.track ?? 0)}px / 视口 ${zoomed?.viewport}px`,
      );

      const clipGeometry = `(() => [...document.querySelectorAll('.jeek-tl-clip')].map((c) => {
        const b = c.getBoundingClientRect();
        return { left: Math.round(b.left * 10) / 10, width: Math.round(b.width * 10) / 10 };
      }))()`;
      const beforeTrim = await evalJs(ws, clipGeometry);
      await evalJs(ws, `(async () => {
        const clip = document.querySelector('.jeek-tl-clip');
        const handle = clip?.querySelectorAll('.jeek-tl-handle')[0];
        if (!handle) return false;
        const b = handle.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
        await new Promise((r) => setTimeout(r, 120));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 60, clientY: y }));
        await new Promise((r) => setTimeout(r, 80));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 60, clientY: y }));
        await new Promise((r) => setTimeout(r, 220));
        return true;
      })()`);
      const afterTrim = await evalJs(ws, clipGeometry);
      const noOverlap = afterTrim.every((c, i) => i === 0 || c.left >= afterTrim[i - 1].left + afterTrim[i - 1].width - 1);
      check(
        "拖动左端改时长：卡片变短且相邻卡片不被覆盖",
        afterTrim[0]?.width < beforeTrim[0]?.width - 5 && noOverlap,
        `首卡 ${beforeTrim[0]?.width} → ${afterTrim[0]?.width}px / 不重叠 ${noOverlap}`,
      );

      await evalJs(ws, `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 260));
        return true;
      })()`);
      const undone = await evalJs(ws, clipGeometry);
      check(
        "撤销一次恢复原状",
        Math.abs((undone[0]?.width ?? 0) - (beforeTrim[0]?.width ?? 0)) < 1.5,
        `首卡 ${afterTrim[0]?.width} → ${undone[0]?.width}px（原 ${beforeTrim[0]?.width}px）`,
      );

      const follow = await evalJs(ws, `(async () => {
        const vp = document.querySelector('.jeek-tl-viewport');
        const r = document.querySelector('.jeek-tl-zoom-range');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        // 先把播放头压回开头：播放到头之后再点播放不会自动回卷，测不到跟随
        const p = document.querySelector('.jeek-progress');
        if (p) {
          const pb = p.getBoundingClientRect();
          const at = { bubbles: true, clientX: pb.left + 1, clientY: pb.top + pb.height / 2 };
          p.dispatchEvent(new MouseEvent('mousedown', at));
          window.dispatchEvent(new MouseEvent('mouseup', at));
          await new Promise((res) => setTimeout(res, 220));
        }
        setter.call(r, '8');
        r.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 240));
        const before = vp.scrollLeft;
        const btn = document.querySelector('.jeek-player-ctrl .jeek-ctrl-btn');
        btn?.click();
        await new Promise((res) => setTimeout(res, 1700));
        btn?.click();
        const after = vp.scrollLeft;
        setter.call(r, '1');
        r.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 160));
        vp.scrollLeft = 0;
        return { before, after };
      })()`);
      check(
        "播放时轨道自动滚动跟随播放头",
        follow.after > follow.before,
        `scrollLeft ${follow.before} → ${follow.after}`,
      );

      /* ---- 音频轨：导入一段带起伏的 WAV → 波形绘制 + 源内偏移标题（放最后，避免拉长的时间轴扰动上面的缩放/拖拽检查） ---- */
      // 测试音频在运行时生成，不依赖白名单外的素材，全新 clone 也能跑
      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const audioAsset = path.join(PROBE_DIR, "tone.wav");
      fs.writeFileSync(audioAsset, toneWav());
      if (fs.existsSync(audioAsset)) {
        const injected = await withCdp(ws, async (send) => {
          await send("DOM.enable");
          const root = (await send("DOM.getDocument", { depth: -1 })).root.nodeId;
          const node = await send("DOM.querySelector", { nodeId: root, selector: ".jeek-audio input[type=file]" });
          if (!node?.nodeId) return { ok: false, why: "no input" };
          await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [audioAsset] });
          return { ok: true };
        });
        if (injected?.ok) {
          const appeared = await waitJs("document.querySelector('.jeek-tl-audio-clip') ? 1 : 0", 12000);
          check("导入音频后时间轴出现音频块", appeared === 1);
          if (appeared === 1) {
            const titleHasSrc = await evalJs(
              ws,
              `(() => { const c = document.querySelector('.jeek-tl-audio-clip'); return (c?.getAttribute('title') || '').includes('源自'); })()`,
            );
            check("音频块标题带源内偏移「源自」", titleHasSrc === true);
            const wave = await evalJs(
              ws,
              `(() => {
                const cv = document.querySelector('.jeek-tl-audio-clip .jeek-wave-canvas');
                if (!cv) return { ok: false, why: 'no canvas' };
                const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
                let painted = 0, minY = 1e9, maxY = -1;
                for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
                  if (d[(y * cv.width + x) * 4 + 3] > 20) { painted++; if (y < minY) minY = y; if (y > maxY) maxY = y; }
                }
                return { ok: true, painted, span: maxY - minY, h: cv.height };
              })()`,
            );
            check("音频块波形画布真的画出了内容", wave?.ok && wave.painted > 500, wave?.ok ? `像素 ${wave.painted}` : JSON.stringify(wave));
            check("波形不是一条直线（有高低起伏）", wave?.ok && wave.span > wave.h * 0.25, wave?.ok ? `跨度 ${wave.span}/${wave.h}` : "");
            // 20 倍缩放下波形仍清晰：不再是一张被浏览器画布上限（16384px）截断后拉伸的糊图，
            // 而是切成多块、每块位图按设备像素给足（单块宽 <= 16384）。
            const wave20 = await evalJs(ws, `(async () => {
              const zoom = document.querySelector('.jeek-tl-zoom-range');
              if (!zoom) return { ok: false, why: 'no-zoom' };
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(zoom, '20');
              zoom.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 350));
              const clip = document.querySelector('.jeek-tl-audio-clip');
              if (!clip) return { ok: false, why: 'no-clip' };
              const cs = [...clip.querySelectorAll('canvas.jeek-wave-canvas')];
              let maxW = 0, painted = 0;
              for (const c of cs) {
                maxW = Math.max(maxW, c.width);
                try {
                  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) painted += 1;
                } catch (e) {}
              }
              setter.call(zoom, '1');
              zoom.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 160));
              return { ok: true, tiles: cs.length, maxW, painted };
            })()`);
            check(
              "20 倍缩放下波形切成多块且单块位图不超限（清晰不糊）",
              wave20?.ok === true && wave20.tiles >= 1 && wave20.maxW <= 16384 && wave20.painted > 500,
              `块数 ${wave20?.tiles} · 单块宽 ${wave20?.maxW} · 像素 ${wave20?.painted}`,
            );
            // 播放长度跟随轨道末尾：刻度尺留白不算进播放时长（旧版第 77 条的修法）
            const playLen = await evalJs(
              ws,
              `(() => {
                const text = document.querySelector('.jeek-ctrl-time')?.textContent ?? '';
                const m = text.match(/\\/\\s*(\\d+):(\\d+)$/);
                const clip = document.querySelector('.jeek-tl-audio-clip')?.getAttribute('title') ?? '';
                const t = [...clip.matchAll(/(\\d+):(\\d+):(\\d+)\\.(\\d+)/g)].map(x => Number(x[1]) * 3600000 + Number(x[2]) * 60000 + Number(x[3]) * 1000 + Number(x[4]));
                return { totalSec: m ? Number(m[1]) * 60 + Number(m[2]) : -1, clipEndMs: t.length >= 2 ? t[1] : -1 };
              })()`,
            );
            check(
              "播放长度跟随轨道末尾（不按刻度尺留白多给几秒）",
              playLen?.totalSec >= 0
                && playLen?.clipEndMs > 0
                // 总长只显示到秒（0:02），与轨道末尾相差不到一秒都算对；
                // 多给几秒留白（刻度尺的 8% + 3 秒）会直接落到外面
                && Math.abs(playLen.totalSec * 1000 - playLen.clipEndMs) <= 1000,
              JSON.stringify(playLen),
            );
            /* ---- 音频卡片交互：左端 / 右端把手都能拖，右端不越过源音频结尾 ---- */
            const audioGeom = `(() => {
              const c = document.querySelector('.jeek-tl-audio-clip');
              if (!c) return null;
              const b = c.getBoundingClientRect();
              return { left: Math.round(b.left), width: Math.round(b.width) };
            })()`;
            const geom0 = await evalJs(ws, audioGeom);
            /** 拖某个把手：dx 为屏幕像素位移 */
            const dragHandle = (selector, dx) => `(async () => {
              const h = document.querySelector('${selector}');
              if (!h) return false;
              const b = h.getBoundingClientRect();
              const x = b.left + b.width / 2;
              const y = b.top + b.height / 2;
              h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
              await new Promise((r) => setTimeout(r, 110));
              window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + ${dx}, clientY: y }));
              await new Promise((r) => setTimeout(r, 90));
              window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + ${dx}, clientY: y }));
              await new Promise((r) => setTimeout(r, 280));
              return true;
            })()`;
            await evalJs(ws, dragHandle(".jeek-tl-audio-clip .jeek-tl-audio-handle.is-end", -120));
            const geomShrunk = await evalJs(ws, audioGeom);
            check(
              "音频卡片右端把手可拖动（缩短）",
              Boolean(geomShrunk) && geomShrunk.width < geom0.width - 40,
              `${geom0?.width} → ${geomShrunk?.width}px`,
            );
            // 再往右狠拉：能长回去，但不可能超过源音频总长
            await evalJs(ws, dragHandle(".jeek-tl-audio-clip .jeek-tl-audio-handle.is-end", 400));
            const geomGrown = await evalJs(ws, audioGeom);
            check(
              "音频右端拉回时不越过源音频结尾",
              Boolean(geomGrown)
                && geomGrown.width > geomShrunk.width + 20
                && geomGrown.width <= geom0.width + 2,
              `缩到 ${geomShrunk?.width} → 拉回 ${geomGrown?.width}px（源上限 ${geom0?.width}px）`,
            );
            await evalJs(ws, dragHandle(".jeek-tl-audio-clip .jeek-tl-audio-handle.is-start", 100));
            const geomTrimmed = await evalJs(ws, audioGeom);
            check(
              "音频卡片左端把手可拖动改时长",
              Boolean(geomTrimmed) && geomTrimmed.width < geomGrown.width - 40,
              `${geomGrown?.width} → ${geomTrimmed?.width}px`,
            );

            /* ---- 相邻音频卡片的分界：拖一下同时改两张卡片的时长，总跨度不变 ---- */
            const audioJunction = await evalJs(ws, `(async () => {
              // 切点取音频卡片自己的中点：标尺 50% 很可能落在音频之外，切不出两段
              const clip = document.querySelector('.jeek-tl-audio-clip');
              if (!clip) return { ok: false, why: '没有音频卡片' };
              const cb = clip.getBoundingClientRect();
              const ruler = document.querySelector('.jeek-tl-ruler');
              const cx = cb.left + cb.width * 0.5;
              const cy = ruler.getBoundingClientRect().top + 12;
              ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
              window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
              await new Promise((r) => setTimeout(r, 180));
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 360));
              const geom = () => [...document.querySelectorAll('.jeek-tl-audio-clip')]
                .map((c) => c.getBoundingClientRect())
                .sort((a, b2) => a.left - b2.left)
                .map((r) => ({ left: Math.round(r.left), width: Math.round(r.width) }));
              const before = geom();
              const j = document.querySelector('.jeek-tl-junction.is-audio');
              if (!j) return { ok: false, why: '没有音频分界手柄', count: before.length };
              const b = j.getBoundingClientRect();
              const x = b.left + b.width / 2;
              const y = b.top + b.height / 2;
              j.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
              await new Promise((r) => setTimeout(r, 110));
              window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x - 60, clientY: y }));
              await new Promise((r) => setTimeout(r, 90));
              window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x - 60, clientY: y }));
              await new Promise((r) => setTimeout(r, 300));
              const after = geom();
              const span = (g) => (g.length ? g[g.length - 1].left + g[g.length - 1].width - g[0].left : 0);
              return { ok: true, before, after, spanBefore: span(before), spanAfter: span(after) };
            })()`);
            check(
              "切分出来的两段音频各自都没被剪过，分界推不动（不会把两段内容拼接）",
              Boolean(audioJunction?.ok)
                && audioJunction.before.length === 2
                && Math.abs(audioJunction.after[0].width - audioJunction.before[0].width) <= 1
                && Math.abs(audioJunction.after[1].width - audioJunction.before[1].width) <= 1
                && Math.abs(audioJunction.spanAfter - audioJunction.spanBefore) <= 3,
              audioJunction?.ok
                ? `左卡 ${audioJunction.before[0].width}→${audioJunction.after[0].width}px / 右卡 ${audioJunction.before[1].width}→${audioJunction.after[1].width}px / 总跨度 ${audioJunction.spanBefore}→${audioJunction.spanAfter}px`
                : (audioJunction?.why ?? "未执行"),
            );

            /* ---- 缩放锚点：播放头在视口里的横坐标不该随缩放漂移 ---- */
            const zoomAnchor = await evalJs(ws, `(async () => {
              const vp = document.querySelector('.jeek-tl-viewport');
              const r = document.querySelector('.jeek-tl-zoom-range');
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              const setZoom = async (v) => {
                setter.call(r, String(v));
                r.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise((res) => setTimeout(res, 300));
              };
              const ruler = document.querySelector('.jeek-tl-ruler');
              const rb = ruler.getBoundingClientRect();
              const cx = rb.left + rb.width * 0.5;
              const cy = rb.top + rb.height / 2;
              ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
              window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
              await new Promise((res) => setTimeout(res, 200));
              const probe = () => {
                const head = document.querySelector('.jeek-tl-head');
                const track = document.querySelector('.jeek-tl-track');
                return {
                  x: Math.round(head.getBoundingClientRect().left - vp.getBoundingClientRect().left),
                  scroll: Math.round(vp.scrollLeft),
                  width: Math.round(track.getBoundingClientRect().width),
                };
              };
              const steps = [];
              for (const z of [1, 1.4, 2.5, 3.3, 4.5]) {
                await setZoom(z);
                steps.push({ zoom: z, ...probe() });
              }
              await setZoom(1);
              const base = steps[0].x;
              return { steps, drift: Math.max(...steps.map((s) => Math.abs(s.x - base))) };
            })()`);
            check(
              "缩放时播放头在视口里的位置不漂移",
              Boolean(zoomAnchor) && zoomAnchor.drift <= 8,
              zoomAnchor ? `漂移 ${zoomAnchor.drift}px · ${zoomAnchor.steps.map((s) => `×${s.zoom}:${s.x}`).join(" ")}` : "未执行",
            );

            await cdp(ws, "Page.captureScreenshot", { format: "png" }).then((s) =>
              fs.writeFileSync(path.join(PROBE_DIR, "editor-ui-audio.png"), Buffer.from(s.data, "base64")),
            );
          }
        } else {
          check("找到音频文件输入", false, injected?.why ?? "注入失败");
        }
      } else {
        check("测试音频已就绪", false, "tone.wav 生成失败");
      }

      /* ---- 语音转字幕参数：改滑块实时回显，关掉重开仍保持（随工程保存） ---- */
      const asrBtn = `document.querySelector('[data-act="asr.open"]')`;
      if (await openPanel(asrBtn)) {
        const changed = await evalJs(ws, `(() => {
          const r = [...document.querySelectorAll('.jeek-asr-sliders input[type=range]')].find(x => x.max === '24');
          if (!r) return null;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(r, '16');
          r.dispatchEvent(new Event('input', { bubbles: true }));
          const note = [...document.querySelectorAll('.jeek-field')].map(x => x.textContent).find(t => t.includes('单句最多字数')) || '';
          return { value: r.value, note };
        })()`);
        check("拖单句字数滑块标签实时回显", changed?.value === "16" && String(changed?.note ?? "").includes("16 字"), JSON.stringify(changed));
        await new Promise((r) => setTimeout(r, 250));
        await closePanel();
        if (await openPanel(asrBtn)) {
          const kept = await evalJs(ws, `(() => {
            const r = [...document.querySelectorAll('.jeek-asr-sliders input[type=range]')].find(x => x.max === '24');
            return r ? r.value : null;
          })()`);
          check("参数改动随工程保存", kept === "16", `重开后 ${kept}`);
          await closePanel();
        } else {
          check("语音转字幕面板可重新打开", false, "未找到遮罩");
        }
      } else {
        check("语音转字幕面板可再次打开", false, "未找到遮罩");
      }

      /* ---- 导出面板：八项设置、CRF 范围、时间戳文件名、档位可切换 ---- */
      if (await openPanel(`document.querySelector('.jeek-export-btn')`)) {
        const form = await evalJs(ws, `(() => {
          const labels = [...document.querySelectorAll('.jeek-mask .jeek-export-row > label')].map(l => l.textContent);
          const crf = document.querySelector('.jeek-mask .jeek-export-crf input');
          const name = document.querySelector('.jeek-mask .jeek-export-form input.jeek-input')?.value || '';
          return {
            labels,
            crfMin: crf?.min, crfMax: crf?.max,
            name,
            thumb: !!document.querySelector('.jeek-mask .jeek-export-thumb'),
          };
        })()`);
        const need = ["文件名", "保存位置", "编码器", "分辨率", "编码速度", "画质 CRF", "编码加速", "并行帧数"];
        check("导出面板八项设置齐全", need.every((v) => form?.labels?.includes(v)), JSON.stringify(form?.labels));
        check("CRF 滑杆范围 14~30", form?.crfMin === "14" && form?.crfMax === "30", `${form?.crfMin}~${form?.crfMax}`);
        check("默认文件名：时间戳或时间戳_素材名", /^\d{8}-\d{6}(?:_[^\s]+)?$/.test(String(form?.name ?? "")), form?.name);
        check("导出面板带预览缩略图", form?.thumb === true);
        const clickSeg = (label) =>
          evalJs(
            ws,
            `(() => {
              const btn = [...document.querySelectorAll('.jeek-mask .jeek-export-seg button')].find(b => b.textContent === ${JSON.stringify(label)});
              if (!btn) return false;
              btn.click();
              return true;
            })()`,
          );
        const hitHevc = await clickSeg("H.265");
        await new Promise((r) => setTimeout(r, 260));
        const hitGpu = await clickSeg("显卡");
        await new Promise((r) => setTimeout(r, 260));
        const picked = await evalJs(ws, `(() => [...document.querySelectorAll('.jeek-mask .jeek-export-seg')].map(g => ({
          on: [...g.querySelectorAll('button.is-on')].map(b => b.textContent),
        })))()`);
        const flat = (picked ?? []).flatMap((g) => g.on);
        check(
          "编码器与加速档可切换且每组只选一个",
          hitHevc === true && hitGpu === true && flat.includes("H.265") && flat.includes("显卡") && (picked ?? []).every((g) => g.on.length <= 1),
          JSON.stringify(flat),
        );
        await closePanel();
      } else {
        check("导出面板可打开", false, "未找到遮罩");
      }

      /* ---- 快捷键：方向键步进、Ctrl+T 加字幕、Esc 清选中 ---- */
      const readClock = `(() => {
        const text = document.querySelector('.jeek-tl-time')?.textContent?.trim() || '';
        const m = text.match(/(\\d+):(\\d+):(\\d+)\\.(\\d+)/);
        if (!m) return { text, frames: -1 };
        return { text, frames: ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 30 + Number(m[4]) };
      })()`;
      await evalJs(ws, `(() => {
        const p = document.querySelector('.jeek-progress');
        const b = p.getBoundingClientRect();
        const at = { bubbles: true, clientX: b.left + 1, clientY: b.top + b.height / 2 };
        p.dispatchEvent(new MouseEvent('mousedown', at));
        window.dispatchEvent(new MouseEvent('mouseup', at));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 220));
      const baseClock = await evalJs(ws, readClock);
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 200));
      const oneFrame = await evalJs(ws, readClock);
      check("→ 走一帧", oneFrame?.frames > baseClock?.frames, `${baseClock?.text} → ${oneFrame?.text}`);
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 200));
      const fiveSec = await evalJs(ws, readClock);
      // 播放头停在视频末尾（轨道末尾 + 1 帧），走不到刻度尺的留白区
      const videoEnd = await evalJs(ws, `(() => {
        const text = document.querySelector('.jeek-ctrl-time')?.textContent ?? '';
        const m = text.match(/\\/\\s*(\\d+):(\\d+)$/);
        return m ? (Number(m[1]) * 60 + Number(m[2])) * 30 : -1;
      })()`);
      const stepFrames = fiveSec?.frames - oneFrame?.frames;
      check(
        "Shift+→ 走 5 秒（到视频末尾为止）",
        stepFrames >= 120 || (videoEnd > 0 && fiveSec?.frames >= videoEnd - 2),
        `${oneFrame?.text} → ${fiveSec?.text} / 视频末帧 ${videoEnd}`,
      );
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 200));
      const backOne = await evalJs(ws, readClock);
      check("← 回退一帧", backOne?.frames < fiveSec?.frames, `${fiveSec?.text} → ${backOne?.text}`);

      // End 定位末尾：应该停在最后一条字幕的最后一帧上，画布仍看得到字；
      // 再按 → 走不动。若尾部多留一帧，这里就会落到一条空帧上、画布变空。
      const tailState = await evalJs(ws, `(async () => {
        document.activeElement?.blur?.();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 340));
        const shot = () => {
          const c = document.querySelector('.jeek-player canvas');
          if (!c) return 0;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          // 用左上角当背景色，数「跟背景不一样」的像素：字幕换什么配色都能判出来
          const bg = [d[0], d[1], d[2]];
          let diff = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) diff += 1;
          }
          return diff;
        };
        const clock = document.querySelector('.jeek-tl-time')?.textContent?.trim() ?? '';
        const inked = shot();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 240));
        return { clock, inked, after: document.querySelector('.jeek-tl-time')?.textContent?.trim() ?? '', stillInked: shot() };
      })()`);
      check(
        "End 停在最后一帧上（画布仍有字幕），再按 → 不再推进：尾部没有多出一帧",
        Number(tailState?.inked) > 500 && tailState?.after === tailState?.clock,
        `${tailState?.clock} 字幕像素 ${tailState?.inked} → 再按 ${tailState?.after} / ${tailState?.stillInked}`,
      );

      const cardsBefore = Number(await evalJs(ws, "document.querySelectorAll('.jeek-sub-card').length")) || 0;
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 320));
      const cardsAfter = Number(await evalJs(ws, "document.querySelectorAll('.jeek-sub-card').length")) || 0;
      check("Ctrl+T 加一条字幕", cardsAfter === cardsBefore + 1, `${cardsBefore} → ${cardsAfter}`);

      const selected = await evalJs(ws, `(() => {
        const clip = document.querySelector('.jeek-tl-clip');
        if (!clip) return { ok: false, why: '没找到时间轴卡片' };
        const b = clip.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
        clip.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
        window.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
        return { ok: true };
      })()`);
      await new Promise((r) => setTimeout(r, 260));
      const hasSelection = Number(await evalJs(ws, "document.querySelectorAll('.jeek-tl-clip.is-selected').length")) || 0;
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 260));
      const afterEsc = Number(await evalJs(ws, "document.querySelectorAll('.jeek-tl-clip.is-selected').length")) || 0;
      check("点卡片能选中、Esc 取消选中", selected?.ok === true && hasSelection > 0 && afterEsc === 0, `选中 ${hasSelection} → ${afterEsc}`);

      /* ---- 导入旧版工程：字幕、样式、比例完整还原 ---- */
      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const legacyFile = path.join(PROBE_DIR, "legacy-project.json");
      fs.writeFileSync(
        legacyFile,
        JSON.stringify({
          app: "JeekSubCut",
          version: 1,
          subtitles: [
            { id: 1, text: "旧版第一句", startMs: 0, endMs: 1200, fontSize: 96, fontFamily: "SimHei", color: "#FFB4A2", enterAnimation: "scale", moveAnimation: "up" },
            { id: 2, text: "旧版第二句", startMs: 1200, endMs: 2600, fontSize: 90, color: "#A0E7E5" },
            { id: 3, text: "旧版第三句", startMs: 2600, endMs: 4000, fontSize: 88, color: "#B8C0FF" },
          ],
          settings: {
            anchor: { x: 0.5, y: 0.3 },
            style: { minFontSize: 80, maxFontSize: 120, fontFamily: "SimHei", colorPalette: ["#FFF4B5", "#FFB4A2"] },
            randomStyle: true,
            rotateEvery: 3,
            asrMaxChars: 12,
          },
          audio: null,
          audioSegments: [],
          exportRange: { start: 0, end: 4000 },
        }),
        "utf8",
      );
      const injectedLegacy = await withCdp(ws, async (send) => {
        await send("DOM.enable");
        const root = (await send("DOM.getDocument", { depth: -1 })).root.nodeId;
        const node = await send("DOM.querySelector", { nodeId: root, selector: ".jeek-project input[type=file]" });
        if (!node?.nodeId) return { ok: false, why: "no input" };
        await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [legacyFile] });
        return { ok: true };
      });
      if (injectedLegacy?.ok) {
        const restored = await waitJs(
          `(() => {
            const texts = [...document.querySelectorAll('.jeek-sub-text')].map(i => i.value || '');
            return texts.filter(t => t.includes('旧版')).length === 3 ? 1 : 0;
          })()`,
          8000,
        );
        const legacyMeta = await evalJs(ws, `(() => ({
          count: document.querySelectorAll('.jeek-sub-card').length,
          texts: [...document.querySelectorAll('.jeek-sub-text')].map(i => i.value || ''),
          aspect: document.querySelector('.jeek-video-meta')?.textContent || '',
        }))()`);
        check("旧版工程导入后字幕完整还原", restored === 1, `卡片 ${legacyMeta?.count} 条`);
        check(
          "旧版工程字幕条数与内容正确",
          legacyMeta?.count === 3 && (legacyMeta?.texts ?? []).some((t) => String(t).includes("旧版第一句")),
          JSON.stringify(legacyMeta?.texts),
        );
        check("旧版工程比例还原到工具栏", String(legacyMeta?.aspect ?? "").includes("16:9"), legacyMeta?.aspect);
      } else {
        check("找到工程文件输入", false, injectedLegacy?.why ?? "注入失败");
      }

      /* ---- 优化日志补齐项：查找替换、列表键盘拆分合并、播放高亮 ---- */
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 240));
      const findTitle = String(await evalJs(ws, "document.querySelector('.jeek-mask .jeek-modal-title')?.textContent ?? ''"));
      check("Ctrl+H 打开查找替换面板", findTitle.includes("查找替换"), findTitle);
      await evalJs(ws, `(() => { document.querySelector('.jeek-modal-x')?.click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 220));

      const listTexts = () => evalJs(ws, "[...document.querySelectorAll('.jeek-sub-text')].map(i => i.value).join('|')");
      const listCount = () => evalJs(ws, "document.querySelectorAll('.jeek-sub-card').length");
      const listKey = async (which, key, caret) => {
        await evalJs(ws, `(() => {
          const el = document.querySelectorAll('.jeek-sub-text')[${which}];
          if (!el) return false;
          el.focus();
          const p = '${caret}' === 'end' ? el.value.length : ${caret};
          el.setSelectionRange(p, p);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true }));
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 260));
      };
      await listKey(0, "Enter", 2);
      check("字幕列表中间回车拆成两条", Number(await listCount()) === 4, String(await listTexts()));
      await listKey(1, "Backspace", 0);
      check("字幕列表开头 Backspace 合并上一条", Number(await listCount()) === 3, String(await listTexts()));
      await listKey(0, "Delete", "end");
      check("字幕列表末尾 Delete 合并下一条", Number(await listCount()) === 2, String(await listTexts()));

      // 从开头起播：前面的 Shift+→ 把播放头留在末尾，而末尾帧按严格小于 endMs 不属于任何一句
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 180));
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); return true; })()`);
      await new Promise((r) => setTimeout(r, 520));
      const activeRows = Number(await evalJs(ws, "document.querySelectorAll('.jeek-sub-card.jeek-sub-active').length")) || 0;
      const playAt = String(await evalJs(ws, "document.querySelector('.jeek-tl-time')?.textContent ?? ''"));
      check("播放时字幕列表当前句高亮", activeRows === 1, `高亮 ${activeRows} 条 · 播放头 ${playAt}`);
      await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); return true; })()`);

      fs.mkdirSync(PROBE_DIR, { recursive: true });
      const shot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
      const shotPath = path.join(PROBE_DIR, "editor-ui.png");
      fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
      check("界面截图已生成", fs.statSync(shotPath).size > 10000, shotPath);
    }
  }
} catch (e) {
  check("探针执行无异常", false, e.message ?? String(e));
} finally {
  if (electron) {
    electron.kill();
    await new Promise((r) => setTimeout(r, 400));
    if (electron.exitCode === null) electron.kill("SIGKILL");
  }
  launch.kill();
  await new Promise((r) => setTimeout(r, 600));
  if (launch.exitCode === null) launch.kill("SIGKILL");
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`探针结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  exitCode = 1;
  console.error("启动日志尾部：\n" + output.slice(-1500));
  if (electronOutput) console.error("桌面进程尾部：\n" + electronOutput.slice(-1500));
}
process.exit(exitCode);
