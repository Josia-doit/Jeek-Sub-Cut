/**
 * 白名单渲染桥：界面拿不到 Node 与任意路径能力。
 *
 * 只暴露「选目录 / 存文件 / 打开位置」这几种固定动作，参数与返回都是纯值；
 * 目录与文件名由主进程校验，渲染进程拿不到写任意路径的能力。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld(
  "jeekStudio",
  Object.freeze({
    version: "0.1.0",
    renderUrl: process.env.JEEK_RENDER_URL || "http://127.0.0.1:5174",
    defaultExportDir: () => ipcRenderer.invoke("jeek:default-export-dir"),
    // 导出前查盘：临时帧与成品要落在同一块盘上，空间不足会直接编码失败
    diskFree: (dirPath) => ipcRenderer.invoke("jeek:disk-free", dirPath),
    pickDirectory: (defaultPath) => ipcRenderer.invoke("jeek:pick-directory", defaultPath),
    openDirectory: (dirPath) => ipcRenderer.invoke("jeek:open-directory", dirPath),
    revealInFolder: (filePath) => ipcRenderer.invoke("jeek:reveal-in-folder", filePath),
    saveExportFile: (options) => ipcRenderer.invoke("jeek:save-export-file", options),
    // 导出字幕：弹系统保存对话框选位置与文件名，再写盘
    saveSubtitleFile: (options) => ipcRenderer.invoke("jeek:save-subtitle-file", options),
    // 主进程直接从渲染服务把成品流式落盘：渲染进程不缓存整份文件，避免大文件（数 GB）爆内存 / 超出 ArrayBuffer 上限。
    downloadExport: (options) => ipcRenderer.invoke("jeek:download-export", options),
    openProject: () => ipcRenderer.invoke("jeek:open-project"),
    readTextFile: (filePath) => ipcRenderer.invoke("jeek:read-text-file", filePath),
    saveProject: (options) => ipcRenderer.invoke("jeek:save-project", options),
    fontsList: () => ipcRenderer.invoke("jeek:fonts-list"),
    fontsImport: (options) => ipcRenderer.invoke("jeek:fonts-import", options),
    fontsImportPath: (options) => ipcRenderer.invoke("jeek:fonts-import-path", options),
    fontsRemove: (family) => ipcRenderer.invoke("jeek:fonts-remove", family),
    fontsScan: () => ipcRenderer.invoke("jeek:fonts-scan"),
    fontsOpenDir: () => ipcRenderer.invoke("jeek:fonts-open-dir"),
    pickFontFile: () => ipcRenderer.invoke("jeek:pick-font-file"),
    // 导入面板的实时预览：把还没保存的字体文件读成 data URL（同源，交给 FontFace 临时注册）
    readFontFile: (p) => ipcRenderer.invoke("jeek:read-font-file", p),
    // 背景图：把文件输入框选中的 File 换成物理路径，再按路径读成同源 data URL
    // （渲染进程跑在 http 页面里，既读不到本地路径也加载不了 file:// 图片）
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
    },
    readImagePath: (p) => ipcRenderer.invoke("jeek:read-image-path", p),
    // 窗口控制（去原生标题栏后由界面自绘的最小化/最大化/关闭）
    windowControl: (action) => ipcRenderer.invoke("jeek:window-" + action),
    getWindowMaximized: () => ipcRenderer.invoke("jeek:window-is-maximized"),
    onWindowMaximizedChange: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on("jeek:window-state", handler);
      return () => ipcRenderer.removeListener("jeek:window-state", handler);
    },
  }),
);
