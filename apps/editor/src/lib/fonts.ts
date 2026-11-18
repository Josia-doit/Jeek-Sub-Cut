/**
 * 字体目录：系统字体 + 随程序分发的开源字体 + 用户导入的本地字体。
 *
 * 所有字体文件都放在项目根目录的 `fonts/` 里，界面按 `/fonts/<文件名>` 直接加载，
 * 不用把字体塞成 base64 —— 打开字体面板不会因为几 MB 的字体卡住。
 * 桌面壳负责把导入的文件拷进 `fonts/`；浏览器里退回 localStorage + data URL。
 * 量字宽前会先等字体加载完，否则测出来的是回退字体的宽度，字号会算错。
 */
import { clearMeasureTextCache } from "@jeek/engine";
import {
  FONT_FILE_EXTENSIONS,
  MAX_FONT_BYTES,
  defaultFontLabel,
  fontFamilyOfFile,
  isFontFile,
  sanitizeFontEntries,
  type FontEntry,
  type FontLabel,
} from "@jeek/core";

const STORAGE_KEY = "jeek-font-catalog";
const LABEL_KEY = "jeek-font-labels";
const STYLE_ID = "jeek-font-faces";

interface StudioFontBridge {
  fontsList?(): Promise<{ fonts?: FontEntry[] }>;
  fontsImport?(options: { family: string; fileName: string; base64: string }): Promise<{ ok: boolean; entry?: FontEntry; error?: string }>;
  /** 按物理路径导入：桌面壳读文件、拷进 fonts 目录再登记 */
  fontsImportPath?(options: { path: string; family: string }): Promise<{ ok: boolean; entry?: FontEntry; error?: string }>;
  fontsRemove?(family: string): Promise<{ ok: boolean; error?: string }>;
  /** 扫描项目根目录的 fonts 文件夹，自动收录其中的字体文件，并返回合并后的完整目录 */
  fontsScan?(): Promise<{ fonts?: FontEntry[]; dir?: string }>;
  /** 打开 fonts 文件夹 */
  fontsOpenDir?(): Promise<{ ok: boolean; error?: string }>;
}

const fontBridge = (): StudioFontBridge | null => {
  const raw = (globalThis as unknown as { jeekStudio?: StudioFontBridge }).jeekStudio;
  return raw && typeof raw.fontsList === "function" ? raw : null;
};

/** 字体是否都已加载完：没加载完时画布要重画，否则量到的是回退字体的宽度 */
let settled = true;
export const fontsSettled = (): boolean => settled;

/** 读目录：桌面桥优先，浏览器退回 localStorage */
export async function loadFontCatalog(): Promise<FontEntry[]> {
  const api = fontBridge();
  if (api) {
    try {
      const result = await api.fontsList!();
      return sanitizeFontEntries(result?.fonts ?? []);
    } catch {
      return [];
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeFontEntries(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** 存目录：桌面桥优先，浏览器退回 localStorage（超配额时如实报错，不静默丢） */
export async function saveFontCatalog(entries: FontEntry[]): Promise<{ ok: boolean; error?: string }> {
  const api = fontBridge();
  if (api) {
    // 桌面壳自己存盘，这里只需要把增删同步过去
    return { ok: true };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `浏览器存储放不下这个字体（${String(error)}）` };
  }
}

/* ------------------------------------------------------------ 显示名（中英双名） */

export type FontLabels = Record<string, FontLabel>;

/** 用户改过的字体名：key 是字体族名，桌面与浏览器都存在 localStorage 里 */
export function loadFontLabels(): FontLabels {
  try {
    const raw = localStorage.getItem(LABEL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as FontLabels;
    const out: FontLabels = {};
    for (const [family, label] of Object.entries(parsed ?? {})) {
      const cn = String(label?.cn ?? "").trim();
      const en = String(label?.en ?? "").trim();
      if (family && (cn || en)) out[family] = { cn: cn || en, en: en || cn };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 字体的中文显示名：用户改名过的优先用改名（存在 localStorage），
 * 否则用内置/系统字体的中文名，导入字体按文件名解析中文名。
 * 下拉框、列表里都走这个，保证看到的是中文字体名而不是英文族名。
 */
export function fontCnName(family: string, fileName?: string): string {
  const renamed = loadFontLabels()[family]?.cn;
  if (renamed) return renamed;
  return defaultFontLabel(family, fileName).cn;
}

export function setFontLabel(family: string, label: FontLabel): FontLabels {
  const next = { ...loadFontLabels() };
  const cn = String(label.cn ?? "").trim();
  const en = String(label.en ?? "").trim();
  if (!family || (!cn && !en)) delete next[family];
  else next[family] = { cn: cn || en, en: en || cn };
  try {
    localStorage.setItem(LABEL_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下名字只在本次会话有效 */
  }
  return next;
}

/* ------------------------------------------------------------ 导入 / 删除 */

/** 读文件为 base64（去掉 data URL 头，只留内容） */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取字体文件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export interface FontImportResult {
  ok: boolean;
  entry?: FontEntry;
  error?: string;
}

/**
 * 按物理路径导入（桌面版）：正斜线 / 反斜线 / 带引号都能用，
 * 桌面壳会读文件、校验后缀与体积，再拷进项目根目录的 fonts/。
 */
export async function importFontByPath(rawPath: string, family: string): Promise<FontImportResult> {
  const filePath = normalizeUserPath(rawPath);
  if (!filePath) return { ok: false, error: "先填字体文件的完整路径" };
  if (!isFontFile(filePath)) {
    return { ok: false, error: `只支持 ${FONT_FILE_EXTENSIONS.join(" / ")} 字体文件` };
  }
  const api = fontBridge();
  if (!api?.fontsImportPath) {
    return { ok: false, error: "浏览器版读不了本机路径：请点右边的文件夹按钮选择字体文件" };
  }
  try {
    const result = await api.fontsImportPath({ path: filePath, family });
    if (!result?.ok || !result.entry) return { ok: false, error: result?.error ?? "导入字体失败" };
    return { ok: true, entry: result.entry };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 用户从地址栏粘进来的路径：支持 `"D:\Fonts\a.ttf"`、`'a.ttf'`、
 * `D:/Fonts/a.ttf`、以及资源管理器「复制路径」带的引号与首尾空白。
 */
export function normalizeUserPath(raw: string): string {
  let text = String(raw ?? "").trim();
  const quotes: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["「", "」"], ["‘", "’"]];
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    for (const [open, close] of quotes) {
      if (text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim();
        changed = true;
      }
    }
  }
  return text.replace(/^file:\/\//i, "").replace(/^\/+([A-Za-z]:)/, "$1");
}

/** 导入一个本地字体文件（浏览器：File 对象） */
export async function importFontFile(file: File, family?: string): Promise<FontImportResult> {
  if (!isFontFile(file.name)) {
    return { ok: false, error: `只支持 ${FONT_FILE_EXTENSIONS.join(" / ")} 字体文件` };
  }
  if (file.size > MAX_FONT_BYTES) {
    return { ok: false, error: "字体文件超过 200 MB" };
  }
  const name = String(family ?? "").trim() || fontFamilyOfFile(file.name);
  const base64 = await readAsBase64(file);
  const api = fontBridge();
  if (api) {
    try {
      const result = await api.fontsImport!({ family: name, fileName: file.name, base64 });
      if (!result?.ok || !result.entry) return { ok: false, error: result?.error ?? "导入字体失败" };
      return { ok: true, entry: result.entry };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  const source = `data:${file.type || "font/ttf"};base64,${base64}`;
  return { ok: true, entry: { family: name, fileName: file.name, sizeBytes: file.size, source } };
}

/** 从目录里删掉一个字体（桌面版会把 fonts 目录里的文件一起删掉） */
export async function removeFontFromCatalog(family: string): Promise<{ ok: boolean; error?: string }> {
  const api = fontBridge();
  if (api) {
    try {
      const result = await api.fontsRemove!(family);
      return result?.ok ? { ok: true } : { ok: false, error: result?.error ?? "删除字体失败" };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  return { ok: true };
}

/** 桌面版是否支持扫描 fonts 文件夹 */
export function canScanFontsDirectory(): boolean {
  return typeof fontBridge()?.fontsScan === "function";
}

/** 扫描项目根目录 fonts 文件夹：自动收录新放进来的字体，返回合并后的完整目录 */
export async function scanFontsDirectory(): Promise<FontEntry[]> {
  const api = fontBridge();
  if (!api?.fontsScan) return [];
  try {
    const result = await api.fontsScan();
    return sanitizeFontEntries(result?.fonts ?? []);
  } catch {
    return [];
  }
}

/** 打开 fonts 文件夹（桌面版） */
export async function openFontsDirectory(): Promise<boolean> {
  const api = fontBridge();
  if (!api?.fontsOpenDir) return false;
  try {
    const result = await api.fontsOpenDir();
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ @font-face */

/**
 * 注入 `@font-face`：只注入目录里用户导入的字体（按自身 source），同名字体只保留一条。
 * 系统字体走系统字形、不随程序分发的第三方字体不再注入。
 */
export function applyFontFaces(entries: FontEntry[]): void {
  const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    ?? Object.assign(document.createElement("style"), { id: STYLE_ID });
  if (!style.parentNode) document.head.appendChild(style);
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const entry of entries) {
    if (!entry.source || seen.has(entry.family)) continue;
    seen.add(entry.family);
    const family = entry.family.replace(/'/g, "\\'");
    rules.push(`@font-face { font-family: '${family}'; src: url('${entry.source}'); font-display: swap; }`);
  }
  style.textContent = rules.join("\n");
}

/** 工程里用到的字体（字幕条目自带 fontSource 时才拿得到） */
export function fontEntriesFromDocument(doc: {
  tracks?: Array<{ clips?: Array<{ data?: Record<string, unknown> }> }>;
}): FontEntry[] {
  const out: FontEntry[] = [];
  for (const track of doc.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const family = String(clip.data?.fontFamily ?? "").trim();
      const source = String(clip.data?.fontSource ?? "").trim();
      if (family && source) out.push({ family, source });
    }
  }
  return out;
}

/** 等字体真正加载完：量字宽前不做这一步会算错字号 */
export async function ensureFontsLoaded(entries: FontEntry[]): Promise<void> {
  const families = Array.from(new Set(entries.map((e) => e.family))).filter(Boolean);
  if (!families.length) {
    settled = true;
    return;
  }
  settled = false;
  try {
    await Promise.all(families.map((family) => document.fonts.load(`bold 100px "${family}"`)));
  } catch {
    // 字体坏了也要放行：画面退回系统字体，不能卡住整个渲染
  }
  // 字体真身加载完才量字宽：清掉「回退字体宽度」的缓存，字号与取景才不会算错
  clearMeasureTextCache();
  settled = true;
}
