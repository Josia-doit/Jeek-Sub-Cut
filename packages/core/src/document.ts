import {
  DEFAULT_FPS,
  LOGICAL_SHORT_EDGE,
  SCHEMA_VERSION,
  type Clip,
  type EffectNode,
  type Id,
  type Millis,
  type ProjectDocument,
  type Track,
} from "@jeek/contracts";

let seq = 0;

export const nextId = (prefix: Id = "id"): Id =>
  `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** 工程文档是纯 JSON 数据，用值拷贝保证不可变更新不泄漏引用 */
export const cloneDocument = (doc: ProjectDocument): ProjectDocument =>
  JSON.parse(JSON.stringify(doc)) as ProjectDocument;

export function createEmptyDocument(name = "未命名工程"): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: nextId("project"),
    name,
    video: { width: 2560, height: 1440, fps: DEFAULT_FPS },
    assets: [],
    tracks: [],
    selection: { clips: [], tracks: [] },
    settings: { logicalShortEdge: LOGICAL_SHORT_EDGE },
  };
}

export function validateDocument(doc: ProjectDocument): string | null {
  if (!doc || typeof doc !== "object") return "工程文档不是对象";
  if (doc.schemaVersion !== SCHEMA_VERSION)
    return `schemaVersion 不匹配：${String(doc.schemaVersion)}`;
  if (!Array.isArray(doc.tracks)) return "tracks 必须是数组";
  if (!Array.isArray(doc.assets)) return "assets 必须是数组";
  if (!doc.video || doc.video.fps <= 0) return "视频帧率无效";

  const ids = new Set<Id>();
  for (const track of doc.tracks) {
    if (ids.has(track.id)) return `轨道 id 重复：${track.id}`;
    ids.add(track.id);
    if (!Array.isArray(track.clips)) return `轨道 ${track.id} 的 clips 必须是数组`;
    for (const clip of track.clips) {
      if (clip.trackId !== track.id)
        return `片段 ${clip.id} 的 trackId 与所在轨道不符`;
      if (clip.endMs <= clip.startMs) return `片段 ${clip.id} 时长非正`;
      if (clip.inMs < 0) return `片段 ${clip.id} 源内偏移为负`;
    }
  }
  return null;
}

/**
 * 视频长度 = 最后一张片段的末尾（毫秒），不含余量。
 * 这是播放/导出的唯一长度标尺；时间轴刻度尺的留白由 `timelineTotal` 单独负责。
 */
export function durationOf(doc: ProjectDocument): Millis {
  let end = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.endMs > end) end = clip.endMs;
    }
  }
  return end;
}

/**
 * 帧数 = 轨道末尾向上取整到完整帧（含末帧）。
 * 不再额外 `+1`：旧版「末帧 +1 帧」会在末卡片非整帧边界时多吐出一整帧空尾，
 * 整除时也多 1 帧空白。现在时间轴定位（播放头）与播放/导出的结束位置都停在
 * 「最后一帧的末尾」，不增加多余空帧。
 * 空工程没有内容就是 0 帧（不预设「5 秒」这类默认时长），播放长度随之是 0。
 */
export function frameCountOf(doc: ProjectDocument): number {
  const fps = doc.video.fps || DEFAULT_FPS;
  const span = durationOf(doc);
  if (span === 0) return 0;
  return Math.max(1, Math.ceil((span * fps) / 1000 - 1e-6));
}

/**
 * 内容末端（最后一张卡片的末尾，毫秒）= 播放、导出、进度条、播放头的上限，
 * **唯一真相值**，就是 `durationOf`。
 *
 * 历史坑：曾经把「末端」拆成两个互相打架的值——`playheadEndMs` 取「末帧起点」、
 * `playbackEndMs` 取「末帧末尾」。前者让播放头永远比卡片末端少一帧、选不中最后一帧；
 * 后者当内容末端不在整帧边界时又多冒一帧空白。两者夹着 `durationOf` 左右晃，
 * 表现就是「要么多一帧要么少一帧」。
 * 现在两者统一回 `durationOf`：播放头能精确停在卡片末端（画面仍是最后一帧），
 * 播放/进度条也停在卡片末端、不再多吐空白帧。`timelineTotal`（刻度尺留白）仍单独负责。
 */
export function playbackEndMs(doc: ProjectDocument): Millis {
  return durationOf(doc);
}

/**
 * 播放头最远能停的位置＝内容末端（最后一张卡片的末尾）= `durationOf`。
 * 这是「播放头选不中最后一帧」这个低级 BUG 的根因修复点：旧实现取
 * `(frames - 1) / fps * 1000`（末帧起点），结果播放头永远停在末帧开头、
 * 比卡片末端少一帧；现在直接取到卡片末端，渲染层会把越界部分夹回最后一帧，
 * 于是最后一帧既能完整显示、又能被精确选中，尾部也不多空白帧。
 */
export function playheadEndMs(doc: ProjectDocument): Millis {
  return durationOf(doc);
}

export function findClip(
  doc: ProjectDocument,
  clipId: Id,
): { track: Track; clip: Clip } | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export interface ClipInput {
  id?: Id;
  kind: string;
  startMs: Millis;
  endMs: Millis;
  inMs?: Millis;
  assetId?: Id;
  data?: Record<string, unknown>;
  effects?: EffectNode[];
}

/** 以下写操作全部返回新文档，配合命令快照实现撤销 */
export function addTrack(
  doc: ProjectDocument,
  kind: string,
  name?: string,
): ProjectDocument {
  const next = cloneDocument(doc);
  next.tracks.push({
    id: nextId("track"),
    kind,
    name: name ?? kind,
    clips: [],
    muted: false,
    locked: false,
    hidden: false,
  });
  return next;
}

export function addClip(
  doc: ProjectDocument,
  trackId: Id,
  input: ClipInput,
): ProjectDocument {
  if (input.endMs <= input.startMs) throw new Error("片段时长必须为正");
  const next = cloneDocument(doc);
  const track = next.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`轨道不存在：${trackId}`);

  const clip: Clip = {
    id: input.id ?? nextId("clip"),
    trackId,
    kind: input.kind,
    startMs: input.startMs,
    endMs: input.endMs,
    inMs: input.inMs ?? 0,
    assetId: input.assetId,
    data: input.data ?? {},
    effects: input.effects ?? [],
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

export type ClipPatch = Partial<
  Pick<Clip, "kind" | "startMs" | "endMs" | "inMs" | "assetId" | "data" | "effects">
>;

export function updateClip(
  doc: ProjectDocument,
  clipId: Id,
  patch: ClipPatch,
): ProjectDocument {
  const next = cloneDocument(doc);
  const hit = findClip(next, clipId);
  if (!hit) throw new Error(`片段不存在：${clipId}`);
  Object.assign(hit.clip, patch);
  if (hit.clip.endMs <= hit.clip.startMs) throw new Error("片段时长必须为正");
  if (hit.clip.inMs < 0) throw new Error("源内偏移不能为负");
  hit.track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

export function removeClip(doc: ProjectDocument, clipId: Id): ProjectDocument {
  const next = cloneDocument(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  hit.track.clips = hit.track.clips.filter((c) => c.id !== clipId);
  next.selection.clips = next.selection.clips.filter((id) => id !== clipId);
  return next;
}
