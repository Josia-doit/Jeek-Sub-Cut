/**
 * 字体目录：系统字体 + 用户导入的本地字体。
 *
 * 系统字体（微软雅黑 / 黑体 / 宋体 / 楷体 / 仿宋）直接用 Windows 自带的字形，不打包；
 * 不随程序分发任何第三方字体，避免字体授权问题 —— 需要特殊字体的用户自己安装到系统，
 * 或用「导入本地字体」把字体文件加入目录（带 source，可增可删）。
 */

export interface FontEntry {
  /** 字体名：内置字体是字体族名，导入字体是文件名去掉后缀 */
  family: string;
  /** 字体文件地址：内置开源字体是 /fonts/xxx.otf 或 .ttf，导入字体是 data URL；系统字体没有 */
  source?: string;
  /** 原始文件名 */
  fileName?: string;
  /** 字节数 */
  sizeBytes?: number;
  /** 是否内置（系统字体或随程序分发的开源字体） */
  builtin?: boolean;
  /** 是否随程序分发的开源字体（不可删除，但可以改名） */
  bundled?: boolean;
}

/** 系统自带字体：只能用系统字形，不能删也不能改名 */
export const SYSTEM_FONTS: Array<{ family: string; cn: string; en: string }> = [
  { family: "Microsoft YaHei", cn: "微软雅黑", en: "Microsoft YaHei" },
  { family: "SimHei", cn: "黑体", en: "SimHei" },
  { family: "SimSun", cn: "宋体", en: "SimSun" },
  { family: "KaiTi", cn: "楷体", en: "KaiTi" },
  { family: "FangSong", cn: "仿宋", en: "FangSong" },
];

/** 内置字体清单：只有系统字体（第三方字体不随程序分发，避免授权问题） */
export const BUILTIN_FONT_FAMILIES: string[] = [
  ...SYSTEM_FONTS.map((f) => f.family),
];

/** 是否可选、可删除、可改名 */
export function isSystemFont(family: string): boolean {
  return SYSTEM_FONTS.some((f) => f.family === family);
}

/** 可导入的字体文件后缀（口径照旧版文件选择框） */
export const FONT_FILE_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

/** 单个字体文件上限：字体动辄几 MB，超过 20MB 一律不收 */
/** 单个字体文件上限：完整中文字体（思源黑体全集等）可到几十 MB，放宽到 200 MB */
export const MAX_FONT_BYTES = 200 * 1024 * 1024;

/** 默认字体 */
export const DEFAULT_FONT_FAMILY = "Microsoft YaHei";

export function builtinFontEntries(): FontEntry[] {
  return SYSTEM_FONTS.map((f) => ({ family: f.family, builtin: true }));
}

/** 文件名去掉后缀就是字体名（口径照旧版 `name.replace(/\.[^.]+$/, "")`） */
export function fontFamilyOfFile(fileName: string): string {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const family = base.replace(/\.[^.]+$/, "").trim();
  return family || "自定义字体";
}

/**
 * 从文件名拆出中文名与英文名，导入时先自动填好、再让用户改：
 * - 中英混排各自归位（「思源黑体 SourceHanSans」→ 中文「思源黑体」、英文「SourceHanSans」）；
 * - 括号里的内容一并算进中文名（「思源黑体 (CN)」→「思源黑体 CN」）；
 * - 只有中文或只有英文时，两个框都填这份名字。
 */
export function fontNamesFromFile(fileName: string): { cn: string; en: string } {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  let name = base.replace(/\.[^.]+$/, "").trim();
  const extras: string[] = [];
  name = name
    .replace(/[（(]([^）)]*)[）)]/g, (_all, inner: string) => {
      const text = String(inner ?? "").trim();
      if (text) extras.push(text);
      return " ";
    })
    .replace(/[_\s]+/g, " ")
    .trim();

  const chinese = (name.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f]+/g) ?? []).join(" ").trim();
  const latin = name.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f]+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cn = [chinese, ...extras].filter(Boolean).join(" ").trim() || name || fontFamilyOfFile(fileName);
  const en = latin || name || fontFamilyOfFile(fileName);
  return { cn, en };
}

export function isFontFile(fileName: string): boolean {
  const lower = String(fileName ?? "").toLowerCase();
  return FONT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 合并字体目录：用户导入的排在前面（口径照旧版：选完字体后它就顶到第一位），
 * 内置的跟在后面，同名只留一条 —— 导入的优先，导入的那份带字体文件。
 */
export function mergeFontEntries(catalog: FontEntry[]): FontEntry[] {
  const merged: FontEntry[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    const family = String(entry?.family ?? "").trim();
    if (!family || seen.has(family)) continue;
    seen.add(family);
    merged.push({ ...entry, family });
  }
  for (const entry of builtinFontEntries()) {
    if (seen.has(entry.family)) continue;
    seen.add(entry.family);
    merged.push(entry);
  }
  return merged;
}

/** 校验目录里的字体名，挡住空名与超长名 */
export function sanitizeFontFamily(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const family = raw.trim();
  if (!family) return "";
  return family.slice(0, 120);
}

/** 解析外部来源（工程文件 / 磁盘）的字体目录，脏数据一律丢掉 */
export function sanitizeFontEntries(raw: unknown): FontEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FontEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const family = sanitizeFontFamily(record.family);
    if (!family) continue;
    const source = typeof record.source === "string" && record.source ? record.source : undefined;
    out.push({
      family,
      source,
      fileName: typeof record.fileName === "string" ? record.fileName : undefined,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
      builtin: record.builtin === true,
      bundled: record.bundled === true,
    });
  }
  return out;
}

/** 目录里的字体总字节数（用于提示与限额） */
export function fontCatalogBytes(catalog: FontEntry[]): number {
  return catalog.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

/** 字体显示名：用户改过的名字优先，没改过就用内置对照表，导入字体用文件名 */
export type FontLabel = { cn: string; en: string };

export function defaultFontLabel(family: string, fileName?: string): FontLabel {
  const system = SYSTEM_FONTS.find((f) => f.family === family);
  if (system) return { cn: system.cn, en: system.en };
  const parsed = fontNamesFromFile(fileName || family);
  return { cn: parsed.cn, en: parsed.en };
}
