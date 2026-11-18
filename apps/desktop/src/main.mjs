/**
 * 桌面壳主进程：创建窗口、复用渲染服务、约束渲染进程能力。
 *
 * Electron 运行时由安装脚本按 install/deps.json 放到 resources/runtime/electron，
 * 不列为 npm 依赖，保证 npm install 不会额外下载一整份 Electron。
 * 本文件由 electron.cjs 在 Electron 主进程里动态导入；纯 Node 环境下只导出 bootstrap。
 */
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs");
/** apps/desktop/src → 工程根；成片默认落在工程根下的 output，与安装根同一个位置 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 编辑器静态服务：打包态没有 Vite / 启动脚本时，由桌面壳自己托管构建产物。
 * 与启动脚本的 startStatic 同一条路由（/fonts/ 也在这里），保证开发态与打包态一致。
 */
const EDITOR_MIME = {
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
  ".wasm": "application/wasm",
};

function startEditorStatic(editorDist, fontsDir) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // 字体目录：界面按 /fonts/<文件名> 取字体文件
    if (pathname.startsWith("/fonts/")) {
      const file = path.resolve(fontsDir, pathname.slice("/fonts/".length));
      if (!file.startsWith(fontsDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": EDITOR_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(fs.readFileSync(file));
      return;
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(editorDist, rel);
    if (!file.startsWith(editorDist + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const target = fs.existsSync(file) && fs.statSync(file).isFile()
      ? file
      : path.join(editorDist, "index.html"); // SPA 回退
    res.writeHead(200, {
      "Content-Type": EDITOR_MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(target));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(5173, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:5173",
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export async function bootstrap() {
  // electron.cjs 用 require('electron') 注入，避开 ESM/CJS 互操作的版本差异
  const electron = globalThis.__JEEK_ELECTRON__ ?? (await import("electron"));
  const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = electron;

  // 关闭 Chromium 对「后台 / 被遮挡窗口」的节流：导出是长任务，窗口被别的窗口盖住或失焦时，
  // Chromium 默认会把 requestAnimationFrame 与 setTimeout 压到 ~1Hz，导致逐帧渲染近乎停摆。
  // 这三道开关与 smoke 测试一致，保证成品在后台也能满速跑导出。
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");

  // 路径：开发态按工作区布局，打包态按 Electron 资源目录（asar 外的解包资源）。
  const isPackaged = app.isPackaged;
  const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const FONTS_DIR = isPackaged ? path.join(process.resourcesPath, "fonts") : path.join(APP_ROOT, "fonts");
  const OUTPUT_DIR = isPackaged ? path.join(path.dirname(app.getPath("exe")), "output") : path.join(APP_ROOT, "output");
  const EDITOR_DIST = isPackaged
    ? path.join(app.getAppPath(), "apps", "editor", "dist")
    : path.join(APP_ROOT, "apps", "editor", "dist");

  // 品牌图标：窗口图标与（打包态）嵌入 exe 的来源
  const ICON_PATH = isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(APP_ROOT, "apps", "desktop", "icon.ico");

  // 打包态：ffmpeg / 识别模型 / 字体 都落在 Electron 资源目录，由 main 统一算好喂给渲染服务，
  // 避免渲染服务按自己 ROOT 推导错位；这些变量在 import 渲染服务之前就设好。
  if (isPackaged) {
    process.env.JEEK_FFMPEG_BIN = path.join(process.resourcesPath, "bin", "ffmpeg.exe");
    process.env.JEEK_ASR_EXE = path.join(process.resourcesPath, "asr", "llama-funasr-sensevoice.exe");
    process.env.JEEK_ASR_MODEL = path.join(process.resourcesPath, "asr", "models", "sensevoice-small-q8.gguf");
    process.env.JEEK_VAD_MODEL = path.join(process.resourcesPath, "asr", "models", "fsmn-vad.gguf");
    process.env.JEEK_FONTS_DIR = FONTS_DIR;
  }

  // 启动器已经把渲染服务跑起来时直接复用；单独运行桌面壳时才自己拉起。
  let service = null;
  let renderUrl = process.env.JEEK_RENDER_URL;
  if (!renderUrl) {
    const { startRenderService } = await import("@jeek/render-service");
    service = await startRenderService({
      port: Number(process.env.JEEK_RENDER_PORT ?? 5174),
    });
    renderUrl = service.url;
    process.env.JEEK_RENDER_URL = renderUrl;
  }

  // 编辑器：启动器已开静态 / Vite 服务就直接用；自己跑时（打包态）起一个静态服务托管构建产物。
  let editorServer = null;
  let editorUrl = process.env.JEEK_EDITOR_URL;
  if (!editorUrl) {
    editorServer = await startEditorStatic(EDITOR_DIST, FONTS_DIR);
    editorUrl = editorServer.url;
  }

  await app.whenReady();

  // 去掉应用菜单（File/Edit/View 等）：去原生标题栏后不再需要，也避免 Alt 唤出
  Menu.setApplicationMenu(null);

  // 去掉原生标题栏与菜单栏：最小化 / 最大化 / 关闭改由界面自绘（与 UI 同风格、随深色自动适配）
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "吉客字幕剪辑",
    frame: false,
    icon: ICON_PATH,
    backgroundColor: "#f3f6fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 录音面板一开就要有波形监控：不让音频上下文等用户手势
      autoplayPolicy: "no-user-gesture-required",
      // 导出是长任务：窗口被遮挡 / 最小化时也不许降频，否则逐帧渲染会近乎停摆
      backgroundThrottling: false,
      preload: PRELOAD,
    },
  });

  // 外链一律拒绝；界面需要打开外部页面时由主进程按白名单放行
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 自绘窗口控制：最小化 / 切换最大化 / 关闭；最大化状态变化回传界面
  ipcMain.handle("jeek:window-minimize", () => { win.minimize(); });
  ipcMain.handle("jeek:window-toggle-maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("jeek:window-close", () => { win.close(); });
  ipcMain.handle("jeek:window-is-maximized", () => win.isMaximized());
  win.on("maximize", () => win.webContents.send("jeek:window-state", true));
  win.on("unmaximize", () => win.webContents.send("jeek:window-state", false));

  await win.loadURL(editorUrl);

  /* ------------------------------------------------ 白名单文件能力（IPC） */

  // 成片默认落在程序旁边的 output；装到只读目录写不进去时退回用户数据目录
  const exportRoot = () => {
    const dir = OUTPUT_DIR;
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return app.getPath("userData");
    }
  };

  // 只允许已知交付后缀（视频成片 / 字幕 / 工程），且必须落在绝对目录里，挡掉目录穿越与乱写文件
  const EXPORT_EXTENSIONS = /\.(mp4|mov|srt|vtt|txt|json|jeek)$/i;
  const safeExportTarget = (dir, name, allowed = EXPORT_EXTENSIONS) => {
    const base = typeof dir === "string" && dir.trim() ? dir.trim() : exportRoot();
    if (!path.isAbsolute(base)) throw new Error("导出目录必须是绝对路径");
    const raw = typeof name === "string" && name.trim() ? name.trim() : "export.mp4";
    const fileName = path.basename(raw).replace(/[\\/:*?"<>|]/g, "_");
    if (!allowed.test(fileName)) {
      throw new Error("导出文件后缀不受支持（仅限 .mp4 / .mov / .srt / .vtt / .txt / .json / .jeek）");
    }
    return path.join(base, fileName);
  };

  ipcMain.handle("jeek:default-export-dir", () => exportRoot());

  /**
   * 查询某目录所在磁盘的剩余空间：导出前用来判断「临时帧 + 成品」是否放得下。
   * 目录还没建出来时逐级往上找，直到命中一个真实存在的父目录。
   */
  ipcMain.handle("jeek:disk-free", (_e, dirPath) => {
    let target = typeof dirPath === "string" && dirPath.trim() ? dirPath.trim() : exportRoot();
    if (!path.isAbsolute(target)) return { ok: false, error: "目录必须是绝对路径" };
    for (let i = 0; i < 12; i += 1) {
      try {
        const st = fs.statfsSync(target);
        return { ok: true, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
      } catch {
        const parent = path.dirname(target);
        if (parent === target) break;
        target = parent;
      }
    }
    return { ok: false, error: "无法读取磁盘空间" };
  });

  /* ------------------------------------------------ 字体目录（用户维护的内置字体） */

  // 字体文件统一放在 fonts/，界面按 /fonts/<文件名> 直接加载（不塞 base64）
  const FONT_MIME = { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };
  // 与 @jeek/core 的 MAX_FONT_BYTES 一致：完整中文字体可到几十 MB，放宽到 200 MB
  const MAX_FONT_BYTES = 200 * 1024 * 1024;
  const fontsRoot = () => {
    const dir = FONTS_DIR;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录建不出来就退回用户数据目录
    }
    return dir;
  };

  const fontCatalogFile = () => path.join(app.getPath("userData"), "jeek-fonts.json");
  const readFontCatalog = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(fontCatalogFile(), "utf8"));
      return Array.isArray(raw?.fonts) ? raw.fonts : [];
    } catch {
      return [];
    }
  };
  const writeFontCatalog = (fonts) => {
    fs.mkdirSync(path.dirname(fontCatalogFile()), { recursive: true });
    fs.writeFileSync(fontCatalogFile(), JSON.stringify({ fonts }, null, 2), "utf8");
  };
  const fontUrl = (fileName) => `/fonts/${encodeURIComponent(fileName)}`;
  const fontEntryOf = (item) => ({
    family: String(item?.family ?? ""),
    fileName: String(item?.fileName ?? ""),
    sizeBytes: Number(item?.sizeBytes ?? 0),
    // 老版本把字体内容存在目录 JSON 里：有 base64 就继续用，没有就按 fonts/ 里的文件地址给
    source: item?.base64
      ? `data:${FONT_MIME[path.extname(String(item?.fileName ?? "")).toLowerCase()] ?? "font/ttf"};base64,${String(item.base64)}`
      : fontUrl(String(item?.fileName ?? "")),
  });

  /** 老版本把整份字体塞在目录 JSON 里：读到时就地落成 fonts/ 下的文件，之后一律走文件地址 */
  const migrateLegacyFonts = () => {
    const dir = fontsRoot();
    // 磁盘上已不存在的字体文件不再留在目录里（否则列表挂着加载失败的无效字体）
    const stored = readFontCatalog();
    const fonts = stored.filter((item) => {
      if (item?.base64) return true;
      const name = String(item?.fileName ?? "");
      return !name || fs.existsSync(path.join(dir, path.basename(name)));
    });
    let changed = fonts.length !== stored.length;
    for (const item of fonts) {
      if (!item?.base64) continue;
      try {
        const fileName = path.basename(String(item.fileName ?? "font.ttf"));
        const full = path.join(dir, fileName);
        if (!fs.existsSync(full)) fs.writeFileSync(full, Buffer.from(String(item.base64), "base64"));
        item.fileName = fileName;
        delete item.base64;
        changed = true;
      } catch {
        // 写不出来就继续用 base64
      }
    }
    if (changed) {
      try {
        writeFontCatalog(fonts);
      } catch {
        // 目录文件写不进去也不影响本次使用
      }
    }
    return fonts;
  };

  /** 拷进 fonts/ 的文件名：同名就加序号，绝不覆盖别人的字体 */
  const writeFontFile = (fileName, buffer) => {
    const dir = fontsRoot();
    const ext = path.extname(fileName).toLowerCase();
    const base = path.basename(fileName, path.extname(fileName)) || "font";
    let name = `${base}${ext}`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = `${base}-${i}${ext}`;
    fs.writeFileSync(path.join(dir, name), buffer);
    return name;
  };

  const registerFont = ({ family, fileName, sizeBytes }) => {
    const name = String(family ?? "").trim() || path.basename(fileName, path.extname(fileName));
    const fonts = migrateLegacyFonts().filter((item) => item.family !== name);
    fonts.push({ family: name, fileName, sizeBytes });
    writeFontCatalog(fonts);
    return fontEntryOf(fonts[fonts.length - 1]);
  };

  ipcMain.handle("jeek:fonts-list", () => ({ fonts: migrateLegacyFonts().map(fontEntryOf) }));

  ipcMain.handle("jeek:fonts-import", (_e, options = {}) => {
    try {
      const rawName = path.basename(String(options.fileName ?? "")).trim();
      const ext = path.extname(rawName).toLowerCase();
      if (!FONT_MIME[ext]) throw new Error("只支持 .ttf / .otf / .woff / .woff2 字体文件");
      const base64 = String(options.base64 ?? "");
      if (!base64) throw new Error("字体文件内容为空");
      const buffer = Buffer.from(base64, "base64");
      if (buffer.length > MAX_FONT_BYTES) throw new Error("字体文件超过 200 MB");
      const fileName = writeFontFile(rawName, buffer);
      const entry = registerFont({ family: options.family, fileName, sizeBytes: buffer.length });
      return { ok: true, entry };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  /** 按物理路径导入：读文件 → 拷进 fonts/ → 登记 */
  ipcMain.handle("jeek:fonts-import-path", (_e, options = {}) => {
    try {
      const source = String(options.path ?? "").trim().replace(/^file:\/\//i, "");
      if (!source || !path.isAbsolute(source)) throw new Error("请填字体文件的完整路径");
      const ext = path.extname(source).toLowerCase();
      if (!FONT_MIME[ext]) throw new Error("只支持 .ttf / .otf / .woff / .woff2 字体文件");
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw new Error("这个路径不是文件");
      if (stat.size > MAX_FONT_BYTES) throw new Error("字体文件超过 200 MB");
      const buffer = fs.readFileSync(source);
      const fileName = writeFontFile(path.basename(source), buffer);
      const entry = registerFont({
        family: options.family,
        fileName,
        sizeBytes: buffer.length,
      });
      return { ok: true, entry };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle("jeek:fonts-remove", (_e, family) => {
    try {
      const name = String(family ?? "").trim();
      const fonts = migrateLegacyFonts();
      const hit = fonts.find((item) => item.family === name);
      const left = fonts.filter((item) => item.family !== name);
      writeFontCatalog(left);
      // 连文件一起删掉，避免下次扫描又把它收回来
      if (hit?.fileName) {
        const full = path.join(fontsRoot(), path.basename(String(hit.fileName)));
        try {
          if (fs.existsSync(full)) fs.unlinkSync(full);
        } catch {
          // 删不掉文件也不影响从列表里移除
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // 项目根目录的 fonts 文件夹：用户把字体文件拷进来，打开字体管理面板时自动收录
  const scanFontsDir = () => {
    const dir = fontsRoot();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const fonts = migrateLegacyFonts();
    const known = new Set(fonts.map((item) => String(item.fileName ?? "")));
    let changed = false;
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!FONT_MIME[ext]) continue;
      if (known.has(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size > MAX_FONT_BYTES) continue;
        const family = path.basename(name, ext);
        // 同名家族已在目录里就跳过，避免覆盖用户单独导入的版本
        if (fonts.some((item) => item.family === family)) {
          known.add(name);
          continue;
        }
        fonts.push({ family, fileName: name, sizeBytes: stat.size });
        known.add(name);
        changed = true;
      } catch {
        // 单个文件读失败不影响其它
      }
    }
    if (changed) {
      try {
        writeFontCatalog(fonts);
      } catch {
        // 写盘失败也要把已读到的返回给界面
      }
    }
    return fonts;
  };

  ipcMain.handle("jeek:fonts-scan", () => ({ fonts: scanFontsDir().map(fontEntryOf), dir: fontsRoot() }));

  ipcMain.handle("jeek:fonts-open-dir", async () => {
    const dir = fontsRoot();
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /** 字体导入面板的「打开」按钮：系统文件选择器，选完把完整路径交给界面 */
  ipcMain.handle("jeek:pick-font-file", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "选择字体文件",
      defaultPath: fontsRoot(),
      properties: ["openFile"],
      filters: [{ name: "字体文件", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: picked.filePaths[0] };
  });

  // 导入面板的实时预览：把还没保存的字体文件读成同源 data URL，交给界面的 FontFace 临时注册
  ipcMain.handle("jeek:read-font-file", (_e, rawPath) => {
    try {
      const source = String(rawPath ?? "").trim().replace(/^file:\/\//i, "");
      if (!source || !path.isAbsolute(source)) return { ok: false, error: "请填字体文件的完整路径" };
      const ext = path.extname(source).toLowerCase();
      if (!FONT_MIME[ext]) return { ok: false, error: "只支持 .ttf / .otf / .woff / .woff2 字体文件" };
      const stat = fs.statSync(source);
      if (!stat.isFile()) return { ok: false, error: "这个路径不是文件" };
      if (stat.size > MAX_FONT_BYTES) return { ok: false, error: "字体文件超过 200 MB" };
      const mime = FONT_MIME[ext];
      const dataUrl = `data:${mime};base64,${fs.readFileSync(source).toString("base64")}`;
      return { ok: true, dataUrl };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // 背景图：渲染进程跑在 http 页面里、webSecurity 开着，读不到本地物理路径，
  // 因此由主进程负责选文件与读文件，转成同源的 data URL 再交回界面加载。
  const IMAGE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif",
    ".avif": "image/avif", ".svg": "image/svg+xml",
  };
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  /** 资源管理器「复制文件地址」常带首尾引号或 file:// 前缀，这里统一剥掉 */
  const cleanImagePath = (raw) => {
    let value = String(raw ?? "")
      .trim()
      .replace(/^["'“”‘’]+/, "")
      .replace(/["'“”‘’]+$/, "")
      .trim()
      .replace(/^file:\/\/\//i, "")
      .replace(/^file:\/\//i, "");
    // file:///C:/xxx 去掉前缀后是 /C:/xxx，在 Windows 上补回盘符形式才能 stat 到
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
    return value;
  };

  ipcMain.handle("jeek:read-image-path", (_e, rawPath) => {
    try {
      const source = cleanImagePath(rawPath);
      if (!source || !path.isAbsolute(source)) throw new Error("路径错误");
      const mime = IMAGE_MIME[path.extname(source).toLowerCase()];
      if (!mime) throw new Error("路径错误");
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) throw new Error("路径错误");
      const dataUrl = `data:${mime};base64,${fs.readFileSync(source).toString("base64")}`;
      return { ok: true, path: source, dataUrl };
    } catch {
      return { ok: false, error: "路径错误" };
    }
  });

  ipcMain.handle("jeek:pick-directory", async (_e, defaultPath) => {
    const picked = await dialog.showOpenDialog(win, {
      title: "选择导出位置",
      defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : exportRoot(),
      properties: ["openDirectory", "createDirectory"],
    });
    return { canceled: picked.canceled, dirPath: picked.canceled ? null : picked.filePaths[0] ?? null };
  });

  ipcMain.handle("jeek:open-directory", async (_e, dirPath) => {
    const dir = typeof dirPath === "string" && dirPath.trim() ? dirPath.trim() : exportRoot();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录已经存在或无法创建，交给 openPath 报错
    }
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle("jeek:reveal-in-folder", async (_e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "没有文件路径" };
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle("jeek:save-export-file", async (_e, options = {}) => {
    try {
      const target = safeExportTarget(options.dir, options.name);
      const bytes = options.bytes;
      if (!bytes || typeof bytes.length !== "number") throw new Error("导出内容为空");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bytes));
      return { ok: true, filePath: target, size: fs.statSync(target).size };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // 导出字幕：弹系统保存对话框，由用户选位置与文件名（不再自动写进默认目录）
  ipcMain.handle("jeek:save-subtitle-file", async (_e, options = {}) => {
    try {
      const format = ["srt", "vtt", "txt", "json"].includes(String(options.format ?? "").toLowerCase())
        ? String(options.format).toLowerCase()
        : "srt";
      const defaultName = typeof options.name === "string" && options.name.trim()
        ? path.basename(options.name.trim())
        : `subtitles.${format}`;
      const picked = await dialog.showSaveDialog(win, {
        title: "导出字幕",
        defaultPath: path.join(exportRoot(), defaultName),
        filters: [
          { name: `${format.toUpperCase()} 字幕`, extensions: [format] },
          { name: "全部文件", extensions: ["*"] },
        ],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(picked.filePath, String(options.text ?? ""), "utf8");
      return { ok: true, filePath: picked.filePath, size: fs.statSync(picked.filePath).size };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  /* 主进程直接从渲染服务把成品流式落盘：渲染进程不参与大文件传输，避免数 GB 成品
     塞进渲染进程的 ArrayBuffer（上限约 2GB）导致导出失败。Node 的 http 直接把响应体
     管道写入磁盘，内存占用恒定，不受成品体积影响。 */
  ipcMain.handle("jeek:download-export", (_e, options = {}) => new Promise((resolve) => {
    let target = null;
    let out = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const renderUrl = String(options.renderUrl || process.env.JEEK_RENDER_URL || "http://127.0.0.1:5174");
      const jobId = String(options.jobId || "");
      if (!jobId) { finish({ ok: false, error: "缺少导出任务 ID" }); return; }
      target = safeExportTarget(options.dir, options.name, /\.(mp4|mov)$/i);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const url = `${renderUrl.replace(/\/+$/, "")}/api/v1/media/render/result?jobId=${encodeURIComponent(jobId)}`;
      const req = http.get(url, (res) => {
        if (res.statusCode !== 200) {
          // 成品未就绪 / 编码失败：服务端回的是 JSON 错误体
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { body += c; });
          res.on("end", () => {
            let msg = `取回成品失败 ${res.statusCode}`;
            try { const j = JSON.parse(body); if (j?.error) msg = j.error; } catch { /* 非 JSON */ }
            finish({ ok: false, error: msg });
          });
          return;
        }
        const hardwareEncoded = res.headers["x-jeek-hardware-encoded"] === "1";
        out = fs.createWriteStream(target);
        res.pipe(out);
        out.on("finish", () => finish({ ok: true, filePath: target, size: fs.statSync(target).size, hardwareEncoded }));
        out.on("error", (err) => {
          try { if (target) fs.unlinkSync(target); } catch { /* 清理失败 */ }
          finish({ ok: false, error: `写入成品失败：${String(err?.message ?? err)}` });
        });
      });
      req.on("error", (err) => {
        try { if (out) out.destroy(); } catch { /* 已关闭 */ }
        try { if (target) fs.unlinkSync(target); } catch { /* 还没落盘 */ }
        finish({ ok: false, error: `连接渲染服务失败：${String(err?.message ?? err)}` });
      });
    } catch (error) {
      try { if (target) fs.unlinkSync(target); } catch { /* 清理失败 */ }
      finish({ ok: false, error: String(error?.message ?? error) });
    }
  }));

  ipcMain.handle("jeek:open-project", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "打开工程",
      properties: ["openFile"],
      filters: [
        { name: "工程文件", extensions: ["json", "jeek"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    return { canceled: picked.canceled, filePath: picked.canceled ? null : picked.filePaths[0] ?? null };
  });

  ipcMain.handle("jeek:read-text-file", async (_e, filePath) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "没有文件路径" };
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 32 * 1024 * 1024) return { ok: false, error: "文件超过 32 MB" };
      return { ok: true, text: fs.readFileSync(filePath, "utf8") };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle("jeek:save-project", async (_e, options = {}) => {
    try {
      const defaultName = typeof options.name === "string" && options.name ? options.name : "project.json";
      const picked = await dialog.showSaveDialog(win, {
        title: "保存工程",
        defaultPath: path.join(exportRoot(), path.basename(defaultName)),
        filters: [{ name: "工程文件", extensions: ["jeek", "json"] }, { name: "全部文件", extensions: ["*"] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(picked.filePath, String(options.text ?? ""), "utf8");
      return { ok: true, filePath: picked.filePath };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  win.on("closed", () => {
    if (service) void service.close();
    if (editorServer) void editorServer.close();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  return { window: win, service, dialog, renderUrl, editorUrl };
}
