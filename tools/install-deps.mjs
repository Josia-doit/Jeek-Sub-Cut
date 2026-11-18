#!/usr/bin/env node
/**
 * 依赖自动安装：把「一份纯净源码」变成「一个能双击启动的程序」。
 *
 * 做四件事：
 *   1. npm ci            按 package-lock.json 装 npm 依赖（结果与本机开发目录一致）
 *   2. npm run build     编译各层包 + 构建编辑器
 *   3. npm test          架构边界 + 契约/闭环测试
 *   4. 按 install/deps.json 下载并解包运行时、二进制与模型到 resources/
 *
 * 零第三方依赖：只用 Node 内置模块 + Windows 自带的 tar.exe。
 * 断点续传、sha256 校验、多镜像回退、已装跳过；下载缓存不进仓库。
 *
 * 用法：
 *   node tools/install-deps.mjs                     完整安装
 *   node tools/install-deps.mjs --check            只探测下载地址是否可达
 *   node tools/install-deps.mjs --only electron    只装某个组件（隐含跳过 npm 步骤）
 *   node tools/install-deps.mjs --force            强制重新下载
 *   node tools/install-deps.mjs --no-test          跳过 npm test
 *   node tools/install-deps.mjs --skip-download    只做 npm 步骤，不下载二进制
 *   node tools/install-deps.mjs --asset-source DIR 从已有安装目录复制 resources/（离线复用）
 *   node tools/install-deps.mjs --cache DIR        指定下载缓存目录（默认 install/.cache）
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPS_FILE = path.join(ROOT, "install", "deps.json");
const LOCAL_DIR = path.join(ROOT, "install", "local");
const RESOURCES = path.join(ROOT, "resources");
const STATE_FILE = path.join(RESOURCES, "install-state.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const CHECK = has("--check");
const FORCE = has("--force");
const NO_TEST = has("--no-test");
const SKIP_DOWNLOAD = has("--skip-download");
const ONLY = (() => {
  const v = valueOf("--only");
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
})();
const ASSET_SOURCE = valueOf("--asset-source");
const CACHE = path.resolve(ROOT, valueOf("--cache") ?? path.join("install", ".cache"));
const SKIP_NPM = has("--skip-npm") || CHECK || Boolean(ONLY);

const MB = 1024 * 1024;
const fmtMB = (n) => (n / MB).toFixed(1) + " MB";
const log = (m = "") => console.log(m);
const step = (n, total, m) => log(`\n[${n}/${total}] ${m}`);
const ok = (m) => log("  √ " + m);
const warn = (m) => log("  ! " + m);
const fail = (m) => console.error("  × " + m);

const deps = JSON.parse(fs.readFileSync(DEPS_FILE, "utf8"));
const components = deps.components.filter((c) => !ONLY || ONLY.includes(c.id));

// ---------------------------------------------------------------- 网络
function request(url, { method = "GET", headers = {}, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("地址无效：" + url));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method, headers: { "User-Agent": "JeekSubCut-Installer/1.0", ...headers } },
      (res) => {
        const code = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && hops < 8) {
          res.resume();
          request(new URL(res.headers.location, u).toString(), { method, headers, hops: hops + 1 }).then(
            resolve,
            reject,
          );
          return;
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("连接超时")));
    req.end();
  });
}

async function probe(url) {
  try {
    const res = await request(url, { method: "HEAD" });
    const size = Number(res.headers["content-length"] ?? 0);
    res.resume();
    return { ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, size };
  } catch (e) {
    return { ok: false, status: 0, size: 0, error: e.message };
  }
}

function progress(done, total, speed) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const cells = 22;
  const filled = Math.round((pct / 100) * cells);
  process.stdout.write(
    "\r    [" +
      "█".repeat(filled) +
      "░".repeat(cells - filled) +
      "] " +
      pct.toFixed(0).padStart(3) +
      "%  " +
      fmtMB(done) +
      (total ? " / " + fmtMB(total) : "") +
      (speed ? "  " + speed.toFixed(1) + " MB/s" : "") +
      "   ",
  );
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    stream.on("data", (c) => h.update(c));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}

/** 多地址回退 + 断点续传 + 可选 sha256 校验；已有且校验通过的文件直接复用 */
async function download(urls, dest, sha256) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    if (!sha256 || (await sha256File(dest)) === sha256) return { source: "cache", size: fs.statSync(dest).size };
    fs.rmSync(dest, { force: true });
  }
  let lastError;
  for (const url of urls) {
    try {
      const target = new URL(url);
      log(`    下载 ${target.host}/${target.pathname.replace(/^\//, "").slice(-46)}`);
      const part = dest + ".part";
      let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      const res = await request(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      const code = res.statusCode ?? 0;
      if (code === 416) {
        fs.renameSync(part, dest);
      } else if (code !== 200 && code !== 206) {
        res.resume();
        throw new Error(`HTTP ${code}`);
      } else {
        const resumed = code === 206;
        if (!resumed) {
          have = 0;
          fs.rmSync(part, { force: true });
        }
        const total = Number(res.headers["content-length"] ?? 0) + (resumed ? have : 0);
        let done = have;
        let last = Date.now();
        let lastDone = done;
        const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
        await new Promise((resolve, reject) => {
          res.on("data", (chunk) => {
            done += chunk.length;
            const now = Date.now();
            if (now - last > 450) {
              progress(done, total, ((done - lastDone) / MB) * (1000 / (now - last)));
              last = now;
              lastDone = done;
            }
          });
          res.on("error", reject);
          res.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
        });
        progress(done, total || done, 0);
        process.stdout.write("\n");
        fs.renameSync(part, dest);
      }
      if (sha256) {
        const actual = await sha256File(dest);
        if (actual !== sha256) {
          fs.rmSync(dest, { force: true });
          throw new Error(`校验失败（${actual.slice(0, 12)}…）`);
        }
      }
      return { source: url, size: fs.statSync(dest).size };
    } catch (e) {
      lastError = e;
      warn(`该地址失败：${e.message}，尝试下一个镜像`);
    }
  }
  throw lastError ?? new Error("没有可用下载地址");
}

// ---------------------------------------------------------------- 文件
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function copyTree(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
  return true;
}

function matches(name, keep) {
  if (!keep?.length) return true;
  return keep.some((k) =>
    k.startsWith("*.") ? name.toLowerCase().endsWith(k.slice(1).toLowerCase()) : name.toLowerCase() === k.toLowerCase(),
  );
}

// Git Bash 自带的 GNU tar 会把 "F:\..." 当成「主机:路径」远程语法，
// 所以 Windows 上必须显式用系统自带的 bsdtar。
const TAR = (() => {
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const winTar = path.join(sysRoot, "System32", "tar.exe");
  return fs.existsSync(winTar) ? winTar : "tar";
})();

function unpack(archive, into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  try {
    execFileSync(TAR, ["-xf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`解包失败：${String(e.stderr ?? e.message).slice(0, 300)}`);
  }
}

/** 把解包目录里需要的内容放到 target：整包复制 / 指定子目录 / 按文件名挑 */
function installFromExtracted(c, extracted, target) {
  fs.mkdirSync(target, { recursive: true });
  const all = walk(extracted);
  if (c.fromDir) {
    const dirs = new Set(
      all
        .filter((p) => path.basename(path.dirname(p)).toLowerCase() === c.fromDir.toLowerCase())
        .map((p) => path.dirname(p)),
    );
    if (!dirs.size) throw new Error(`解包后没找到 ${c.fromDir}/ 目录`);
    const picked = all.filter((p) => dirs.has(path.dirname(p)) && matches(path.basename(p), c.keep));
    if (!picked.length) throw new Error("解包后没找到需要的文件");
    for (const p of picked) fs.copyFileSync(p, path.join(target, path.basename(p)));
    ok(`已放置 ${picked.length} 个文件到 ${c.target}`);
    return;
  }
  if (c.keep?.length) {
    const picked = all.filter((p) => matches(path.basename(p), c.keep));
    if (!picked.length) throw new Error("解包后没找到需要的文件");
    for (const p of picked) fs.copyFileSync(p, path.join(target, path.basename(p)));
    ok(`已放置 ${picked.map((p) => path.basename(p)).join("、")}`);
    return;
  }
  const tops = fs.readdirSync(extracted, { withFileTypes: true });
  const base = tops.length === 1 && tops[0].isDirectory() ? path.join(extracted, tops[0].name) : extracted;
  copyTree(base, target);
  ok(`已放置完整运行时到 ${c.target}`);
}

function isReady(c, target) {
  if (c.archive === "none") {
    return (c.files ?? []).every((f) => {
      const p = path.join(target, f.name);
      return fs.existsSync(p) && fs.statSync(p).size > 0;
    });
  }
  if (c.verify) return fs.existsSync(path.join(target, c.verify));
  return fs.existsSync(target) && fs.readdirSync(target).length > 0;
}

function archiveExt(c) {
  if (c.archive === "zip") return ".zip";
  if (c.archive === "tar.xz") return ".tar.xz";
  return ".bin";
}

function localArchive(c) {
  const loose = path.join(LOCAL_DIR, c.id);
  if (fs.existsSync(loose) && fs.statSync(loose).isDirectory()) return { type: "dir", path: loose };
  const packed = path.join(LOCAL_DIR, c.id + archiveExt(c));
  if (fs.existsSync(packed)) return { type: "file", path: packed };
  return null;
}

// ---------------------------------------------------------------- 组件安装
async function installComponent(c, states) {
  const target = path.join(ROOT, c.target);
  if (!FORCE && isReady(c, target)) {
    ok(`${c.title} —— 已就绪，跳过`);
    states[c.id] = { status: "ok", source: "existing" };
    return;
  }
  if (SKIP_DOWNLOAD) {
    states[c.id] = { status: "missing", source: "skipped" };
    warn(`${c.title} —— 未安装（--skip-download）`);
    return;
  }

  // 1) 离线资源源：从一份已有安装的 resources/ 直接复制（不联网）
  if (ASSET_SOURCE) {
    const src = path.join(ASSET_SOURCE, c.target);
    if (fs.existsSync(src) && copyTree(src, target) && isReady(c, target)) {
      ok(`${c.title} —— 从离线资源源复制完成`);
      states[c.id] = { status: "ok", source: "asset-source" };
      return;
    }
  }

  // 2) install/local/<id>/ 或 <id>.<ext>：本机投放，完全不联网
  const local = localArchive(c);
  if (local) {
    try {
      if (c.archive === "none") {
        if (local.type === "dir") copyTree(local.path, target);
      } else if (local.type === "dir") {
        installFromExtracted(c, local.path, target);
      } else {
        const tmp = path.join(CACHE, `_local_${c.id}`);
        unpack(local.path, tmp);
        installFromExtracted(c, tmp, target);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      if (!isReady(c, target)) throw new Error("本地投放内容不完整");
      ok(`${c.title} —— 由 install/local 提供`);
      states[c.id] = { status: "ok", source: "local" };
      return;
    } catch (e) {
      warn(`本地投放不可用（${e.message}），改为联网获取`);
    }
  }

  // 3) 联网
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    if (c.archive === "none") {
      fs.mkdirSync(target, { recursive: true });
      for (const f of c.files ?? []) {
        const dest = path.join(target, f.name);
        if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
        log(`    ${f.name}（约 ${f.sizeMB} MB）`);
        const result = await download(f.urls, path.join(CACHE, c.id, f.name), f.sha256);
        fs.copyFileSync(path.join(CACHE, c.id, f.name), dest);
        ok(`${f.name} ${fmtMB(result.size)}`);
      }
      if (!isReady(c, target)) throw new Error("模型文件不完整");
    } else {
      const archive = path.join(CACHE, c.id + archiveExt(c));
      const result = await download(c.urls, archive, c.sha256);
      const tmp = path.join(CACHE, `_extract_${c.id}`);
      unpack(archive, tmp);
      installFromExtracted(c, tmp, target);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!isReady(c, target)) throw new Error("解包后缺少 " + (c.verify ?? "目标文件"));
      ok(`下载 ${fmtMB(result.size)}，校验通过`);
    }
    states[c.id] = { status: "ok", source: "download" };
  } catch (e) {
    states[c.id] = { status: "failed", error: e.message };
    if (c.required) throw new Error(`${c.title} 安装失败：${e.message}`);
    warn(`${c.title} 未装好（${e.message}）；该组件不是启动必需，可稍后重跑安装脚本`);
  }
}

// ---------------------------------------------------------------- npm 步骤
function runNpm(args, label) {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) throw new Error(`${label} 无法启动：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} 失败（退出码 ${r.status}）`);
}

// ---------------------------------------------------------------- 主流程
async function main() {
  log("JeekSubCut 依赖安装");
  log(`目录：${ROOT}`);
  log(`环境：Node ${process.version} / ${process.platform} ${process.arch}`);

  if (CHECK) {
    log("\n只探测下载地址，不安装任何内容。\n");
    const blocked = [];
    for (const c of components) {
      log(`${c.id}（约 ${c.sizeMB} MB，${c.required ? "必需" : "可选"}）`);
      const groups =
        c.archive === "none"
          ? c.files.map((f) => ({ label: f.name, urls: f.urls }))
          : [{ label: c.title, urls: c.urls }];
      for (const g of groups) {
        const probes = [];
        for (const url of g.urls) {
          const r = await probe(url);
          probes.push(r);
          log(
            `    ${r.ok ? "√" : "-"} ${new URL(url).host.padEnd(22)} HTTP ${r.status || "不通"}` +
              `${r.size ? "  " + fmtMB(r.size) : ""}`,
          );
        }
        const usable = probes.some((r) => r.ok);
        log(`  ${usable ? "√" : "×"} ${g.label}：${usable ? "至少一个镜像可用" : "全部地址不可用"}`);
        if (!usable) blocked.push(`${c.id}/${g.label}`);
      }
    }
    log(
      `\n探测完成：${
        blocked.length
          ? "以下组件无法安装 —— " + blocked.join("、")
          : "全部组件都有可用镜像（不可达的备用地址不影响安装）"
      }`,
    );
    if (blocked.length) process.exitCode = 1;
    return;
  }

  const npmState = { install: "skipped", build: "skipped", test: "skipped" };
  let phase = 0;
  const total = SKIP_NPM ? 1 : 4;
  if (!SKIP_NPM) {
    step(++phase, total, "安装 npm 依赖（npm ci，锁定版本）");
    runNpm(["ci"], "npm ci");
    npmState.install = "ok";
    ok("依赖已就位");

    step(++phase, total, "编译各层包并构建编辑器");
    runNpm(["run", "build"], "npm run build");
    npmState.build = "ok";
    ok("构建完成");

    if (NO_TEST) {
      warn("按 --no-test 跳过测试");
    } else {
      step(++phase, total, "运行回归测试（架构边界 + 契约闭环）");
      runNpm(["test"], "npm test");
      npmState.test = "ok";
      ok("测试通过");
    }
  } else {
    log("\n（按参数跳过 npm 步骤）");
  }

  step(++phase, total, `检查运行时 / 二进制 / 模型（${components.length} 项）`);
  fs.mkdirSync(RESOURCES, { recursive: true });
  const states = {};
  for (const c of components) {
    log(`\n  ▶ ${c.title}`);
    await installComponent(c, states);
  }

  const state = {
    schema: deps.schema,
    appVersion: deps.appVersion,
    installedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    root: ROOT,
    npm: npmState,
    components: states,
    editorDist: fs.existsSync(path.join(ROOT, "apps", "editor", "dist", "index.html")),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  const missing = Object.entries(states)
    .filter(([, s]) => s.status !== "ok")
    .map(([id]) => id);
  log("\n────────────────────────────────");
  log(`安装完成。状态文件：resources/install-state.json`);
  if (missing.length) log(`未就绪组件：${missing.join("、")}（可选组件可稍后重跑安装脚本补齐）`);
  log("下一步：运行 启动.bat（或 npm start）");
}

main().catch((e) => {
  fail(e.message ?? String(e));
  process.exitCode = 1;
});
