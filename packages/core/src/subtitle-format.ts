import type { Clip, ProjectDocument } from "@jeek/contracts";

/**
 * 字幕文本格式：SRT / VTT / TXT / JSON 的解析与生成。
 *
 * 纯逻辑、不碰 DOM，界面与服务端都能用；导入时先看有没有时间轴，
 * 认不出时间码就当纯文本按行拆句。
 */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type SubtitleFormat = "srt" | "vtt" | "txt" | "json";

export interface SubtitleParseResult {
  format: SubtitleFormat;
  /** 带时间轴的字幕块；纯文本导入时为空 */
  cues: SubtitleCue[];
  /** 只有文字、没有时间轴的行 */
  plain: string[];
}

/* ------------------------------------------------------------------ 时间码 */

/** `HH:MM:SS,mmm` / `MM:SS.mmm` / `HH:MM:SS.ff` 都认，逗号与点等价 */
export function parseStamp(value: string): number {
  const cleaned = value.trim().replace(",", ".");
  const m = cleaned.match(/(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?/);
  if (!m) return 0;
  const hh = Number(m[1] ?? 0);
  const mm = Number(m[2] ?? 0);
  const ss = Number(m[3] ?? 0);
  const frac = Number((m[4] ?? "0").padEnd(3, "0"));
  return hh * 3600000 + mm * 60000 + ss * 1000 + frac;
}

/** SRT 口径的时间戳 HH:MM:SS,mmm */
export function formatStamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hh = String(Math.floor(safe / 3600000)).padStart(2, "0");
  const mm = String(Math.floor((safe % 3600000) / 60000)).padStart(2, "0");
  const ss = String(Math.floor((safe % 60000) / 1000)).padStart(2, "0");
  const mmm = String(safe % 1000).padStart(3, "0");
  return `${hh}:${mm}:${ss},${mmm}`;
}

/** 时间戳一律修成合法区间：起点不为负、终点至少比起点晚 1ms */
const normalizeCue = (cue: SubtitleCue): SubtitleCue => {
  const startMs = Math.max(0, Math.round(Number.isFinite(cue.startMs) ? cue.startMs : 0));
  const rawEnd = Math.round(Number.isFinite(cue.endMs) ? cue.endMs : 0);
  return { startMs, endMs: Math.max(startMs + 1, rawEnd), text: cue.text.trim() };
};

/* ------------------------------------------------------------------ 解析 */

const clean = (raw: string): string => raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

export function detectFormat(fileName: string, raw: string): SubtitleFormat {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "srt" || ext === "vtt" || ext === "json") return ext;
  if (ext === "txt") return "txt";
  const text = clean(raw);
  if (/^\s*\{|^\s*\[/.test(text)) return "json";
  if (/^WEBVTT/.test(text)) return "vtt";
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}/.test(text)) return "srt";
  return "txt";
}

/** 按 `-->` 切块，编号行与空块自动跳过；SRT 与 VTT 共用这一套 */
function parseTimedBlocks(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const body = text
    .split("\n")
    // VTT 的头信息与注记块不算字幕
    .filter((line) => !/^WEBVTT\b/.test(line.trim()) && !/^(NOTE|STYLE|REGION)\b/.test(line.trim()))
    .join("\n");

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;
    const timeLine = lines[timeIndex];
    const [fromPart, toPart = ""] = timeLine.split("-->");
    // 时间行后面可能跟 `align:start position:50%` 这类 VTT 设置，只取时间本身
    const to = toPart.trim().split(/\s+/)[0] ?? "";
    const content = lines.slice(timeIndex + 1).filter((line) => !/^\d+$/.test(line));
    if (!content.length) continue;
    cues.push(normalizeCue({ startMs: parseStamp(fromPart), endMs: parseStamp(to), text: content.join("\n") }));
  }
  return cues;
}

function parseJsonCues(text: string): SubtitleCue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  // 只吃数组：工程文件那种对象结构走工程载入，不在这里处理
  if (!Array.isArray(parsed)) return [];
  const cues: SubtitleCue[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const text = typeof raw.text === "string" ? raw.text : typeof raw.content === "string" ? raw.content : "";
    if (!text.trim()) continue;
    const start = raw.startMs ?? raw.start_ms;
    const end = raw.endMs ?? raw.end_ms;
    if (typeof start !== "number" || typeof end !== "number") continue;
    cues.push(normalizeCue({ startMs: start, endMs: end, text }));
  }
  return cues;
}

function plainLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\d+$/.test(line));
}

/** 四种格式统一入口：认出时间轴就用时间轴，认不出就按行拆句 */
export function parseSubtitles(raw: string, format?: SubtitleFormat, fileName = ""): SubtitleParseResult {
  const text = clean(raw).trim();
  const kind = format ?? detectFormat(fileName, text);
  if (!text) return { format: kind, cues: [], plain: [] };

  if (kind === "json") {
    const cues = parseJsonCues(text);
    return { format: kind, cues, plain: cues.length ? [] : plainLines(text) };
  }

  const cues = parseTimedBlocks(text);
  if (cues.length) return { format: kind, cues, plain: [] };
  return { format: kind, cues: [], plain: plainLines(text) };
}

/** 老调用口径：带时间轴的返回 cue 数组，纯文本返回行数组 */
export function parseSubtitleText(raw: string): SubtitleCue[] | string[] {
  const result = parseSubtitles(raw);
  return result.cues.length ? result.cues : result.plain;
}

/* ------------------------------------------------------------------ 生成 */

export function cuesFromDocument(doc: ProjectDocument): SubtitleCue[] {
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  if (!track) return [];
  return [...track.clips]
    .sort((a, b) => a.startMs - b.startMs)
    .map((clip) => ({
      startMs: clip.startMs,
      endMs: clip.endMs,
      text: String(clip.data.text ?? ""),
    }));
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${formatStamp(cue.startMs)} --> ${formatStamp(cue.endMs)}\n${cue.text}\n`)
    .join("\n");
}

export function toVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue, i) => {
      const span = `${formatStamp(cue.startMs).replace(",", ".")} --> ${formatStamp(cue.endMs).replace(",", ".")}`;
      return `${i + 1}\n${span}\n${cue.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toTxt(cues: SubtitleCue[]): string {
  return cues.map((cue) => cue.text).join("\n");
}

export function toJson(cues: SubtitleCue[]): string {
  return JSON.stringify(
    cues.map((cue) => ({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs })),
    null,
    2,
  );
}

export function buildSubtitleText(cues: SubtitleCue[], format: SubtitleFormat): string {
  if (format === "vtt") return toVtt(cues);
  if (format === "txt") return toTxt(cues);
  if (format === "json") return toJson(cues);
  return toSrt(cues);
}

export function sortedSubtitles(doc: ProjectDocument): Clip[] {
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  return track ? [...track.clips].sort((a, b) => a.startMs - b.startMs) : [];
}
