import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync,
  createReadStream, createWriteStream, statSync, readdirSync, statfsSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frameRenderProvider, validateRenderRequest } from "@jeek/engine";
import { cpuEncoderOf, gpuEncoderOf, gpuUnsupportedMessage, normalizeExportConfig } from "@jeek/core";

/**
 * 渲染服务：版本化 HTTP 契约（/api/v1/...）。
 * 只监听 127.0.0.1，重任务与界面进程隔离；将来换渲染后端不动这层契约。
 */
const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// 打包态由桌面壳统一算好路径并通过环境变量喂进来；开发态按工作区布局兜底。
const FFMPEG = process.env.JEEK_FFMPEG_BIN ?? join(ROOT, "resources", "bin", "ffmpeg.exe");
const ASR_EXE = process.env.JEEK_ASR_EXE ?? join(ROOT, "resources", "asr", "llama-funasr-sensevoice.exe");
const ASR_MODEL = process.env.JEEK_ASR_MODEL ?? join(ROOT, "resources", "asr", "models", "sensevoice-small-q8.gguf");
const VAD_MODEL = process.env.JEEK_VAD_MODEL ?? join(ROOT, "resources", "asr", "models", "fsmn-vad.gguf");
const MAX_UPLOAD = 512 * 1024 * 1024;

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 8 * 1024 * 1024) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });

const readBinary = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        reject(new Error("上传内容超过 512 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/** 可用磁盘字节数；取不到时返回 -1（按未知处理，不阻断导出） */
function freeBytesOf(dir) {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return -1;
  }
}

/** 选一个足够放下本次临时帧的工作目录。
 *  逐帧导出会把所有帧先落盘（MOV 用 PNG，1080p 每帧约 1MB，长视频能到十几 GB），
 *  系统临时目录默认在 C 盘（容量最小），实测曾把系统盘写满导致 ffmpeg 报 ENOSPC（退出码 -28）。
 *  规则：优先用调用方指定的目录（通常与成品同盘），其次按候选盘剩余空间从大到小挑。 */
function pickWorkRoot(hintDir, neededBytes) {
  const candidates = [];
  if (typeof hintDir === "string" && hintDir.trim()) candidates.push(hintDir.trim());
  candidates.push(tmpdir());
  if (process.platform === "win32") {
    // 盘符探测：跳过软驱 A/B
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      try {
        if (existsSync(root)) candidates.push(root);
      } catch { /* 不可访问的盘符 */ }
    }
  }
  let best = null;
  for (const dir of candidates) {
    const free = freeBytesOf(dir);
    if (free < 0) continue;
    if (!best || free > best.free) best = { dir, free };
    if (neededBytes && free >= neededBytes) return { dir, free, enough: true };
  }
  return best ? { ...best, enough: !neededBytes || best.free >= neededBytes } : { dir: tmpdir(), free: -1, enough: true };
}

/** 把字节数变成人看得懂的大小 */
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "未知";
  const gb = n / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024 / 1024)} MB`;
}

/** 流式 multipart 解析：边收边把每个 part 的字节交给 openPart 返回的写入器，全程不在内存里囤整个请求体。
 *  逐帧导出的请求体可达数 GB（长视频几千帧 PNG），整包读进内存既会撞 Node Buffer 的 2 GiB 上限，
 *  也会把内存吃干净。openPart(name, filename) 返回 { write(data), end() }，返回 null 表示丢弃该 part。 */
async function readMultipartStream(req, contentType, openPart) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("缺少 multipart boundary");
  const marker = Buffer.from(`--${m[1] || m[2]}`, "utf8");
  const delim = Buffer.concat([Buffer.from("\r\n"), marker]);

  let buf = Buffer.alloc(0);
  let state = "preamble";
  let sink = null;

  const step = async () => {
    for (;;) {
      if (state === "preamble") {
        const i = buf.indexOf(marker);
        if (i < 0) {
          if (buf.length > marker.length) buf = buf.subarray(buf.length - marker.length);
          return;
        }
        buf = buf.subarray(i + marker.length);
        state = "after-boundary";
        continue;
      }
      if (state === "after-boundary") {
        if (buf.length < 2) return;
        if (buf[0] === 0x2d && buf[1] === 0x2d) { state = "done"; return; }
        if (buf[0] === 0x0d && buf[1] === 0x0a) buf = buf.subarray(2);
        state = "headers";
        continue;
      }
      if (state === "headers") {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 4);
        const cd = /content-disposition:([^\r\n]*)/i.exec(head);
        const nameM = cd && /name="([^"]*)"/i.exec(cd[1]);
        const fileM = cd && /filename="([^"]*)"/i.exec(cd[1]);
        sink = openPart(nameM ? nameM[1] : "", fileM ? fileM[1] : "");
        state = "body";
        continue;
      }
      if (state === "body") {
        const i = buf.indexOf(delim);
        if (i < 0) {
          // 末尾可能正卡着半个边界，先留下 delim.length - 1 字节
          const keep = Math.max(0, buf.length - (delim.length - 1));
          if (keep > 0) {
            const data = buf.subarray(0, keep);
            buf = buf.subarray(keep);
            if (sink && data.length) await sink.write(data);
          }
          return;
        }
        const data = buf.subarray(0, i);
        buf = buf.subarray(i + delim.length);
        if (sink) {
          if (data.length) await sink.write(data);
          await sink.end();
          sink = null;
        }
        state = "after-boundary";
        continue;
      }
      return;
    }
  };

  for await (const chunk of req) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    await step();
    if (state === "done") break;
  }
  if (state !== "done") await step();
  if (sink) await sink.end();
  return state === "done";
}

/** 落盘写入器：带背压，不会把整个 part 读进内存 */
function fileSink(target) {
  const out = createWriteStream(target, { highWaterMark: 1024 * 1024 });
  const ready = new Promise((resolve, reject) => {
    out.once("open", resolve);
    out.once("error", reject);
  });
  return {
    ready,
    async write(data) {
      await ready;
      if (!out.write(data)) await new Promise((r) => out.once("drain", r));
    },
    async end() {
      await ready;
      await new Promise((resolve, reject) => {
        out.once("error", reject);
        out.end(resolve);
      });
    },
  };
}

const stampToMs = (value) => {
  const m = value.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return 0;
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, "0"));
};

/** 解析识别引擎的 --srt 输出；日志行与情绪/语种标签不算字幕 */
function parseSrtOutput(stdout) {
  const segments = [];
  for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [from, to] = timeLine.split("-->");
    const text = lines
      .filter((l) => l !== timeLine && l && !/^\d+$/.test(l) && !l.startsWith("[sensevoice]"))
      .join(" ")
      .replace(/<\|[^|]*\|>/g, "")
      .trim();
    if (!text) continue;
    segments.push({ startMs: stampToMs(from), endMs: stampToMs(to), text });
  }
  return { text: segments.map((s) => s.text).join(""), segments };
}

const withTemp = async (files, work) => {
  const dir = mkdtempSync(join(tmpdir(), "jeek-service-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return await work(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响本次结果
    }
  }
};

/** ffmpeg 是否编进了某个编码器；结果缓存，避免每次导出都跑一遍 -encoders */
const encoderCache = new Map();
const ffmpegEncoders = () => {
  if (encoderCache.has("__list__")) return encoderCache.get("__list__");
  let list = "";
  try {
    list = execFileSync(FFMPEG, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
  } catch {
    list = "";
  }
  encoderCache.set("__list__", list);
  return list;
};

const hasEncoder = (name) => {
  if (encoderCache.has(name)) return encoderCache.get(name);
  const ok = new RegExp(`\\b${name}\\b`).test(ffmpegEncoders());
  encoderCache.set(name, ok);
  return ok;
};

/** 显卡信息只用于识别窗口展示；拿不到也不影响识别本身（照旧版 asr-run.js 的 detectGpu） */
const detectGpu = () =>
  new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader"],
      { windowsHide: true, timeout: 3000 },
      (err, out) => {
        if (err || !out || !out.trim()) return resolve(null);
        const first = (out.trim().split(/\r?\n/)[0] || "");
        const [name, mem] = first.split(",").map((s) => (s || "").trim());
        if (!name) return resolve(null);
        resolve({ name, memory: mem || "" });
      },
    );
  });

export function startRenderService({ port = 0 } = {}) {
  const progress = new Map();
  const asrJobs = new Map();
  /** 导出任务：提交帧后立即返回 jobId，ffmpeg 后台编码并持续上报已编码帧数 */
  const renderJobs = new Map();
  /** 正在接收上传、还没进任务表的临时目录。没有它的话，另一次导出的清扫会误删正在写的帧。 */
  const pendingRenderDirs = new Set();
  const reapRenderJobs = () => {
    const now = Date.now();
    for (const [id, job] of renderJobs) {
      if (now - job.updatedAt < 10 * 60 * 1000) continue;
      if (job.dir) {
        try { rmSync(job.dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
      }
      renderJobs.delete(id);
    }
  };

  /* 进程异常退出（崩溃、被强杀、断电）时内存里的任务表就没了，残留的帧目录再没人认领，
     长视频一次就是十几 GB。启动时扫一遍各候选盘的临时目录，把超过 2 小时的旧残留清掉。 */
  /** 删掉某个目录下没人认领的 jeek-render-* 残留帧目录。
   *  「没人认领」＝ 不在当前任务表里，或已经超过 2 小时（进程崩溃留下的）。 */
  const sweepRenderDirsIn = (root) => {
    let entries = [];
    try { entries = readdirSync(root); } catch { return 0; }
    const active = new Set(
      [...renderJobs.values()].map((j) => j.dir).filter(Boolean).map((d) => resolve(d)),
    );
    for (const d of pendingRenderDirs) active.add(resolve(d));
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith("jeek-render-")) continue;
      const full = join(root, name);
      try {
        const st = statSync(full);
        if (!st.isDirectory()) continue;
        const stale = Date.now() - st.mtimeMs > 2 * 60 * 60 * 1000;
        if (active.has(resolve(full)) && !stale) continue;
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* 单个目录失败不影响其它 */ }
    }
    return removed;
  };

  const sweepStaleRenderDirs = () => {
    const roots = new Set([tmpdir()]);
    if (process.platform === "win32") {
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        try { if (existsSync(`${letter}:\\`)) roots.add(`${letter}:\\`); } catch { /* 忽略 */ }
      }
    }
    let removed = 0;
    for (const root of roots) removed += sweepRenderDirsIn(root);
    if (removed > 0) console.error(`[render] 已清理 ${removed} 个残留临时帧目录`);
    return removed;
  };

  const server = createServer(async (req, res) => {
    // 界面跑在 5173、服务在 5174，属于跨源调用；只放行本机来源
    const origin = req.headers.origin;
    if (typeof origin === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Expose-Headers", "X-Jeek-Hardware-Encoded");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;

    if (pathname === "/api/v1/health" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        provider: frameRenderProvider.id,
        capabilities: frameRenderProvider.capabilities,
        services: {
          asr: existsSync(ASR_EXE) && existsSync(ASR_MODEL),
          ffmpeg: existsSync(FFMPEG),
          transcode: existsSync(FFMPEG),
        },
      });
      return;
    }

    /* 语音转字幕配置预检：显卡 / 识别资源就绪 / 后端可用性（照旧版 asrConfig） */
    if (pathname === "/api/v1/asr/config" && req.method === "GET") {
      const gpu = await detectGpu();
      const missing = [];
      if (!existsSync(ASR_EXE)) missing.push("asr/llama-funasr-sensevoice.exe");
      if (!existsSync(ASR_MODEL)) missing.push("asr/models/sensevoice-small-q8.gguf");
      if (!existsSync(VAD_MODEL)) missing.push("asr/models/fsmn-vad.gguf");
      if (!existsSync(FFMPEG)) missing.push("ffmpeg.exe");
      const engineReady = existsSync(ASR_EXE);
      json(res, 200, {
        ok: true,
        gpu,
        status: {
          ok: missing.length === 0,
          missing,
          defaultBackend: "vulkan",
          backends: [
            {
              id: "vulkan",
              label: "显卡加速 · Vulkan",
              desc: "调用显卡做推理，通常明显快于 CPU（首次运行需要预热，显卡驱动过旧或不支持 Vulkan 时请改用 CPU）",
              available: engineReady,
              recommended: true,
            },
            {
              id: "cpu",
              label: "CPU 通用",
              desc: "不依赖显卡，兼容性最好，速度较慢",
              available: true,
              recommended: false,
            },
          ],
        },
      });
      return;
    }

    if (pathname === "/api/v1/render" && req.method === "POST") {
      let request;
      try {
        request = await readBody(req);
      } catch (error) {
        json(res, 400, { ok: false, error: String(error.message ?? error) });
        return;
      }
      const invalid = validateRenderRequest(request);
      if (invalid) {
        json(res, 422, { ok: false, error: invalid });
        return;
      }
      const result = await frameRenderProvider.renderRange(request, (p) => {
        progress.set(p.requestId, p);
      });
      json(res, result.ok ? 200 : 500, { ok: result.ok, result });
      return;
    }

    if (pathname.startsWith("/api/v1/render/") && pathname.endsWith("/progress")) {
      const requestId = pathname.split("/")[4];
      json(res, 200, { ok: true, progress: progress.get(requestId) ?? null });
      return;
    }

    /* 语音转字幕：接收时间轴重建后的音频，异步识别并逐段回传进度 */
    if (pathname === "/api/v1/asr" && req.method === "POST") {
      if (!existsSync(ASR_EXE) || !existsSync(ASR_MODEL) || !existsSync(FFMPEG)) {
        json(res, 503, { ok: false, error: "识别引擎或模型未安装，请先运行安装依赖" });
        return;
      }
      let input;
      try {
        input = await readBinary(req);
      } catch (error) {
        json(res, 413, { ok: false, error: String(error.message ?? error) });
        return;
      }
      if (!input.length) {
        json(res, 400, { ok: false, error: "音频内容为空" });
        return;
      }
      const backend = url.searchParams.get("backend") === "cpu" ? "cpu" : "vulkan";
      const rawSeg = Number(url.searchParams.get("vadMaxSeg") ?? 8000);
      const vadMaxSeg = Math.max(1000, Math.min(30000, Number.isFinite(rawSeg) ? rawSeg : 8000));
      const jobId = `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (asrJobs.size > 20) {
        const oldest = asrJobs.keys().next().value;
        if (oldest) asrJobs.delete(oldest);
      }
      asrJobs.set(jobId, {
        stage: "extract",
        percent: 2,
        detail: "准备抽取音频…",
        segDone: 0,
        segTotal: 0,
        gpuName: "",
        logs: [],
        history: [],
        done: false,
        backend,
        vadMaxSeg,
      });
      json(res, 202, { ok: true, jobId, backend, vadMaxSeg });

      void (async () => {
        const job = asrJobs.get(jobId);
        const push = (stage, percent, detail, extra = {}) => {
          if (job.stage !== stage) job.history.push(stage);
          job.stage = stage;
          job.percent = percent;
          job.detail = detail;
          Object.assign(job, extra);
        };
        try {
          await withTemp({ "input.audio": input }, async (dir) => {
            const wavPath = join(dir, "asr-16k.wav");
            push("extract", 4, "正在抽取音频轨（16kHz 单声道）…");
            await execFileAsync(FFMPEG, [
              "-y", "-hide_banner", "-loglevel", "error", "-i", join(dir, "input.audio"),
              "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath,
            ]);
            push("model", 12, backend === "vulkan" ? "正在初始化显卡并加载模型…" : "正在加载识别模型…");

            const started = Date.now();
            const args = ["-m", ASR_MODEL, "-a", wavPath, "--backend", backend, "--srt", "--vad-maxseg", String(vadMaxSeg)];
            if (existsSync(VAD_MODEL)) args.push("--vad", VAD_MODEL);

            let stdout = "";
            let segTotal = 0;
            let segDone = 0;
            let pending = "";
            const line = (raw) => {
              const text = raw.trim();
              if (!text) return;
              job.logs.push(text);
              if (job.logs.length > 200) job.logs.shift();
              let m;
              if ((m = /initializing vulkan backend on \S+ \(([^)]+)\)/i.exec(text))) {
                job.gpuName = m[1];
                push("init", 10, `已启用显卡：${job.gpuName}`);
              } else if (/loading model metadata/i.test(text)) {
                push("model", 14, "正在加载识别模型…");
              } else if ((m = /model ready:\s*(\d+)\s+tensors/i.exec(text))) {
                push("model", 22, `模型就绪（${m[1]} 个张量）`);
              } else if (/running VAD/i.test(text)) {
                push("vad", 26, "正在检测语音片段…");
              } else if ((m = /VAD ready:\s*(\d+)\s+segments/i.exec(text))) {
                segTotal = Number(m[1]) || 0;
                push("vad", 30, `已切出 ${segTotal} 段语音`, { segTotal });
              } else if (/compute complete/i.test(text)) {
                segDone += 1;
                const pct = segTotal > 0
                  ? Math.min(88, 30 + Math.round((segDone / segTotal) * 58))
                  : Math.min(80, 30 + segDone * 8);
                push("recognize", pct, `正在识别第 ${segDone}${segTotal ? `/${segTotal}` : ""} 段…`, { segDone, segTotal });
              } else if ((m = /(\d+)\s+vad segments/i.exec(text))) {
                push("recognize", 90, `语音段识别完成（${m[1]} 段）`);
              } else if ((m = /done\s+([\d.]+)s/i.exec(text))) {
                push("recognize", 92, `引擎耗时 ${m[1]}s`);
              }
            };

            await new Promise((resolve, reject) => {
              const child = spawn(ASR_EXE, args, { windowsHide: true });
              child.stdout.on("data", (b) => {
                stdout += b.toString("utf8");
              });
              child.stderr.on("data", (b) => {
                pending += b.toString("utf8");
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || "";
                for (const l of lines) line(l);
              });
              child.on("error", reject);
              child.on("close", (code) => {
                if (pending.trim()) line(pending);
                if (code === 0) resolve();
                else reject(new Error(`识别引擎退出（code ${code}）：${String(job.logs.slice(-3).join(" ")).slice(-200)}`));
              });
            });

            push("split", 94, "正在按标点与语义断句…");
            const parsed = parseSrtOutput(stdout);
            if (!parsed.segments.length) throw new Error("这段音频里没有识别到语音，换个有声素材试试");
            job.result = {
              srt: stdout,
              segments: parsed.segments,
              stats: {
                vadSegments: segTotal,
                segments: parsed.segments.length,
                backend,
                vadMaxSeg,
                engineMs: Date.now() - started,
                gpuName: job.gpuName,
              },
            };
            job.done = true;
            push("done", 100, `识别完成，共 ${parsed.segments.length} 段语音`);
          });
        } catch (error) {
          job.done = true;
          job.stage = "error";
          job.percent = 0;
          job.error = `识别失败：${String(error?.message ?? error).slice(0, 300)}`;
          job.detail = job.error;
        }
      })();
      return;
    }

    if (pathname.startsWith("/api/v1/asr/") && pathname.endsWith("/progress")) {
      const jobId = pathname.split("/")[4];
      const job = asrJobs.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: "识别任务不存在或已过期" });
        return;
      }
      json(res, 200, { ok: true, progress: job });
      return;
    }

    /* 视频转码：浏览器直出的 WebM 转 MP4（H.264 + AAC），保留已混入的音轨 */
    if (pathname === "/api/v1/media/transcode" && req.method === "POST") {
      if (!existsSync(FFMPEG)) {
        json(res, 503, { ok: false, error: "ffmpeg 未安装，请先运行安装依赖" });
        return;
      }
      const format = url.searchParams.get("format") ?? "mp4";
      if (format !== "mp4") {
        json(res, 400, { ok: false, error: `不支持的目标格式：${format}` });
        return;
      }
      try {
        const input = await readBinary(req);
        if (!input.length) {
          json(res, 400, { ok: false, error: "视频内容为空" });
          return;
        }
        const output = await withTemp({ "input.webm": input }, async (dir) => {
          const target = join(dir, "output.mp4");
          const crfParam = url.searchParams.get("crf");
          const cfg = normalizeExportConfig({
            codec: url.searchParams.get("codec") ?? undefined,
            quality: url.searchParams.get("quality") ?? undefined,
            crf: crfParam === null || crfParam === "" ? undefined : Number(crfParam),
            accel: url.searchParams.get("accel") ?? undefined,
            concurrency: Number(url.searchParams.get("concurrency") ?? 0) || undefined,
            resolution: url.searchParams.get("resolution") ?? undefined,
            aspect: url.searchParams.get("aspect") ?? undefined,
            ratio: Number(url.searchParams.get("ratio") ?? 0) || undefined,
          });

          const gpuEnc = gpuEncoderOf(cfg.codec);
          const cpuEnc = cpuEncoderOf(cfg.codec);
          const wantsGpu = cfg.accel === "gpu" || cfg.accel === "auto";

          // 显式选显卡但本机 ffmpeg 没编进去：直接按旧版口径报错，不静默降级
          if (cfg.accel === "gpu" && !hasEncoder(gpuEnc)) {
            json(res, 422, { ok: false, error: gpuUnsupportedMessage(cfg.codec) });
            return null;
          }

          const scale = `${cfg.width}:${cfg.height}`;
          const threads = cfg.concurrency > 0 ? ["-threads", String(cfg.concurrency)] : [];
          const buildArgs = (encoder, gpu) => {
            const codecArgs = gpu
              ? ["-c:v", encoder, "-preset", cfg.gpuPreset, "-rc", "vbr", "-cq", String(cfg.cq), "-b:v", "0", "-spatial-aq", "1"]
              : ["-c:v", encoder, "-preset", cfg.cpuPreset, "-crf", String(cfg.crf)];
            return [
              "-y", "-hide_banner", "-loglevel", "error",
              "-i", join(dir, "input.webm"),
              ...codecArgs,
              ...threads,
              "-pix_fmt", "yuv420p",
              "-vf", `scale=${scale}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${scale}:(ow-iw)/2:(oh-ih)/2`,
              "-map", "0:v:0", "-map", "0:a:0?",
              "-c:a", "aac", "-b:a", "192k",
              "-movflags", "+faststart", target,
            ];
          };

          let hardwareEncoded = false;
          if (wantsGpu && hasEncoder(gpuEnc)) {
            try {
              await execFileAsync(FFMPEG, buildArgs(gpuEnc, true), { maxBuffer: 16 * 1024 * 1024, timeout: 600000 });
              hardwareEncoded = true;
            } catch (error) {
              if (cfg.accel === "gpu") throw error;
              // 自动模式：显卡这条路走不通就安静退回 CPU，成片照出
              await execFileAsync(FFMPEG, buildArgs(cpuEnc, false), { maxBuffer: 16 * 1024 * 1024, timeout: 600000 });
            }
          } else {
            await execFileAsync(FFMPEG, buildArgs(cpuEnc, false), { maxBuffer: 16 * 1024 * 1024, timeout: 600000 });
          }

          return { data: readFileSync(target), hardwareEncoded };
        });
        if (!output) return;
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": output.data.length,
          "Content-Disposition": 'attachment; filename="jeek-export.mp4"',
          "X-Jeek-Hardware-Encoded": output.hardwareEncoded ? "1" : "0",
        });
        res.end(output.data);
      } catch (error) {
        json(res, 500, { ok: false, error: `转码失败：${String(error.message ?? error).slice(0, 300)}` });
      }
      return;
    }

    /* 离线逐帧导出拆成「提交帧 → 后台编码 → 轮询进度 → 取成品」四步：
       MP4 走 NVENC 显卡编码（缺编码器时自动回退 CPU），MOV 走 ProRes 4444 透明编码；
       ffmpeg -progress 逐帧上报，界面才能把第二阶段画成真实进度条。 */
    if (pathname === "/api/v1/media/render" && req.method === "POST") {
      if (!existsSync(FFMPEG)) {
        json(res, 503, { ok: false, error: "ffmpeg 未安装，请先运行安装依赖" });
        return;
      }
      try {
        reapRenderJobs();
        const ct = req.headers["content-type"] || "";
        const uploadBytes = Number(req.headers["content-length"]) || 0;

        /* 先粗挑一块盘：至少放得下上传的帧 + 余量。客户端把成品保存目录放在 workDir 参数里，
           临时帧优先落在同一块盘上，长视频才不会撑爆系统盘临时目录。 */
        const hint = url.searchParams.get("workDir") || "";
        const rough = pickWorkRoot(hint, Math.round(uploadBytes * 1.1 + 512 * 1024 * 1024));
        if (!rough.enough) {
          json(res, 507, {
            ok: false,
            error:
              `磁盘空间不足：本次导出至少需要 ${humanBytes(uploadBytes * 1.1 + 512 * 1024 * 1024)} 临时空间，` +
              `可用磁盘最多只剩 ${humanBytes(Math.max(0, rough.free))}。请清理磁盘，或把成品保存位置换到空间更大的盘。`,
          });
          return;
        }

        // 临时帧就建在导出目录里，崩溃一次就会留在这；每次导出前顺手把这里的旧残留清掉
        sweepRenderDirsIn(rough.dir);

        const dir = mkdtempSync(join(rough.dir, "jeek-render-"));
        pendingRenderDirs.add(dir);
        let meta = {};
        let format = "mp4";
        let frameExt = "jpg";
        let frameCount = 0;
        let hasAudio = false;
        let metaDone = false;

        try {
          await readMultipartStream(req, ct, (name, filename) => {
            if (name === "meta") {
              const chunks = [];
              return {
                write: async (d) => { chunks.push(Buffer.from(d)); },
                end: async () => {
                  meta = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                  format = String(meta.format || "mp4");
                  frameExt = format === "mov" ? "png" : "jpg";
                  metaDone = true;
                },
              };
            }
            if (/^frame\d+$/.test(name)) {
              if (!metaDone) throw new Error("帧数据早于导出参数到达");
              const idx = Number(name.slice(5));
              frameCount = Math.max(frameCount, idx + 1);
              return fileSink(join(dir, `frame${String(idx).padStart(5, "0")}.${frameExt}`));
            }
            if (name === "audio") {
              hasAudio = true;
              return fileSink(join(dir, "audio.wav"));
            }
            return null;
          });
        } catch (error) {
          pendingRenderDirs.delete(dir);
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
          throw error;
        }

        if (frameCount === 0) {
          pendingRenderDirs.delete(dir);
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
          json(res, 400, { ok: false, error: "没有收到任何帧" });
          return;
        }
        if (format !== "mp4" && format !== "mov") {
          pendingRenderDirs.delete(dir);
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
          json(res, 400, { ok: false, error: `不支持的导出格式：${format}` });
          return;
        }

        /* 帧已全部落盘，再按真实帧数核一次剩余空间：编码成品还要占一份，写不下就提前报错，
           不要等 ffmpeg 跑到一半才以 ENOSPC（退出码 -28）失败。 */
        const fps = Number(meta.fps) || 30;
        const estSeconds = fps > 0 ? frameCount / fps : 0;
        const estCfg = normalizeExportConfig({
          codec: meta.codec, quality: meta.quality, crf: meta.crf,
          accel: meta.accel, concurrency: meta.concurrency,
          resolution: meta.resolution, aspect: meta.aspect,
        });
        const estScale = (estCfg.width * estCfg.height * fps) / (1920 * 1080 * 30);
        const estOutBytes = (format === "mov" ? (150 * 1e6) / 8 : (12 * 1e6) / 8) * estSeconds * estScale;
        const freeNow = freeBytesOf(rough.dir);
        const needForEncode = Math.round(estOutBytes * 1.15 + 96 * 1024 * 1024);
        if (freeNow >= 0 && freeNow < needForEncode) {
          pendingRenderDirs.delete(dir);
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
          json(res, 507, {
            ok: false,
            error:
              `磁盘空间不足：帧已生成，但编码成品还需约 ${humanBytes(estOutBytes)}，` +
              `${rough.dir} 只剩 ${humanBytes(freeNow)}。请清理磁盘后重试，或把成品保存位置换到空间更大的盘。`,
          });
          return;
        }

        const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const job = {
          id: jobId, dir, format, total: frameCount,
          encoded: 0, status: "encoding", stage: "正在准备视频编码…", error: "",
          filePath: null, size: 0, ctype: "", child: null, hardwareEncoded: false,
          purgeFrames: false, updatedAt: Date.now(),
        };
        renderJobs.set(jobId, job);
        // 已经进了任务表，后续由任务表认领，不再算「正在上传」
        pendingRenderDirs.delete(dir);
        json(res, 202, { ok: true, jobId, total: job.total });

        void (async () => {
          try {
            const cfg = normalizeExportConfig({
              codec: meta.codec, quality: meta.quality, crf: meta.crf,
              accel: meta.accel, concurrency: meta.concurrency,
              resolution: meta.resolution, aspect: meta.aspect,
            });
            const scale = `${cfg.width}:${cfg.height}`;
            const vf = `scale=${scale}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${scale}:(ow-iw)/2:(oh-ih)/2`;
            const inputs = ["-framerate", String(fps), "-i", join(dir, `frame%05d.${frameExt}`)];
            if (hasAudio) inputs.push("-i", join(dir, "audio.wav"));

            const runEncoder = (ffmpegArgs) => new Promise((resolve, reject) => {
              const child = spawn(FFMPEG, ffmpegArgs, { windowsHide: true });
              job.child = child;
              let pending = "";
              // 允许边编边删已消费的帧时，这里记一个下界，避免重复 stat/删同一批文件
              let purgeBelow = 0;
              const takeFrame = (line) => {
                const m = /^frame=\s*(\d+)/.exec(line.trim());
                if (!m) return;
                job.encoded = Math.min(job.total, Number(m[1]) || 0);
                job.stage = `正在编码视频 ${job.encoded}/${job.total} 帧`;
                job.updatedAt = Date.now();
                if (!job.purgeFrames) return;
                /* 长视频的临时帧非常占盘（1080p MOV 的 PNG 每帧约 1MB，30 分钟就是几十 GB）。
                   ffmpeg 顺序读取，编到第 N 帧时前面那些已经没用了；留 180 帧余量应对解码队列预读。 */
                const limit = job.encoded - 180;
                if (limit <= purgeBelow) return;
                for (let i = purgeBelow; i < limit; i += 1) {
                  try { rmSync(join(dir, `frame${String(i).padStart(5, "0")}.${frameExt}`), { force: true }); } catch { /* 单帧删不掉忽略 */ }
                }
                purgeBelow = limit;
              };
              child.stdout.on("data", (b) => {
                pending += b.toString("utf8");
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || "";
                for (const l of lines) takeFrame(l);
              });
              child.stderr.on("data", () => { /* 排空，避免管道写满阻塞编码 */ });
              child.on("error", reject);
              child.on("close", (code) => {
                if (pending.trim()) takeFrame(pending);
                if (job.status === "cancelled") return resolve();
                if (code !== 0) return reject(new Error(`编码进程退出（code ${code}）`));
                resolve();
              });
            });

            const head = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", ...inputs];
            const target = join(dir, `out.${format}`);
            const buildArgs = (encoderArgs, pixFmt) => [
              ...head, ...encoderArgs,
              "-vf", vf, "-map", "0:v:0",
              ...(hasAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : []),
              ...(pixFmt ? ["-pix_fmt", pixFmt] : []),
              // JPEG 源是 full-range，显式标成 limited-range，避免成品被写成 yuvj420p
              ...(format === "mp4" ? ["-color_range", "tv", "-movflags", "+faststart"] : []),
              target,
            ];
            const threads = cfg.concurrency > 0 ? ["-threads", String(cfg.concurrency)] : [];

            if (format === "mp4") {
              const gpuEnc = gpuEncoderOf(cfg.codec);
              const cpuEnc = cpuEncoderOf(cfg.codec);
              const wantsGpu = cfg.accel === "gpu" || cfg.accel === "auto";
              const gpuArgs = ["-c:v", gpuEnc, "-preset", cfg.gpuPreset, "-rc", "vbr",
                "-cq", String(cfg.cq), "-b:v", "0", "-spatial-aq", "1", ...threads];
              const cpuArgs = ["-c:v", cpuEnc, "-preset", cfg.cpuPreset, "-crf", String(cfg.crf), ...threads];
              if (wantsGpu && hasEncoder(gpuEnc)) {
                try {
                  await runEncoder(buildArgs(gpuArgs, "yuv420p"));
                  job.hardwareEncoded = true;
                } catch (gpuError) {
                  if (cfg.accel === "gpu") {
                    throw new Error(`${gpuUnsupportedMessage(cfg.codec)}：${String(gpuError.message ?? gpuError).slice(0, 160)}`);
                  }
                  // 自动档显卡不可用就安静退回 CPU，成片照出
                  job.encoded = 0;
                  await runEncoder(buildArgs(cpuArgs, "yuv420p"));
                }
              } else {
                if (cfg.accel === "gpu") throw new Error(gpuUnsupportedMessage(cfg.codec));
                await runEncoder(buildArgs(cpuArgs, "yuv420p"));
              }
              job.ctype = "video/mp4";
            } else {
              // ProRes 4444 / 4444 XQ 把 alpha 编进像素，播放器与剪辑软件都能直接识别。
              // profile 决定容器里的规格标记，qscale 决定量化强度（数值越小画质越好、文件越大），两者互不干扰；
              // 该编码器按帧并行，1080p/216 帧单线程 28.1s、16 线程 5.5s
              const movThreads = cfg.concurrency > 0 ? cfg.concurrency : Math.max(8, Math.min(16, cpus().length));
              const movProfile = meta.movSpec === "4444xq" ? "5" : "4";
              const q = Number(meta.movQscale);
              const movQuality = Number.isFinite(q) && q >= 2 && q <= 31
                ? ["-qscale:v", String(Math.round(q))] : [];
              // ProRes 没有失败重试路径，帧被读过后即可删除；MP4 的显卡失败会从头重编，不能删
              job.purgeFrames = true;
              await runEncoder(buildArgs([
                "-c:v", "prores_ks", "-profile:v", movProfile, ...movQuality,
                "-threads", String(movThreads),
              ], null));
              job.ctype = "video/quicktime";
            }
            if (job.status === "cancelled") return;
            // 成品可能超过 2 GiB：绝不能整文件读进 Buffer（Node Buffer 上限 2 GiB 会抛
            // ERR_FS_FILE_TOO_LARGE），改为记录路径，由 /result 端点从磁盘流式回传。
            // 同时删掉已用不上的帧 / 音轨文件，及时释放磁盘。
            try {
              for (const f of readdirSync(job.dir)) {
                if (/^frame\d+\.(?:jpg|png)$/i.test(f) || f === "audio.wav") {
                  try { rmSync(join(job.dir, f), { force: true }); } catch { /* 忽略单文件 */ }
                }
              }
            } catch { /* 清理失败不影响成品 */ }
            const st = statSync(target);
            job.filePath = target;
            job.size = st.size;
            job.encoded = job.total;
            job.status = "done";
            job.stage = "编码完成";
          } catch (error) {
            if (job.status !== "cancelled") {
              job.status = "error";
              const raw = String(error?.message ?? error);
              // ffmpeg 在 Windows 上把 errno 直接当退出码回传：-28 / 4294967268 都是 ENOSPC（磁盘写满）
              const enospc = /code\s+(-28|4294967268)\b/.test(raw) || /ENOSPC|No space left/i.test(raw);
              job.error = enospc
                ? `视频编码失败：磁盘空间不足（临时帧与成品的写入盘已满）。请清理磁盘后重试，或把成品保存位置换到空间更大的盘。`
                : `视频编码失败：${raw.slice(0, 400)}`;
              job.stage = job.error;
              // 失败后帧文件已无用，立刻删掉，避免残帧长期占着磁盘（长视频一次就是十几 GB）
              try { if (job.dir) rmSync(job.dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
              job.dir = null;
              job.filePath = null;
            }
          } finally {
            job.child = null;
            job.updatedAt = Date.now();
          }
        })();
      } catch (error) {
        json(res, 500, { ok: false, error: `视频导出失败：${String(error.message ?? error).slice(0, 400)}` });
      }
      return;
    }

    if (pathname === "/api/v1/media/render/progress" && req.method === "GET") {
      const job = renderJobs.get(url.searchParams.get("jobId") || "");
      if (!job) {
        json(res, 404, { ok: false, error: "导出任务不存在或已过期" });
        return;
      }
      json(res, 200, {
        ok: true,
        status: job.status,
        stage: job.stage,
        encoded: job.encoded,
        total: job.total,
        percent: job.total > 0 ? Math.min(100, Math.round((job.encoded / job.total) * 100)) : 0,
        error: job.error,
        size: job.size || 0,
      });
      return;
    }

    if (pathname === "/api/v1/media/render/result" && req.method === "GET") {
      const job = renderJobs.get(url.searchParams.get("jobId") || "");
      if (!job) {
        json(res, 404, { ok: false, error: "导出任务不存在或已过期" });
        return;
      }
      if (job.status === "error") {
        json(res, 500, { ok: false, error: job.error });
        return;
      }
      if (job.status !== "done" || !job.filePath || !existsSync(job.filePath)) {
        json(res, 202, { ok: false, error: "成品尚未生成" });
        return;
      }
      // 成品可能大于 2 GiB：用文件流从磁盘直接回传，绝不整文件读进内存（Node Buffer 上限 2 GiB 会抛 ERR_FS_FILE_TOO_LARGE）。
      job.updatedAt = Date.now();
      const size = statSync(job.filePath).size;
      // 注意：此处绝不能加 Content-Disposition: attachment —— Electron 渲染进程里的 fetch
      // 收到带 attachment 的响应会被下载机制接管，导致 fetch 的 body 流被取消、连接提前断开，
      // 表现为前端抛 Failed to fetch、成品取不回来。前端落盘用的是自己的文件名（downloadBlob / 桌面桥），
      // 不需要响应头提供文件名。
      // 不设置 Content-Length、改用分块传输（Node 自动加 Transfer-Encoding: chunked）：
      // Chromium 的 fetch 在拉取带固定 Content-Length 的大响应体时，到约 12MB 会异常断开连接；
      // 分块传输由结束标记判定收尾，规避该问题，且对超过 2 GiB 的成品同样安全。
      res.writeHead(200, {
        "Content-Type": job.ctype,
        "X-Jeek-Hardware-Encoded": job.hardwareEncoded ? "1" : "0",
      });
      const stream = createReadStream(job.filePath);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { if (job.dir) rmSync(job.dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
        job.dir = null;
        job.filePath = null;
        renderJobs.delete(job.id);
      };
      // 客户端（Electron 渲染进程）可能在取流中途断开（如用户取消），清理已用不上的临时目录即可。
      stream.on("error", () => { try { res.destroy(); } catch { /* 客户端已断开 */ } cleanup(); });
      stream.on("close", cleanup);
      stream.pipe(res);
      return;
    }

    if (pathname === "/api/v1/media/render/cancel" && req.method === "POST") {
      const job = renderJobs.get(url.searchParams.get("jobId") || "");
      if (job) {
        job.status = "cancelled";
        job.stage = "已取消";
        try { job.child?.kill(); } catch { /* 进程已结束 */ }
        try { if (job.dir) rmSync(job.dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
        job.dir = null;
        job.filePath = null;
        renderJobs.delete(job.id);
      }
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { ok: false, error: "未知接口" });
  });

  return new Promise((resolve) => {
    // 服务一起来就先扫掉上次异常退出留下的临时帧目录，避免它们在磁盘上越积越多
    try { sweepStaleRenderDirs(); } catch { /* 清扫失败不影响服务启动 */ }
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const service = await startRenderService({
    port: Number(process.env.JEEK_RENDER_PORT ?? 5174),
  });
  console.log(`[render-service] ${service.url} · provider=${frameRenderProvider.id}`);
}
