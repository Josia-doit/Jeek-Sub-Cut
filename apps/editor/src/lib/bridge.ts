/**
 * 桌面壳白名单桥。
 *
 * 浏览器里跑时没有桥，所有能力自动退回「下载到浏览器默认目录」的走法；
 * 桌面壳里则由主进程负责选目录、落盘、打开所在位置。
 */

interface StudioBridge {
  version?: string;
  renderUrl?: string;
  defaultExportDir(): Promise<string>;
  /** 查询目录所在磁盘的剩余空间（字节）。 */
  diskFree?(dirPath?: string): Promise<{ ok: boolean; free?: number; total?: number; error?: string }>;
  pickDirectory(defaultPath?: string): Promise<{ canceled: boolean; dirPath: string | null }>;
  openDirectory(dirPath?: string): Promise<{ ok: boolean; error?: string }>;
  revealInFolder(filePath: string): Promise<{ ok: boolean; error?: string }>;
  saveExportFile(options: {
    dir?: string;
    name?: string;
    bytes: Uint8Array;
  }): Promise<{ ok: boolean; filePath?: string; size?: number; error?: string }>;
  /** 导出字幕：弹系统保存对话框选位置与文件名后写盘（浏览器环境没有此能力）。 */
  saveSubtitleFile?(options: {
    text: string;
    format: string;
    name?: string;
  }): Promise<{ ok: boolean; filePath?: string; size?: number; canceled?: boolean; error?: string }>;
  /** 主进程直接从渲染服务把成品流式落盘（渲染进程不缓存整包，支持数 GB 大文件）。 */
  downloadExport(options: {
    renderUrl?: string;
    jobId: string;
    dir?: string;
    name?: string;
  }): Promise<{ ok: boolean; filePath?: string; size?: number; hardwareEncoded?: boolean; error?: string }>;
  openProject(): Promise<{ canceled: boolean; filePath: string | null }>;
  readTextFile(filePath: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  saveProject(options: { name?: string; text: string }): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  /** 背景图：把文件输入框选中的 File 换成物理路径（浏览器环境返回空串）。 */
  pathForFile?(file: File): string;
  /** 背景图：主进程按物理路径读文件，返回同源 data URL（浏览器环境没有此能力）。 */
  readImagePath?(p: string): Promise<{ ok: boolean; path?: string; dataUrl?: string; error?: string }>;
  /** 字体导入预览：把还没保存的字体文件读成 data URL，交给 FontFace 临时注册。 */
  readFontFile?(p: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  windowControl(action: "minimize" | "toggle-maximize" | "close"): Promise<void> | void;
  getWindowMaximized(): Promise<boolean>;
  onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void;
}

const bridge = (): StudioBridge | null => {
  const raw = (globalThis as unknown as { jeekStudio?: Partial<StudioBridge> }).jeekStudio;
  return raw && typeof raw.defaultExportDir === "function" ? (raw as StudioBridge) : null;
};

export const hasDesktopBridge = (): boolean => bridge() !== null;

export async function defaultExportDir(): Promise<string> {
  const api = bridge();
  if (!api) return "";
  try {
    return await api.defaultExportDir();
  } catch {
    return "";
  }
}

/** 目录所在磁盘的剩余字节数；浏览器环境或查询失败返回 -1（调用方据此隐藏提示）。 */
export async function freeSpaceOf(dirPath?: string): Promise<number> {
  const api = bridge();
  if (!api?.diskFree) return -1;
  try {
    const result = await api.diskFree(dirPath);
    return result?.ok && typeof result.free === "number" ? result.free : -1;
  } catch {
    return -1;
  }
}

export async function pickDirectory(current?: string): Promise<string | null> {
  const api = bridge();
  if (!api) return null;
  try {
    const result = await api.pickDirectory(current);
    return result && !result.canceled ? result.dirPath : null;
  } catch {
    return null;
  }
}

export async function openDirectory(dirPath?: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  const result = await api.openDirectory(dirPath);
  return Boolean(result?.ok);
}

export async function revealInFolder(filePath: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  const result = await api.revealInFolder(filePath);
  return Boolean(result?.ok);
}

export async function saveExportFile(
  bytes: Uint8Array,
  options: { dir?: string; name?: string } = {},
): Promise<{ ok: boolean; filePath?: string; size?: number; error?: string }> {
  const api = bridge();
  if (!api) return { ok: false, error: "当前环境没有桌面文件能力" };
  try {
    return await api.saveExportFile({ ...options, bytes });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** 导出字幕：弹系统保存对话框选位置与文件名，取消时返回 canceled。 */
export async function saveSubtitleFile(
  text: string,
  format: string,
  name?: string,
): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> {
  const api = bridge();
  if (!api?.saveSubtitleFile) return { ok: false, error: "当前环境没有桌面文件能力" };
  try {
    return await api.saveSubtitleFile({ text, format, name });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** 读取尚未导入的字体文件为 data URL（导入面板的实时预览用）；浏览器环境返回 null。 */
export async function readFontFile(p: string): Promise<{ ok: boolean; dataUrl?: string; error?: string } | null> {
  const api = bridge();
  if (!api?.readFontFile) return null;
  try {
    return await api.readFontFile(p);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 主进程流式落盘：把渲染服务的导出成品直接写到磁盘，渲染进程不缓存整份文件。
 * 适合数 GB 的大成品（ArrayBuffer 上限约 2GB，整包取回会在渲染进程里崩）。
 */
export async function downloadExport(
  options: { renderUrl?: string; jobId: string; dir?: string; name?: string },
): Promise<{ ok: boolean; filePath?: string; size?: number; hardwareEncoded?: boolean; error?: string }> {
  const api = bridge();
  if (!api) return { ok: false, error: "当前环境没有桌面文件能力" };
  try {
    return await api.downloadExport(options);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function openProjectFile(): Promise<{ filePath: string; text: string } | null> {
  const api = bridge();
  if (!api) return null;
  const picked = await api.openProject();
  if (!picked || picked.canceled || !picked.filePath) return null;
  const read = await api.readTextFile(picked.filePath);
  if (!read?.ok) throw new Error(read?.error ?? "读取工程文件失败");
  return { filePath: picked.filePath, text: read.text ?? "" };
}

export async function saveProjectFile(
  text: string,
  name?: string,
): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> {
  const api = bridge();
  if (!api) return { ok: false, error: "当前环境没有桌面文件能力" };
  try {
    return await api.saveProject({ name, text });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** 把文件输入框选中的 File 换成物理路径；浏览器模式没有桌面文件能力，返回空串。 */
export function pathForFile(file: File): string {
  const api = bridge();
  if (!api?.pathForFile) return "";
  try {
    return api.pathForFile(file) || "";
  } catch {
    return "";
  }
}

/** 按物理路径把图片读成同源 data URL，供画布 Image 直接加载。路径无效返回 ok:false。 */
export async function readImagePath(
  p: string,
): Promise<{ ok: boolean; path?: string; dataUrl?: string; error?: string }> {
  const api = bridge();
  if (!api?.readImagePath) return { ok: false, error: "浏览器模式不支持按路径读取本地图片" };
  try {
    return await api.readImagePath(p);
  } catch {
    return { ok: false, error: "路径错误" };
  }
}

/** 窗口控制：去原生标题栏后，界面自绘的最小化 / 最大化 / 关闭按钮走这里。 */
export function windowControl(action: "minimize" | "toggle-maximize" | "close"): void {
  const api = bridge();
  if (!api?.windowControl) return;
  try { void api.windowControl(action); } catch { /* 忽略 */ }
}

export async function getWindowMaximized(): Promise<boolean> {
  const api = bridge();
  if (!api?.getWindowMaximized) return false;
  try { return await api.getWindowMaximized(); } catch { return false; }
}

export function onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void {
  const api = bridge();
  if (!api?.onWindowMaximizedChange) return () => {};
  return api.onWindowMaximizedChange(cb);
}
