import {
  cloneDocument,
  durationOf,
  findClip,
  nextId,
  type ClipInput,
} from "./document.js";
import { buildMovePlan } from "./move-plan.js";
import type { Clip, Id, Millis, ProjectDocument } from "@jeek/contracts";

/* ---------------------------------------------------------------- 时间量化与时间码 */

/** 帧级量化：所有写进工程的时间都过这一道，避免浮点数尾巴 */
export const quantizeMs = (ms: Millis, fps: number): Millis => {
  const frame = 1000 / (fps || 30);
  const value = Math.round(ms / frame) * frame;
  // 整数毫秒不该带 1000.0000000000001 这类浮点尾巴
  return Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
};

export const frameOf = (ms: Millis, fps: number): number =>
  Math.round((ms * fps) / 1000);

export const frameMs = (fps: number): Millis => 1000 / (fps || 30);

/** 时:分:秒.帧，末位按帧率进制，不写死两位小数 */
export function fmtTimecode(ms: Millis, fps: number): string {
  const safe = Math.max(0, ms);
  const total = Math.round((safe * fps) / 1000);
  const perSecond = Math.max(1, Math.round(fps));
  const frames = total % perSecond;
  const seconds = Math.floor(total / perSecond);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(frames)}`;
}

/** 供界面显示的毫秒：固定 3 位小数，不出现 1000.0000000000001 */
export const fmtMs = (ms: Millis): string => Number(ms.toFixed(3)).toString();

/** 中文一字 1 权重，英文/数字两字符折算 1 个字，空白不计 */
export function wordWeight(text: string): number {
  let weight = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (/[\u4e00-\u9fff]/.test(ch)) {
      weight += 1;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      latin += 1;
    } else {
      weight += 0.5;
    }
  }
  return Math.max(1, weight + latin / 2);
}

/* ---------------------------------------------------------------- 选中与设置 */

export function setSelection(doc: ProjectDocument, clipIds: Id[]): ProjectDocument {
  const next = cloneDocument(doc);
  next.selection = { clips: [...new Set(clipIds)], tracks: [] };
  return next;
}

export function setSetting(
  doc: ProjectDocument,
  key: string,
  value: unknown,
): ProjectDocument {
  const next = cloneDocument(doc);
  next.settings = { ...next.settings, [key]: value };
  return next;
}

export function setVideoConfig(
  doc: ProjectDocument,
  patch: Partial<ProjectDocument["video"]>,
): ProjectDocument {
  const next = cloneDocument(doc);
  next.video = { ...next.video, ...patch };
  return next;
}

/* ---------------------------------------------------------------- 片段增删改 */

export function insertClip(
  doc: ProjectDocument,
  trackId: Id,
  input: ClipInput,
): ProjectDocument {
  const next = cloneDocument(doc);
  const track = next.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`轨道不存在：${trackId}`);
  const fps = next.video.fps;
  const clip: Clip = {
    id: input.id ?? nextId("clip"),
    trackId,
    kind: input.kind,
    startMs: quantizeMs(input.startMs, fps),
    endMs: quantizeMs(input.endMs, fps),
    inMs: input.inMs ?? 0,
    assetId: input.assetId,
    data: input.data ?? {},
    effects: input.effects ?? [],
  };
  if (clip.endMs <= clip.startMs) clip.endMs = clip.startMs + frameMs(fps);
  // 音频片段入场时把「完整源区间」记下来：之后裁剪只改卡片，源区间不动，
  // 于是拖回去只能恢复自己被剪掉的那一段，不会去吃别的卡片的内容
  if (clip.kind === "audio") {
    clip.data = withSourceRange(clip.data, clip.inMs, clip.inMs + (clip.endMs - clip.startMs));
  }
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

/** 一条字幕该占多久：按去空白后的字数估，短句至少 1.2 秒 */
export function estimateSubtitleDurationMs(text: string): number {
  const chars = (text || "").replace(/\s/g, "").length;
  if (chars === 0) return 1000;
  return Math.max(800, Math.round(220 * chars));
}

/**
 * 轨道卡片不重叠是硬约束：按起点排序后，后一张的起点不得早于前一张的终点。
 * 任何一条轨道都过这道收口，将来加新字幕轨也自动带上这条不变量。
 */
function enforceNoOverlap(doc: ProjectDocument): ProjectDocument {
  for (const track of doc.tracks) {
    const min = frameMs(doc.video.fps);
    const list = [...track.clips].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let cursor = 0;
    const out: Clip[] = [];
    for (const clip of list) {
      const startMs = Math.max(0, clip.startMs, cursor);
      const endMs = Math.max(clip.endMs, startMs + min);
      out.push({ ...clip, startMs, endMs });
      cursor = endMs;
    }
    track.clips = out;
  }
  return doc;
}

/**
 * 在播放头插入一条字幕，任何情况下都不允许卡片互相重叠。
 * - 播放头落在某条字幕中间：以播放头为界把旧卡截短，剩下的时间段就是新字幕。
 * - 播放头落在两张卡片之间、且空隙很短（放不下一条按字数预估的新字幕）：
 *   新字幕只填满这段空隙，后卡时长保持不动，由用户自己拖边缘微调。
 * - 播放头落在空隙里但空隙足够，或恰好压在后卡起点：后一张剪短一半，
 *   腾出来的前半段连同空隙一起给新字幕。
 * - 播放头落在某条字幕的最后一帧上：视作接在这张卡之后，避免把刚加的卡压成碎片。
 * - 后面没有卡片：按文本字数预估时长向后占用。
 */
export function insertSubtitleAt(
  doc: ProjectDocument,
  atMs: Millis,
  text: string,
  style: Record<string, unknown> = {},
): { doc: ProjectDocument; startMs: Millis; endMs: Millis } {
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  if (!track) return { doc, startMs: atMs, endMs: atMs };
  const fps = doc.video.fps;
  const min = frameMs(fps);
  const at = quantizeMs(Math.max(0, atMs), fps);
  const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  const inside = sorted.find((c) => c.startMs < at && c.endMs > at);
  const atTail = inside ? inside.endMs - at <= min + 1e-6 : false;
  const anchor = inside && atTail ? inside.endMs : at;

  const next = cloneDocument(doc);
  const clips = next.tracks.find((t) => t.id === track.id)!.clips;
  const start = anchor;
  let end: Millis;

  if (inside && !atTail) {
    // 卡内插入：旧卡截到播放头，后半段归新字幕
    const old = clips.find((c) => c.id === inside.id)!;
    end = old.endMs;
    old.endMs = start;
  } else {
    // 两张卡之间 / 尾帧：找锚点之后的第一张卡，短空隙只填空隙、否则从它左端剪一半
    const following = [...clips]
      .sort((a, b) => a.startMs - b.startMs)
      .find((c) => c.startMs >= anchor - 1e-6);
    if (!following) {
      end = quantizeMs(start + Math.max(1200, estimateSubtitleDurationMs(text)), fps);
    } else {
      const gap = following.startMs - anchor;
      const wanted = Math.max(1200, estimateSubtitleDurationMs(text));
      if (gap > 1e-6 && gap < wanted) {
        // 空隙很短：只填满空隙，后卡时长一点不动，留给用户自己拖边缘调长度。
        // gap<=0（贴在后卡起点）不算「空隙里」，仍走下面的正常规则。
        end = quantizeMs(following.startMs, fps);
      } else {
        // 空隙足够放下一整条新字幕 / 贴在后卡起点：把后卡左端切掉一半
        const duration = following.endMs - following.startMs;
        const half = Math.round(duration / 2 / min) * min;
        const needForNew = Math.max(0, min - gap);
        const maxCut = Math.max(0, duration - min);
        const cut = Math.min(maxCut, Math.max(min, half, needForNew));
        end = quantizeMs(following.startMs + cut, fps);
        following.startMs = end;
        if (end - start < min) {
          // 后卡短到连一帧都腾不出：整段让给新字幕，仍由收口函数保证不重叠
          end = quantizeMs(start + min, fps);
          following.startMs = end;
        }
      }
    }
  }

  const id = nextId("clip");
  const inserted = insertClip(next, track.id, {
    id,
    kind: "subtitle",
    startMs: start,
    endMs: end,
    data: { text, ...style },
  });
  enforceNoOverlap(inserted);
  // 返回真正写进工程的帧对齐端点，界面据此移动播放头，避免落回新卡内部
  const made = inserted.tracks
    .find((t) => t.id === track.id)
    ?.clips.find((c) => c.id === id);
  return {
    doc: setSelection(inserted, []),
    startMs: made?.startMs ?? start,
    endMs: made?.endMs ?? end,
  };
}

export function patchClip(
  doc: ProjectDocument,
  clipId: Id,
  patch: Record<string, unknown>,
): ProjectDocument {
  const next = cloneDocument(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  Object.assign(hit.clip.data, patch);
  hit.track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

export function deleteClips(doc: ProjectDocument, ids: Id[]): ProjectDocument {
  const next = cloneDocument(doc);
  const set = new Set(ids);
  for (const track of next.tracks) {
    track.clips = track.clips.filter((c) => !set.has(c.id));
  }
  next.selection.clips = next.selection.clips.filter((id) => !set.has(id));
  return next;
}

/**
 * 整体平移的允许区间：按各自轨道找最近的前/后未移动卡片，
 * 任何一张移动中的卡片都不许压到未移动卡片，也不许被推出 0 点之前。
 */
export function dragBounds(doc: ProjectDocument, ids: Id[]): { lo: Millis; hi: Millis } {
  const moving = new Set(ids);
  let lo = -Infinity;
  let hi = Infinity;
  for (const track of doc.tracks) {
    const list = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < list.length; i += 1) {
      const clip = list[i];
      if (!moving.has(clip.id)) continue;
      let prev: Clip | null = null;
      let next: Clip | null = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (!moving.has(list[j].id)) { prev = list[j]; break; }
      }
      for (let j = i + 1; j < list.length; j += 1) {
        if (!moving.has(list[j].id)) { next = list[j]; break; }
      }
      lo = Math.max(lo, (prev ? prev.endMs : 0) - clip.startMs, -clip.startMs);
      if (next) hi = Math.min(hi, next.startMs - clip.endMs);
    }
  }
  return { lo, hi: Math.max(lo, hi) };
}

/** 选中片段整体平移；任一卡片压到未移动卡片就整组拦住 */
export function moveClips(
  doc: ProjectDocument,
  ids: Id[],
  deltaMs: Millis,
): { doc: ProjectDocument; applied: Millis } {
  const fps = doc.video.fps;
  const moving = new Set(ids);
  const hasMoving = doc.tracks.some((t) => t.clips.some((c) => moving.has(c.id)));
  if (!hasMoving) return { doc, applied: 0 };

  const { lo, hi } = dragBounds(doc, ids);
  const applied = quantizeMs(Math.max(lo, Math.min(hi, deltaMs)), fps);
  if (applied === 0) return { doc, applied: 0 };

  const next = cloneDocument(doc);
  for (const track of next.tracks) {
    for (const clip of track.clips) {
      if (!moving.has(clip.id)) continue;
      const length = clip.endMs - clip.startMs;
      clip.startMs = Math.max(0, clip.startMs + applied);
      clip.endMs = clip.startMs + length;
    }
    track.clips.sort((a, b) => a.startMs - b.startMs);
  }
  return { doc: next, applied };
}

export type TrimEdge = "start" | "end" | "junction";

/**
 * 音频片段的「源区间」：卡片被创建 / 切分时记下的**完整源范围**（源内毫秒）。
 * 裁剪只改卡片自己的 startMs/endMs/inMs，这两个数不动 —— 所以把裁掉的部分拖回来时，
 * 只能恢复**自己曾经被剪掉**的那一段，不会去吃同一段音频里别人的内容。
 */
export interface SourceRange {
  from: number;
  to: number;
}

export function clipSourceRange(clip: Clip): SourceRange {
  const data = (clip.data ?? {}) as Record<string, unknown>;
  const dur = Math.max(0, clip.endMs - clip.startMs);
  const rawFrom = Number(data.sourceStartMs);
  const rawTo = Number(data.sourceEndMs);
  const from = Number.isFinite(rawFrom) ? rawFrom : clip.inMs;
  const to = Number.isFinite(rawTo) ? rawTo : clip.inMs + dur;
  // 老工程没有这两个数：退回「就是当前卡片这一段」，表现是不能再往外拖
  return {
    from: Math.min(from, clip.inMs),
    to: Math.max(to, clip.inMs + dur),
  };
}

/** 写进片段 data 的源区间（创建 / 切分时调用） */
export function withSourceRange(
  data: Record<string, unknown> | undefined,
  from: number,
  to: number,
): Record<string, unknown> {
  return { ...(data ?? {}), sourceStartMs: from, sourceEndMs: to };
}

/** 右端还能往右恢复多少源内容；字幕没有源概念 */
function roomToSourceEnd(clip: Clip): number {
  if (clip.kind !== "audio") return Infinity;
  return Math.max(0, clipSourceRange(clip).to - (clip.inMs + (clip.endMs - clip.startMs)));
}

/** 左端还能往左恢复多少源内容；字幕没有源概念 */
function roomToSourceStart(clip: Clip): number {
  if (clip.kind !== "audio") return Infinity;
  return Math.max(0, clip.inMs - clipSourceRange(clip).from);
}

/** 某个边缘允许落在哪一段区间里（lo / hi 都是该边缘的时间位置） */
export interface TrimRange {
  lo: number;
  hi: number;
}

/**
 * 拖动预览与真正裁剪共用同一份边界，避免「看到能拖、松手又被打回」。
 *
 * 相邻两张音频卡片调分界时，这个动作必须能拆成两张卡片各自独立的操作：
 * - 往右：左卡要能往右延长（它自己被剪掉的源结尾还有余量），右卡缩左边总是成立；
 * - 往左：右卡要能往左延长（它自己被剪掉的源开头还有余量），左卡缩右边总是成立。
 * 两个方向各自只看对应那张卡有没有恢复余量 —— 都到极限时分界一动不动。
 */
export function trimRange(
  doc: ProjectDocument,
  clipId: Id,
  edge: TrimEdge,
  neighborId?: Id,
): TrimRange | null {
  const hit = findClip(doc, clipId);
  if (!hit) return null;
  const { clip, track } = hit;
  const min = frameMs(doc.video.fps);
  const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  const idx = sorted.findIndex((c) => c.id === clipId);

  if (edge === "junction") {
    const neighbor = neighborId ? track.clips.find((c) => c.id === neighborId) : undefined;
    if (!neighbor) return null;
    const boundary = clip.endMs;
    const lo = Math.max(clip.startMs + min, boundary - roomToSourceStart(neighbor));
    const hi = Math.min(neighbor.endMs - min, boundary + roomToSourceEnd(clip));
    return { lo, hi };
  }
  if (edge === "start") {
    const prevEnd = idx > 0 ? sorted[idx - 1].endMs : 0;
    return {
      lo: Math.max(prevEnd, clip.startMs - roomToSourceStart(clip)),
      hi: clip.endMs - min,
    };
  }
  const nextStart = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1].startMs : Infinity;
  return {
    lo: clip.startMs + min,
    hi: Math.min(nextStart, clip.endMs + roomToSourceEnd(clip)),
  };
}

/**
 * 裁剪卡片：字幕只改 start/end；音频左端同步推进 inMs，右端只在本卡片的源区间内伸缩。
 * junction 表示两张相连卡片的分界，一边延长另一边缩短。
 */
export function trimClip(
  doc: ProjectDocument,
  clipId: Id,
  edge: TrimEdge,
  deltaMs: Millis,
  neighborId?: Id,
): ProjectDocument {
  const fps = doc.video.fps;
  const next = cloneDocument(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  const { clip, track } = hit;
  const range = trimRange(next, clipId, edge, neighborId);
  if (!range) return next;
  const d = quantizeMs(deltaMs, fps);
  const clamp = (value: number) =>
    range.lo > range.hi ? range.lo : Math.max(range.lo, Math.min(range.hi, value));

  if (edge === "junction" && neighborId) {
    const neighbor = track.clips.find((c) => c.id === neighborId);
    if (!neighbor) return next;
    const boundary = clip.endMs;
    const newBoundary = clamp(boundary + d);
    const shift = newBoundary - boundary;
    clip.endMs = newBoundary;
    neighbor.startMs = newBoundary;
    // 右卡起点跟着分界走时，源内偏移同步平移，波形与声音才不会跳
    if (neighbor.kind === "audio") neighbor.inMs = Math.max(0, neighbor.inMs + shift);
    track.clips.sort((a, b) => a.startMs - b.startMs);
    return next;
  }

  if (edge === "start") {
    const at = clamp(clip.startMs + d);
    const applied = at - clip.startMs;
    clip.startMs = at;
    // 只有音频左端要同步推进源内偏移；字幕的 inMs 不参与渲染
    if (clip.kind === "audio") clip.inMs += applied;
  } else {
    clip.endMs = clamp(clip.endMs + d);
  }
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

/** 切分：返回后半段 id，界面据此默认选中后半卡片 */
export function splitClip(
  doc: ProjectDocument,
  clipId: Id,
  atMs: Millis,
): { doc: ProjectDocument; secondId: Id | null } {
  const hit = findClip(doc, clipId);
  if (!hit) return { doc, secondId: null };
  const fps = doc.video.fps;
  const at = quantizeMs(atMs, fps);
  const min = frameMs(fps);
  if (at <= hit.clip.startMs + min || at >= hit.clip.endMs - min) {
    return { doc, secondId: null };
  }
  const next = cloneDocument(doc);
  const target = findClip(next, clipId)!;
  const original = target.clip;
  const secondId = nextId("clip");
  const isAudio = original.kind === "audio";
  /** 切分点处的源内位置：两半各自继承一段源区间，谁都不能越过切分点去拿对方的内容 */
  const splitIn = original.inMs + (at - original.startMs);
  const src = isAudio ? clipSourceRange(original) : null;
  const second: Clip = {
    ...structuredClone(original),
    id: secondId,
    startMs: at,
    inMs: isAudio ? splitIn : 0,
  };
  original.endMs = at;
  if (src) {
    original.data = withSourceRange(original.data, src.from, splitIn);
    second.data = withSourceRange(second.data, splitIn, src.to);
  }
  target.track.clips.push(second);
  target.track.clips.sort((a, b) => a.startMs - b.startMs);
  next.selection.clips = [secondId];
  return { doc: next, secondId };
}

/** 切分同时作用字幕与音频：播放头落在哪些卡片内就一起切 */
export function splitAllAt(doc: ProjectDocument, atMs: Millis): ProjectDocument {
  const fps = doc.video.fps;
  const at = quantizeMs(atMs, fps);
  const next = cloneDocument(doc);
  const born: Id[] = [];
  for (const track of next.tracks) {
    for (const clip of [...track.clips]) {
      if (clip.startMs >= at || clip.endMs <= at) continue;
      if (at - clip.startMs < frameMs(fps) || clip.endMs - at < frameMs(fps)) continue;
      const secondId = nextId("clip");
      const splitIn = clip.kind === "audio" ? clip.inMs + (at - clip.startMs) : 0;
      const src = clip.kind === "audio" ? clipSourceRange(clip) : null;
      const second: Clip = {
        ...structuredClone(clip),
        id: secondId,
        startMs: at,
        inMs: splitIn,
      };
      clip.endMs = at;
      if (src) {
        clip.data = withSourceRange(clip.data, src.from, splitIn);
        second.data = withSourceRange(second.data, splitIn, src.to);
      }
      track.clips.push(second);
      born.push(secondId);
    }
    track.clips.sort((a, b) => a.startMs - b.startMs);
  }
  next.selection.clips = born;
  return next;
}

/** 拆句按字数分配时长：把一段文本按行/标点拆成多条，总时长不变 */
export function splitTextIntoClips(
  doc: ProjectDocument,
  trackId: Id,
  clipId: Id,
  pieces: string[],
): ProjectDocument {
  const hit = findClip(doc, clipId);
  if (!hit || pieces.length < 2) return doc;
  const fps = doc.video.fps;
  const total = hit.clip.endMs - hit.clip.startMs;
  const weights = pieces.map(wordWeight);
  const sum = weights.reduce((a, b) => a + b, 0);
  const next = cloneDocument(doc);
  const target = findClip(next, clipId)!;
  const { clip } = target;
  const start = clip.startMs;
  const template = structuredClone(clip);
  target.track.clips = target.track.clips.filter((c) => c.id !== clipId);
  let cursor = start;
  const created: Clip[] = [];
  pieces.forEach((text, i) => {
    const span = i === pieces.length - 1 ? start + total - cursor : (total * weights[i]) / sum;
    const end = quantizeMs(Math.min(start + total, cursor + span), fps);
    created.push({
      ...structuredClone(template),
      id: nextId("clip"),
      startMs: quantizeMs(cursor, fps),
      endMs: Math.max(quantizeMs(cursor, fps) + frameMs(fps), end),
      data: { ...template.data, text },
    });
    cursor = end;
  });
  target.track.clips.push(...created);
  target.track.clips.sort((a, b) => a.startMs - b.startMs);
  next.selection.clips = [];
  return next;
}

/** 并句：合并选中片段的文本，时间取首尾 */
export function mergeClips(doc: ProjectDocument, ids: Id[]): ProjectDocument {
  if (ids.length < 2) return doc;
  const next = cloneDocument(doc);
  const set = new Set(ids);
  for (const track of next.tracks) {
    const chosen = track.clips.filter((c) => set.has(c.id));
    if (chosen.length < 2) continue;
    chosen.sort((a, b) => a.startMs - b.startMs);
    const first = chosen[0];
    const last = chosen[chosen.length - 1];
    const merged: Clip = {
      ...structuredClone(first),
      endMs: last.endMs,
      data: { ...first.data, text: chosen.map((c) => String(c.data.text ?? "")).join("") },
    };
    track.clips = track.clips.filter((c) => !set.has(c.id));
    track.clips.push(merged);
    track.clips.sort((a, b) => a.startMs - b.startMs);
    next.selection.clips = [merged.id];
    break;
  }
  return next;
}

/** 自动填充空隙：把每条字幕的右端延长到下一条的起点，不动音频、不移动任何卡片 */
export function fillGaps(doc: ProjectDocument, trackId: Id): { doc: ProjectDocument; filled: number } {
  const next = cloneDocument(doc);
  let filled = 0;
  const track = next.tracks.find((t) => t.id === trackId);
  if (!track) return { doc: next, filled };
  track.clips.sort((a, b) => a.startMs - b.startMs);
  const bounds = new Map<Id, Millis>();
  for (let i = 0; i < track.clips.length - 1; i += 1) {
    const curr = track.clips[i];
    const nextClip = track.clips[i + 1];
    if (nextClip.startMs > curr.endMs + 0.5) {
      bounds.set(curr.id, nextClip.startMs);
      filled += 1;
    }
  }
  if (!filled) return { doc, filled: 0 };
  for (const clip of track.clips) {
    const end = bounds.get(clip.id);
    if (end !== undefined) clip.endMs = end;
  }
  return { doc: next, filled };
}

/** 消除缝隙：字幕与音频一起向前贴，任一轨道先贴住整组就停 */
export function removeGaps(doc: ProjectDocument): { doc: ProjectDocument; moved: number; blocked: number } {
  const next = cloneDocument(doc);
  let moved = 0;
  let blocked = 0;
  const subtitle = next.tracks.find((t) => t.kind === "subtitle");
  if (!subtitle) return { doc: next, moved, blocked };
  subtitle.clips.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < subtitle.clips.length; i += 1) {
    const prev = subtitle.clips[i - 1];
    const curr = subtitle.clips[i];
    const gap = curr.startMs - prev.endMs;
    if (gap <= 0) continue;
    const group = next.tracks.flatMap((t) => t.clips.filter((c) => c.startMs >= curr.startMs));
    let allowed = gap;
    for (const c of group) {
      const before = next.tracks
        .flatMap((t) => t.clips)
        .filter((o) => o !== c && o.endMs <= c.startMs && !group.includes(o));
      for (const o of before) allowed = Math.min(allowed, c.startMs - o.endMs);
    }
    if (allowed <= 0) {
      blocked += 1;
      continue;
    }
    for (const c of group) {
      c.startMs -= allowed;
      c.endMs -= allowed;
    }
    moved += 1;
  }
  return { doc: next, moved, blocked };
}

/**
 * 自动排序：音频轨按时间顺序首尾相接，第一张也贴到 0 帧；剪短产生的空隙由后面的整段补上。
 * 同步开启时与被移动音频重叠的字幕一起前移，初始落在音频空隙里的字幕是静止锚点。
 * 无可贴合的空隙时返回原文档，供「持续生效」的开关判断是否需要提交。
 */
export function sortTrack(doc: ProjectDocument, trackId: Id, sync = false): ProjectDocument {
  const audioTrack = doc.tracks.find((t) => t.id === trackId);
  if (!audioTrack || !audioTrack.clips.length) return doc;
  const subtitleTrack = doc.tracks.find((t) => t.kind === "subtitle");
  const out = audioTrack.clips.map((c) => ({ ...c })).sort((a, b) => a.startMs - b.startMs);
  const subs = (subtitleTrack?.clips ?? []).map((c) => ({ ...c })).sort((a, b) => a.startMs - b.startMs);
  const anchors = new Set<Id>();
  if (sync) {
    for (let i = 1; i < out.length; i += 1) {
      const g0 = out[i - 1].endMs;
      const g1 = out[i].startMs;
      if (g1 - g0 <= 0.5) continue;
      for (const x of subs) if (x.startMs < g1 - 0.5 && x.endMs > g0 + 0.5) anchors.add(x.id);
    }
  }
  let steps = 0;
  let subsChanged = false;
  let lead = Math.floor(out[0].startMs);
  if (sync && subs.length) lead = Math.min(lead, Math.floor(Math.min(...subs.map((x) => x.startMs || 0))));
  if (lead > 0) {
    for (const c of out) { c.startMs -= lead; c.endMs -= lead; }
    if (sync && subs.length) {
      for (const x of subs) { x.startMs -= lead; x.endMs -= lead; }
      subsChanged = true;
    }
    steps += 1;
  }
  const blocked = new Set<number>();
  for (let guard = 0; guard < 500; guard += 1) {
    let bi = -1;
    let bestAt = Infinity;
    for (let i = 1; i < out.length; i += 1) {
      const gap = out[i].startMs - out[i - 1].endMs;
      if (gap <= 0.5 || blocked.has(i)) continue;
      if (out[i - 1].endMs < bestAt) { bestAt = out[i - 1].endMs; bi = i; }
    }
    if (bi < 0) break;
    let shift = Math.floor(out[bi].startMs - out[bi - 1].endMs);
    const moving = out.slice(bi);
    const mv: number[] = [];
    if (sync && subs.length) {
      subs.forEach((x, j) => {
        if (anchors.has(x.id)) return;
        if (moving.some((c) => x.startMs < c.endMs && x.endMs > c.startMs)) mv.push(j);
      });
      for (const j of mv) {
        let prev: Clip | null = null;
        for (let k = j - 1; k >= 0; k -= 1) if (!mv.includes(k)) { prev = subs[k]; break; }
        const room = prev ? subs[j].startMs - prev.endMs : subs[j].startMs;
        shift = Math.min(shift, Math.floor(room));
      }
    }
    if (!(shift > 0)) { blocked.add(bi); continue; }
    for (let j = bi; j < out.length; j += 1) { out[j].startMs -= shift; out[j].endMs -= shift; }
    for (const j of mv) { subs[j].startMs -= shift; subs[j].endMs -= shift; }
    if (mv.length) subsChanged = true;
    steps += 1;
  }
  if (!steps) return doc;
  const next = cloneDocument(doc);
  next.tracks.find((t) => t.id === trackId)!.clips = out;
  if (subsChanged && subtitleTrack) {
    next.tracks.find((t) => t.id === subtitleTrack.id)!.clips = subs;
  }
  return next;
}

export interface SnapOptions {
  /** 排除自身边缘，避免裁剪端点吸回原处 */
  skip?: Millis[];
  /** 卡片拖动/裁剪时把播放头帧纳入候选；标尺定位不吸自己以免粘滞 */
  includePlayhead?: boolean;
  /** 时间轴右端，作为吸附候选之一 */
  totalMs?: Millis;
  enabled?: boolean;
}

/** 吸附：把 timeMs 吸到时间轴起点、终点、卡片边缘或播放头，容差至少一帧 */
export function snapTime(
  doc: ProjectDocument,
  timeMs: Millis,
  playheadMs: Millis,
  thresholdPx: number,
  pxPerMs: number,
  options: SnapOptions = {},
): Millis {
  const { skip = [], includePlayhead = false, totalMs = durationOf(doc), enabled = true } = options;
  if (!enabled) return quantizeMs(timeMs, doc.video.fps);
  const thresholdMs = Math.max(frameMs(doc.video.fps), thresholdPx / Math.max(1e-6, pxPerMs));
  const candidates: Millis[] = [0, totalMs];
  if (includePlayhead) candidates.push(quantizeMs(playheadMs, doc.video.fps));
  for (const track of doc.tracks) {
    for (const clip of track.clips) candidates.push(clip.startMs, clip.endMs);
  }
  let best = timeMs;
  let distance = thresholdMs;
  for (const c of candidates) {
    if (skip.some((v) => Math.abs(v - c) < 0.5)) continue;
    const d = Math.abs(c - timeMs);
    if (d <= distance) { distance = d; best = c; }
  }
  return quantizeMs(best, doc.video.fps);
}

/** 拖动吸附的是位移量：候选为「让卡片边缘落到别人边缘/播放头/平移边界」的 delta */
export function snapShift(
  doc: ProjectDocument,
  rawDeltaMs: Millis,
  candidates: Millis[],
  thresholdPx: number,
  pxPerMs: number,
  enabled = true,
): Millis {
  if (!enabled) return quantizeMs(rawDeltaMs, doc.video.fps);
  const tolerance = Math.max(frameMs(doc.video.fps), thresholdPx / Math.max(1e-6, pxPerMs));
  let best = rawDeltaMs;
  let distance = tolerance;
  for (const c of candidates) {
    const d = Math.abs(c - rawDeltaMs);
    if (d <= distance) { distance = d; best = c; }
  }
  return quantizeMs(best, doc.video.fps);
}

/** 时间轴长度下限：空轨道与不足 5 秒的工程都按 5 秒铺 */
export const TIMELINE_FLOOR_MS = 5000;

/** 时间轴总长：末尾留余量，有音频时按末尾的 8% 留（3~15 秒），没有音频留 2 秒 */
export function timelineTotal(doc: ProjectDocument): Millis {
  let maxEnd = 0;
  let hasAudio = false;
  for (const track of doc.tracks) {
    if (track.kind === "audio" && track.clips.length) hasAudio = true;
    for (const clip of track.clips) maxEnd = Math.max(maxEnd, clip.endMs);
  }
  const tail = hasAudio
    ? Math.max(3000, Math.min(15000, Math.round(maxEnd * 0.08)))
    : 2000;
  return Math.max(TIMELINE_FLOOR_MS, maxEnd + tail);
}

/* ---------------------------------------------------------------- 样式规则（对齐旧版 L / Ke） */

/**
 * 对齐旧版 L：生成或重新生成一批字幕时套用的样式规则。
 * - 字号在 [minFontSize, maxFontSize] 内随机（旧版 `ei(min,max)`，不是按字数算固定值）；
 * - 颜色从调色板随机取，空数组时退为白色（旧版 `colorPalette[Math.floor(random*len)]`）；
 * - 旋转计划按当前「随机移动」设置重算（旧版 `jeekMovePlan`）。
 * 不动入场动画：入场动画由 `randomStyle` 开关与各条 `enterAnimation` 决定，不在这里改写。
 */
export function applyStyleRules(
  doc: ProjectDocument,
  opts: {
    minFontSize: number;
    maxFontSize: number;
    palette: string[];
    rotationMode?: string;
    rotationInterval?: number;
    rng?: () => number;
  },
): ProjectDocument {
  const {
    minFontSize,
    maxFontSize,
    palette,
    rotationMode = "auto",
    rotationInterval = 0,
    rng = Math.random,
  } = opts;
  const next = cloneDocument(doc);
  for (const track of next.tracks) {
    if (track.kind !== "subtitle") continue;
    const clips = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    const plan = buildMovePlan(clips.length, rotationMode, rotationInterval, rng);
    clips.forEach((clip, i) => {
      const fontSize = Math.floor(rng() * (maxFontSize - minFontSize + 1)) + minFontSize;
      const color = palette.length ? palette[Math.floor(rng() * palette.length)] : "#ffffff";
      clip.data = { ...clip.data, fontSize, color, moveAnimation: plan[i] ?? "up" };
    });
  }
  return next;
}

/**
 * 重排旋转计划：按当前「随机移动」设置（rotationMode / rotationInterval）重新决定
 * 每条字幕的 moveAnimation（↺/↻），写回每一轨字幕。无论字幕是导入的、识别转换的、
 * 手动添加的还是拆分出来的，结构一变就调一次，旋转规则始终适配最新条数。
 *
 * - rotationMode = "off" → 全部归位为 "up"（不旋转）；
 * - 条数不足 3 条 → 不插旋转；
 * - 随机旋转（auto）：方向随机、间隔 3~5 条；交替旋转（alternate）：顺逆交替、间隔 3~5 条。
 *
 * 只改写 moveAnimation，不动每条的字号 / 颜色 / 文本等其它数据。
 */
export function applyRotationPlan(
  doc: ProjectDocument,
  rng: () => number = Math.random,
): ProjectDocument {
  const mode = String((doc.settings as Record<string, unknown>).rotationMode ?? "auto");
  const interval = Number((doc.settings as Record<string, unknown>).rotationInterval ?? 0);
  const next = cloneDocument(doc);
  for (const track of next.tracks) {
    if (track.kind !== "subtitle") continue;
    const clips = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    const plan = buildMovePlan(clips.length, mode, interval, rng);
    const byId = new Map<string, Clip>();
    clips.forEach((clip, i) => {
      const rotated: Clip = { ...clip, data: { ...clip.data, moveAnimation: plan[i] ?? "up" } };
      byId.set(clip.id, rotated);
    });
    track.clips = track.clips.map((c) => byId.get(c.id) ?? c);
  }
  return next;
}

/** 旧版 Ke：打开「随机样式」时给每条字幕随机分配一个入场动画 */
export function randomizeEnter(doc: ProjectDocument, rng: () => number = Math.random): ProjectDocument {
  const list = [
    "none", "fadeIn", "slideUp", "slideLeft", "scale", "pop", "bounceUp",
    "blurIn", "swingIn", "typewriter", "dropIn", "rotateIn", "zoomOut", "elasticPop", "riseFade",
  ];
  const next = cloneDocument(doc);
  for (const track of next.tracks) {
    if (track.kind !== "subtitle") continue;
    for (const clip of track.clips) {
      clip.data = { ...clip.data, enterAnimation: list[Math.floor(rng() * list.length)] };
    }
  }
  return next;
}

/**
 * 全局入场动画 = 一次批量写入：把设置与**每一条字幕**的 enterAnimation 都改成同一个值。
 * 之后在字幕列表里单独改某条，只改那条的数据、立即生效（优先级高于全局值）；
 * 再改一次全局，又能把所有条目统一回来。
 */
export function applyGlobalEnter(doc: ProjectDocument, fx: string): ProjectDocument {
  const next = cloneDocument(doc);
  next.settings = { ...next.settings, enterAnimation: fx };
  for (const track of next.tracks) {
    if (track.kind !== "subtitle") continue;
    for (const clip of track.clips) {
      clip.data = { ...clip.data, enterAnimation: fx };
    }
  }
  return next;
}

/* ---------------------------------------------------------------- 导出范围 */

/**
 * 把工程裁到 [startMs, startMs + durationMs)：所有片段按起点平移，
 * 跨边界的片段夹到区间内，被切掉的那一段让源内偏移同步推进。
 * 导出按区间出片时只走这一个函数，画面与音轨用的是同一份裁剪结果。
 */
export function sliceDocument(
  doc: ProjectDocument,
  startMs: Millis,
  durationMs: Millis,
): ProjectDocument {
  const from = Math.max(0, Math.round(startMs));
  const span = Math.max(1, Math.round(durationMs));
  const to = from + span;
  const next = cloneDocument(doc);

  next.tracks = next.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.endMs <= from || clip.startMs >= to) continue;
      const start = Math.max(0, clip.startMs - from);
      const end = Math.min(span, clip.endMs - from);
      if (end <= start) continue;
      clips.push({
        ...clip,
        startMs: start,
        endMs: end,
        // 左边界被切掉多少，源内起点就往后推多少；右边界不动 inMs
        inMs: Math.max(0, clip.inMs + Math.max(0, from - clip.startMs)),
      });
    }
    return { ...track, clips };
  });

  return next;
}
