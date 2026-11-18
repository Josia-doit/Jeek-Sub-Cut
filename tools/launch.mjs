#!/usr/bin/env node
/**
 * 一键启动：把渲染服务、编辑器、桌面窗口串成一条可运行的程序。
 *
 *   node tools/launch.mjs                 正常启动（有 Electron 就开窗口，否则开浏览器）
 *   node tools/launch.mjs --browser      强制用浏览器打开
 *   node tools/launch.mjs --dev          编辑器走 Vite 热更新（改源码即时生效）
 *   node tools/launch.mjs --check        只检查安装状态，不启动
 *   node tools/launch.mjs --no-render    不启动渲染服务（只看界面）
 *   node tools/launch.mjs --no-open      只启动服务，不打开窗口或浏览器（自动化验证）
 *   node tools/launch.mjs --port 5180    改编辑器端口
 *
 * 所有子进程由本脚本托管，Ctrl+C 或关闭桌面窗口时一起收干净。
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 内置 node 优先：把当前 node 目录顶到 PATH 最前，保证派生的渲染服务 / vite
// 及其内部脚本解析到的都是同一个 node，不依赖系统里是否装过 Node.js。
{
  const here = path.dirname(process.execPath);
  const sep = path.delimiter;
  const parts = (process.env.PATH ?? "").split(sep).filter(Boolean);
  process.env.PATH = [here, ...parts.filter((p) => path.resolve(p) !== path.resolve(here))].join(sep);
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const CHECK = has("--check");
const BROWSER = has("--browser");
const DEV = has("--dev");
const NO_RENDER = has("--no-render");
const NO_OPEN = has("--no-open");
const EDITOR_PORT = Number(valueOf("--port") ?? process.env.JEEK_EDITOR_PORT ?? 5173);
const RENDER_PORT = Number(valueOf("--render-port") ?? process.env.JEEK_RENDER_PORT ?? 5174);

const EDITOR_DIR = path.join(ROOT, "apps", "editor");
const EDITOR_DIST = path.join(EDITOR_DIR, "dist");
const VITE_BIN = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const STATE_FILE = path.join(ROOT, "resources", "install-state.json");
const ELECTRON_EXE = path.join(ROOT, "resources", "runtime", "electron", "electron.exe");
const RENDER_URL = `http://127.0.0.1:${RENDER_PORT}`;
const EDITOR_URL = `http://127.0.0.1:${EDITOR_PORT}`;

const log = (m = "") => console.log(m);
const ok = (m) => log("  √ " + m);
const warn = (m) => log("  ! " + m);

function preflight() {
  const issues = [];
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
    issues.push("缺少 node_modules —— 请先运行 安装依赖.bat");
  }
  if (DEV) {
    if (!fs.existsSync(VITE_BIN)) issues.push("缺少 Vite —— 请先运行 安装依赖.bat");
  } else if (!fs.existsSync(path.join(EDITOR_DIST, "index.html"))) {
    issues.push("缺少 apps/editor/dist —— 请先运行 安装依赖.bat，或加 --dev 走热更新");
  }
  return {
    issues,
    electron: fs.existsSync(ELECTRON_EXE),
    dist: fs.existsSync(path.join(EDITOR_DIST, "index.html")),
    state: fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
      : null,
  };
}

function printStatus(p) {
  log("JeekSubCut 启动检查");
  log(`目录：${ROOT}`);
  log(`  node_modules      ${fs.existsSync(path.join(ROOT, "node_modules")) ? "已安装" : "缺失"}`);
  log(`  编辑器构建产物    ${p.dist ? "已生成" : "缺失"}`);
  log(`  Electron 运行时   ${p.electron ? "已就绪（桌面窗口）" : "未安装（将用浏览器）"}`);
  log(`  安装状态文件      ${p.state ? p.state.installedAt : "无"}`);
  if (p.state) {
    for (const [id, s] of Object.entries(p.state.components ?? {})) {
      log(`    ${id.padEnd(13)} ${s.status}`);
    }
  }
  for (const issue of p.issues) warn(issue);
}

const children = [];
let staticServer = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* 已退出 */
    }
  }
  if (staticServer) void staticServer.close();
  // 启动早期失败时既没有子进程也没有监听端口，事件循环本来就是空的；
  // 定时器必须保持引用，否则 Node 会以默认退出码 0 直接结束，
  // 启动脚本判定成成功，既不提示错误也不停住窗口。
  setTimeout(() => process.exit(code), 250);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  children.push(child);
  return child;
}

async function waitUrl(url, timeoutMs = 20000, label = "服务") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} 在 ${timeoutMs / 1000}s 内未就绪：${url}`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** 编辑器静态服务：不依赖 Vite，构建产物直接可跑 */
function startStatic(port) {
  const fontsRoot = path.join(ROOT, "fonts");
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // 字体目录：界面按 /fonts/<文件名> 取字体文件（与 Vite 开发模式同一条路由）
    if (pathname.startsWith("/fonts/")) {
      const file = path.resolve(fontsRoot, pathname.slice("/fonts/".length));
      if (!file.startsWith(fontsRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(fs.readFileSync(file));
      return;
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(EDITOR_DIST, rel);
    if (!file.startsWith(EDITOR_DIST + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const target = fs.existsSync(file) && fs.statSync(file).isFile()
      ? file
      : path.join(EDITOR_DIST, "index.html"); // SPA 回退
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(target));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function openInBrowser(url) {
  if (process.platform === "win32") {
    const c = spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    c.unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

function openInElectron(url) {
  const appPath = path.join(ROOT, "apps", "desktop");
  const child = spawnChild(ELECTRON_EXE, [appPath], {
    env: {
      ...process.env,
      JEEK_EDITOR_URL: url,
      JEEK_RENDER_URL: RENDER_URL,
      JEEK_RENDER_PORT: String(RENDER_PORT),
    },
  });
  child.on("exit", () => shutdown(0));
  return child;
}

async function main() {
  const p = preflight();
  if (CHECK) {
    printStatus(p);
    if (p.issues.length) process.exitCode = 1;
    return;
  }

  log("JeekSubCut 启动");
  log(`目录：${ROOT}`);
  if (p.issues.length) {
    for (const issue of p.issues) warn(issue);
    throw new Error("环境未就绪：首次使用请先双击「安装依赖.bat」，装好后再运行「启动.bat」");
  }

  // 1) 渲染服务（独立进程，重任务不卡界面）
  if (NO_RENDER) {
    warn("按 --no-render 跳过渲染服务，界面里的渲染按钮会提示服务未启动");
  } else {
    spawnChild(process.execPath, [path.join(ROOT, "apps", "render-service", "src", "server.mjs")], {
      env: { ...process.env, JEEK_RENDER_PORT: String(RENDER_PORT) },
    });
    await waitUrl(`${RENDER_URL}/api/v1/health`, 20000, "渲染服务");
    ok(`渲染服务 ${RENDER_URL}/api/v1/health`);
  }

  // 2) 编辑器：默认静态产物，--dev 走 Vite 热更新
  if (DEV) {
    spawnChild(
      process.execPath,
      [VITE_BIN, "--host", "127.0.0.1", "--port", String(EDITOR_PORT), "--strictPort"],
      {
        cwd: EDITOR_DIR,
        env: { ...process.env, VITE_RENDER_URL: RENDER_URL },
      },
    );
    await waitUrl(EDITOR_URL, 25000, "Vite 开发服务器");
    ok(`编辑器（热更新） ${EDITOR_URL}`);
  } else {
    staticServer = await startStatic(EDITOR_PORT);
    ok(`编辑器（构建产物） ${EDITOR_URL}`);
  }

  // 3) 窗口：Electron 就绪就开桌面窗口，否则退回浏览器
  if (NO_OPEN) {
    ok("按 --no-open 只启动服务，未打开窗口");
  } else if (!BROWSER && p.electron) {
    openInElectron(EDITOR_URL);
    ok("桌面窗口已启动；关闭窗口即结束全部服务");
  } else {
    if (!p.electron) warn("未检测到 Electron 运行时，已改用浏览器（重跑 安装依赖.bat 可补齐）");
    else ok("按 --browser 使用浏览器");
    openInBrowser(EDITOR_URL);
    ok(`已打开浏览器 ${EDITOR_URL}`);
  }

  log("");
  log("服务运行中，按 Ctrl+C 结束。");
}

main().catch((e) => {
  console.error("  × " + (e.message ?? String(e)));
  process.exitCode = 1;
  shutdown(1);
});
