import type { Clip, Id, ProjectDocument } from "@jeek/contracts";
import { cloneDocument, findClip, nextId } from "./document.js";
import { applyRotationPlan, frameMs, quantizeMs, wordWeight } from "./edit-actions.js";
import { sortedSubtitles } from "./subtitle-format.js";

/** 编辑后把光标放回字幕列表的输入框，接着打字或继续拆分/合并都不打断 */
export interface SubtitleEditResult {
  doc: ProjectDocument;
  focusId: Id;
  caret: number;
}

const textOf = (clip: Clip): string => String(clip.data.text ?? "");

/** 把一条字幕替换成 0~2 条，其余轨道原样保留 */
function replaceSubtitle(doc: ProjectDocument, clipId: Id, replacements: Clip[]): ProjectDocument {
  const next = cloneDocument(doc);
  next.tracks = next.tracks.map((track) => {
    if (!track.clips.some((c) => c.id === clipId)) return track;
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.id === clipId) clips.push(...replacements);
      else clips.push(clip);
    }
    return { ...track, clips };
  });
  return next;
}

/**
 * 字幕列表：在光标位置把一条字幕拆成两条端点相接的字幕。
 * 时长按字数权重分配并量化到帧，左侧至少一帧、右侧至少一帧（照旧版 splitTextAt）。
 */
export function splitSubtitleAt(doc: ProjectDocument, clipId: Id, pos: number): SubtitleEditResult | null {
  const found = findClip(doc, clipId);
  if (!found || found.clip.kind !== "subtitle") return null;
  const { clip } = found;
  const text = textOf(clip);
  // 光标必须真的落在文字中间（旧版由输入框先判 0 < pos < len，这里兜住直接调用）
  if (pos <= 0 || pos >= text.length) return null;
  const cut = Math.max(1, Math.min(text.length - 1, pos));
  const leftText = text.slice(0, cut);
  const rightText = text.slice(cut);
  if (!leftText.trim() || !rightText.trim()) return null;

  const fps = doc.video.fps || 30;
  const fm = frameMs(fps);
  const ratio = wordWeight(leftText) / wordWeight(text);
  let at = quantizeMs(clip.startMs + (clip.endMs - clip.startMs) * ratio, fps);
  at = Math.max(clip.startMs + fm, Math.min(clip.endMs - fm, at));
  if (at <= clip.startMs || at >= clip.endMs) return null;

  const left: Clip = { ...clip, data: { ...clip.data, text: leftText }, endMs: at };
  const right: Clip = {
    ...clip,
    id: nextId("sub"),
    data: { ...clip.data, text: rightText },
    startMs: at,
  };
  return { doc: applyRotationPlan(replaceSubtitle(doc, clipId, [left, right])), focusId: right.id, caret: 0 };
}

/** 合并相邻两条：文字首尾相接、时间横跨两条（含中间真空），保留前一条的 id 作为焦点 */
function mergePair(doc: ProjectDocument, clipId: Id, withNext: boolean): SubtitleEditResult | null {
  const found = findClip(doc, clipId);
  if (!found || found.clip.kind !== "subtitle") return null;
  const sorted = sortedSubtitles(doc);
  const at = sorted.findIndex((c) => c.id === clipId);
  const otherIndex = withNext ? at + 1 : at - 1;
  if (at < 0 || otherIndex < 0 || otherIndex >= sorted.length) return null;

  const first = withNext ? sorted[at] : sorted[otherIndex];
  const second = withNext ? sorted[otherIndex] : sorted[at];
  const caret = textOf(first).length;
  const merged: Clip = {
    ...first,
    data: { ...first.data, text: textOf(first) + textOf(second) },
    startMs: Math.min(first.startMs, second.startMs),
    endMs: Math.max(first.endMs, second.endMs),
  };
  const next = replaceSubtitle(doc, first.id, [merged]);
  const tracks = next.tracks.map((track) =>
    track.clips.some((c) => c.id === second.id)
      ? { ...track, clips: track.clips.filter((c) => c.id !== second.id) }
      : track,
  );
  return { doc: applyRotationPlan({ ...next, tracks }), focusId: merged.id, caret };
}

/** 字幕列表：光标在开头按 Backspace，与上一条合并 */
export const mergeSubtitleWithPrev = (doc: ProjectDocument, clipId: Id): SubtitleEditResult | null =>
  mergePair(doc, clipId, false);

/** 字幕列表：光标在末尾按 Delete，与下一条合并 */
export const mergeSubtitleWithNext = (doc: ProjectDocument, clipId: Id): SubtitleEditResult | null =>
  mergePair(doc, clipId, true);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 查找替换面板的实时匹配数：按「处」计数，一条字幕里出现多次算多处 */
export function countMatches(doc: ProjectDocument, find: string, caseSensitive: boolean): number {
  if (!find) return 0;
  const re = new RegExp(escapeRegExp(find), caseSensitive ? "g" : "gi");
  let count = 0;
  for (const clip of sortedSubtitles(doc)) {
    count += (textOf(clip).match(re) ?? []).length;
  }
  return count;
}

/** 替换全部字幕文本，返回替换处数；无匹配时返回原文档 */
export function replaceSubtitleText(
  doc: ProjectDocument,
  find: string,
  replacement: string,
  caseSensitive: boolean,
): { doc: ProjectDocument; count: number } {
  const count = countMatches(doc, find, caseSensitive);
  if (!find || count === 0) return { doc, count: 0 };
  const re = new RegExp(escapeRegExp(find), caseSensitive ? "g" : "gi");
  const next = cloneDocument(doc);
  next.tracks = next.tracks.map((track) =>
    track.kind === "subtitle"
      ? {
          ...track,
          clips: track.clips.map((clip) => ({
            ...clip,
            data: { ...clip.data, text: textOf(clip).replace(re, replacement) },
          })),
        }
      : track,
  );
  return { doc: next, count };
}

/** 播放时列表高亮的当前句：播放头落在这条的 [start, end) 区间内才高亮（照旧版帧循环） */
export function activeSubtitleId(doc: ProjectDocument, playheadMs: number): Id | null {
  let active: Id | null = null;
  for (const clip of sortedSubtitles(doc)) {
    if (playheadMs >= clip.startMs && playheadMs < clip.endMs) active = clip.id;
  }
  return active;
}
