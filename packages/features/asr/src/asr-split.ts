/**
 * 语音识别结果 → 瀑布流字幕块。
 * 纯计算模块：不依赖 Electron / 浏览器 API，落轨与回归共用同一份实现。
 */

export interface SrtEntry {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitlePiece {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  enterAnimation: string;
  moveAnimation: string;
}

export interface BuildOptions {
  maxChars?: number;
  maxMs?: number;
  minMs?: number;
  fps?: number;
  leadMs?: number;
  tailMs?: number;
}

// 句末标点：优先在这里断句；句中标点次之。
const END_PUNCT = new Set(Array.from("。！？!?；;"));
const MID_PUNCT = new Set(Array.from("，,、：:…—～~"));
// 所有标点最终都不出现在字幕里（英文词之间的空格保留，不是标点）。
// 只含直引号（" 与 '）：弯引号照旧版保留在字幕里，不做删除。
const ALL_PUNCT = new Set(
  Array.from(".,;:!?，。、；：！？…—～~\"'\"'（）()《》【】[]{}<>+/\\|_@#$%^&*=-"),
);

// 连词 / 转折 / 承接：适合作为「语义断点」，在它前面断行不会把半个短语劈开。
const CONNECTORS = [
  "但是", "可是", "不过", "然而", "而且", "并且", "然后", "所以", "因为", "如果",
  "虽然", "尽管", "接着", "于是", "另外", "还有", "就是", "其实", "结果", "后来",
  "那么", "这样", "这时候", "因此", "再说", "也就是说", "除此之外", "与此同时",
  "接下来", "事实上", "换句话说", "这样一来", "一方面", "另一方面",
];
// 语气词 / 助词：适合在它后面断行。
const PARTICLES = new Set(Array.from("了的呢吧啊嘛吗呀哦嗯哈呗"));

const isCjk = (ch: string) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(ch);
const isLatin = (ch: string) => /[A-Za-z0-9]/u.test(ch);

/** 去标点；中英交界补一个空格，避免「hello大家好」挤成一团。 */
export function cleanSegment(chars: string[]): string {
  let out = "";
  let prev = "";
  for (const ch of chars) {
    if (ALL_PUNCT.has(ch)) continue; // 标点直接去掉，不在中文之间制造空格
    if (/\s/u.test(ch)) {
      if (out && !out.endsWith(" ")) out += " ";
      prev = " ";
      continue;
    }
    if (out && !out.endsWith(" ") && ((isCjk(prev) && isLatin(ch)) || (isLatin(prev) && isCjk(ch)))) {
      out += " ";
    }
    out += ch;
    prev = ch;
  }
  return out.replace(/\s+/gu, " ").trim();
}

/** 显示字数：空格不计，英文整串按字符计（与用户看到的「几个字」直觉一致）。 */
export const displayLen = (s: string): number =>
  Array.from(s).filter((ch) => !/\s/u.test(ch)).length;

/**
 * 断点打分。pos 表示「在 chars[pos] 之前断开」。
 * 分数越高越适合断句；同分时靠后的断点优先，避免碎句。
 */
function boundaryScore(chars: string[], pos: number): number {
  if (pos <= 0 || pos >= chars.length) return -1;
  const before = chars[pos - 1];
  const after = chars[pos];
  let score = 0;
  if (END_PUNCT.has(before)) score = 120;
  else if (MID_PUNCT.has(before)) score = 95;
  else {
    const tail = chars.slice(pos, pos + 6).join("");
    for (const w of CONNECTORS) {
      if (tail.startsWith(w)) {
        score = 70 + w.length;
        break;
      }
    }
    if (!score && PARTICLES.has(before)) score = 45;
    if (!score && ((isCjk(before) && isLatin(after)) || (isLatin(before) && isCjk(after)))) score = 32;
    if (!score && /\s/u.test(before)) score = 24;
  }
  return score;
}

/**
 * 把一句超长文本切成若干段。断句点按「标点 > 连词 > 语气词 > 中英边界 > 硬切」
 * 依次降级，并且只在 [minChars, maxChars] 区间里挑，切出来的每段都不会过短或过长。
 */
function splitLong(chars: string[], maxChars: number, minChars: number): string[][] {
  const parts: string[][] = [];
  let start = 0;
  while (chars.length - start > maxChars) {
    const remain = chars.length - start;
    // 切完只剩一两个字的尾巴时，宁可整段略长一点，也不切出「录屏中 / 断」这种碎句
    if (remain - maxChars < minChars) break;
    const hi = Math.min(maxChars, remain - minChars);
    let best = -1;
    let bestScore = -1;
    for (let i = minChars; i <= hi; i += 1) {
      const pos = start + i;
      const s = boundaryScore(chars, pos) + (i / maxChars) * 18;
      if (s >= bestScore) {
        bestScore = s;
        best = i; // 同分取更靠后的断点
      }
    }
    if (best < 0) best = hi;
    parts.push(chars.slice(start, start + best));
    start += best;
  }
  if (start < chars.length) parts.push(chars.slice(start));

  // 尾巴只剩一两个字时并回上一段，前提是并完仍不超上限
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    if (
      displayLen(cleanSegment(last)) < minChars &&
      displayLen(cleanSegment(prev)) + displayLen(cleanSegment(last)) <= maxChars
    ) {
      parts.splice(parts.length - 2, 2, prev.concat(last));
    }
  }
  return parts;
}

interface Piece {
  text: string;
  natural: boolean;
}

/** 先把识别文本按句末标点拆成自然句，短句独立成条，长句再细分。 */
export function segmentText(raw: string, maxChars: number, minChars: number): Piece[] {
  const chars = Array.from(raw);
  const sentences: string[][] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (END_PUNCT.has(chars[i])) {
      sentences.push(chars.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < chars.length) sentences.push(chars.slice(start));

  // natural = 由句末标点切出来的完整短句；只有硬切出来的碎片才允许后续并回相邻条
  const pieces: Piece[] = [];
  const pushNatural = (sentence: string[]) => {
    const text = cleanSegment(sentence);
    if (!text) return;
    if (displayLen(text) < 2) return; // 单个语气词，不单独成条
    pieces.push({ text, natural: true });
  };
  for (const sentence of sentences) {
    if (displayLen(cleanSegment(sentence)) <= maxChars) {
      // 一句话本来就很短：正常一条字幕，不跟邻居硬凑
      pushNatural(sentence);
      continue;
    }
    // 长句：在整句范围内找最佳断点。boundaryScore 会优先落在句中标点之后、
    // 连词之前、语气词之后，最后才按字数硬切，切出来每段长度也更均衡。
    for (const part of splitLong(sentence, maxChars, minChars)) {
      const text = cleanSegment(part);
      if (text) pieces.push({ text, natural: false });
    }
  }
  return pieces;
}

/** 解析标准 SRT（含引擎 --srt 输出的 HH:MM:SS,mmm 格式）。 */
export function parseSrt(text: string): SrtEntry[] {
  const out: SrtEntry[] = [];
  const blocks = String(text || "").replace(/\r/g, "").trim().split(/\n\s*\n/);
  const clock = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
    if (!m) return null;
    return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));
  };
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const startMs = clock(a ?? "");
    const endMs = clock(b ?? "");
    if (startMs === null || endMs === null) continue;
    const body = lines.slice(ti + 1).join(" ").trim();
    if (body) out.push({ startMs, endMs, text: body });
  }
  return out.filter((e) => e.endMs > e.startMs);
}

/**
 * 把 SRT 条目转成瀑布流字幕块。
 * 规则：去标点、短句成一条、长句按标点/语义断行、字数与时长上限、
 *       +80ms 早出晚收、帧对齐、端点相接不重叠、空句过滤。
 */
export function buildSubtitles(entries: SrtEntry[], opts: BuildOptions = {}): SubtitlePiece[] {
  const {
    maxChars = 14,
    maxMs = 4500,
    minMs = 600,
    fps = 30,
    leadMs = 80,
    tailMs = 80,
  } = opts;
  const frameMs = 1000 / Math.max(1, fps);
  const quant = (ms: number) => Math.round(ms / frameMs) * frameMs;
  const minChars = Math.max(2, Math.min(6, Math.floor(maxChars / 3)));
  const out: { text: string; natural: boolean; startMs: number; endMs: number }[] = [];

  for (const entry of entries) {
    const pieces = segmentText(entry.text, maxChars, minChars);
    if (!pieces.length) continue;
    const weights = pieces.map((p) => Math.max(1, displayLen(p.text)));
    const total = weights.reduce((a, b) => a + b, 0);
    const span = entry.endMs - entry.startMs;
    let cursor = entry.startMs;
    for (let i = 0; i < pieces.length; i += 1) {
      const isFirst = i === 0;
      const isLast = i === pieces.length - 1;
      let end = isLast ? entry.endMs : cursor + (span * weights[i]) / total;
      let start = cursor;
      // 字幕早出一点、晚收一点，跟口型更自然；段内仍保持端点相接
      if (isFirst) start = Math.max(0, start - leadMs);
      if (isLast) end += tailMs;
      out.push({ text: pieces[i].text, natural: pieces[i].natural, startMs: start, endMs: end });
      cursor = end;
    }
  }

  // VAD 强制分段可能正好切在词中间，留下「问题」「断」这类两三字碎片；
  // 时间相接且并回去不会明显超长时，并回上一条，宁可略长也不要气泡。
  const merged: { text: string; natural: boolean; startMs: number; endMs: number }[] = [];
  for (const item of out) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !item.natural &&
      displayLen(item.text) < minChars &&
      displayLen(prev.text) + displayLen(item.text) <= maxChars + 4 &&
      Math.abs(prev.endMs - item.startMs) < 300
    ) {
      prev.text += item.text;
      prev.endMs = item.endMs;
      continue;
    }
    merged.push({ ...item });
  }

  // 全局整理：帧对齐、去重叠、最小时长、编号与默认样式
  const result: SubtitlePiece[] = [];
  let prevEnd = 0;
  for (const item of merged) {
    const s = quant(Math.max(item.startMs, prevEnd));
    let e = quant(item.endMs);
    if (e <= s) e = s + frameMs;
    if (e - s > maxMs) e = s + maxMs; // 单条最长时长兜底
    if (e - s < minMs) e = Math.max(s + minMs, e);
    result.push({
      id: result.length + 1,
      text: item.text,
      startMs: Math.round(s),
      endMs: Math.round(e),
      fontSize: 60,
      fontFamily: "Microsoft YaHei",
      color: "#ffffff",
      enterAnimation: "scale",
      moveAnimation: "up",
    });
    prevEnd = e;
  }
  return result;
}
