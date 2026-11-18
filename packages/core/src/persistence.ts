import {
  SCHEMA_VERSION,
  type Asset,
  type Clip,
  type ProjectDocument,
  type Track,
} from "@jeek/contracts";
import { addClip, addTrack, cloneDocument, createEmptyDocument, nextId, validateDocument } from "./document.js";
import { setSetting } from "./edit-actions.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const normalizeClip = (raw: unknown): Clip => {
  const c = isObject(raw) ? raw : ({} as Record<string, unknown>);
  return {
    id: typeof c.id === "string" ? c.id : "",
    trackId: typeof c.trackId === "string" ? c.trackId : "",
    kind: typeof c.kind === "string" ? c.kind : "subtitle",
    startMs: typeof c.startMs === "number" ? c.startMs : 0,
    endMs: typeof c.endMs === "number" ? c.endMs : 1,
    inMs: typeof c.inMs === "number" ? c.inMs : 0,
    assetId: typeof c.assetId === "string" ? c.assetId : undefined,
    data: isObject(c.data) ? c.data : {},
    effects: Array.isArray(c.effects) ? (c.effects as Clip["effects"]) : [],
  };
};

const normalizeTrack = (raw: unknown): Track => {
  const t = isObject(raw) ? raw : ({} as Record<string, unknown>);
  const clips = Array.isArray(t.clips) ? t.clips.map(normalizeClip) : [];
  // 🔴 片段 id 重复 / 为空时，「改后面那条」会命中前面那条（patchClip 按 id 找第一个），
  // 表现正是「改第二条字号、前面那条变了」。载入工程时统一去重重排，保证每条可独立编辑。
  const seen = new Set<string>();
  for (let i = 0; i < clips.length; i += 1) {
    if (!clips[i].id || seen.has(clips[i].id)) {
      clips[i] = { ...clips[i], id: nextId("clip") };
    } else {
      seen.add(clips[i].id);
    }
  }
  return {
    id: typeof t.id === "string" && t.id ? t.id : nextId("track"),
    kind: typeof t.kind === "string" ? t.kind : "subtitle",
    name: typeof t.name === "string" ? t.name : "字幕轨",
    clips,
    muted: t.muted === true,
    locked: t.locked === true,
    hidden: t.hidden === true,
  };
};

/* ------------------------------------------------------------ 旧版工程迁移 */

const LEGACY_ENTER = new Set([
  "none", "fadeIn", "slideUp", "slideDown", "slideLeft", "slideRight", "scale", "pop",
  "bounceUp", "blurIn", "swingIn", "typewriter", "dropIn", "rotateIn", "zoomOut", "elasticPop", "riseFade",
]);

const LEGACY_MOVE = new Set(["up", "clockwise90", "counterclockwise90"]);

const LEGACY_ASPECT: Record<string, string> = {
  "16:9": "landscape",
  "9:16": "portrait",
  "1:1": "square",
  "4:3": "standard",
  "4:5": "story",
  "21:9": "wide",
};

const LEGACY_RESOLUTION: Record<string, string> = { "1080": "1080P", "1440": "1440P", "2160": "2160P" };

const legacyColor = (value: unknown): string =>
  typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : "#ffffff";

const legacyNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * 旧版工程文件：`{ app, version, subtitles, settings, audio, audioSegments, exportRange }`。
 * 字幕、样式、比例、帧率、导出范围都能完整还原；音频是文件路径，
 * 浏览器里读不到原文件，只把路径留在 settings 里，由界面提示重新载入。
 */
function migrateLegacyProject(raw: Record<string, unknown>): ProjectDocument {
  let doc = createEmptyDocument(typeof raw.name === "string" && raw.name ? raw.name : "未命名工程");
  const settings = isObject(raw.settings) ? raw.settings : {};
  const style = isObject(settings.style) ? settings.style : {};
  const anchor = isObject(settings.anchor) ? settings.anchor : {};
  const video = isObject(raw.video) ? raw.video : {};

  doc = setSetting(doc, "aspect", LEGACY_ASPECT[String(video.ratio ?? "16:9")] ?? "landscape");
  doc = setSetting(doc, "resolution", LEGACY_RESOLUTION[String(video.res ?? 1080)] ?? "1080P");
  if (typeof video.fps === "number" && video.fps > 0) {
    doc = { ...doc, video: { ...doc.video, fps: video.fps } };
  }

  if (typeof style.fontFamily === "string") doc = setSetting(doc, "fontFamily", style.fontFamily);
  if (typeof style.minFontSize === "number") doc = setSetting(doc, "minFontSize", style.minFontSize);
  if (typeof style.maxFontSize === "number") doc = setSetting(doc, "maxFontSize", style.maxFontSize);
  if (Array.isArray(style.colorPalette)) {
    const palette = style.colorPalette.filter((c): c is string => typeof c === "string");
    if (palette.length) doc = setSetting(doc, "palette", palette);
  }

  // 位置是 0..1 的比例，新版按百分比存
  if (typeof anchor.x === "number") doc = setSetting(doc, "subtitleX", anchor.x * 100);
  if (typeof anchor.y === "number") doc = setSetting(doc, "subtitleY", anchor.y * 100);

  const background = isObject(settings.background) ? settings.background : null;
  if (background && typeof background.type === "string") {
    doc = setSetting(doc, "background", background.type === "transparent" ? "transparent" : background.type === "image" ? "image" : "solid");
    if (typeof background.color === "string") doc = setSetting(doc, "backgroundColor", background.color);
  }

  if (typeof settings.randomStyle === "boolean") doc = setSetting(doc, "randomStyle", settings.randomStyle);
  if (typeof settings.globalEnter === "string") doc = setSetting(doc, "enterAnimation", settings.globalEnter);
  if (typeof settings.randomMove === "boolean") {
    doc = setSetting(doc, "rotationMode", settings.randomMove ? "auto" : "fixed");
  }
  if (typeof settings.rotateEvery === "number") doc = setSetting(doc, "rotationInterval", settings.rotateEvery);
  if (typeof settings.asrMaxChars === "number") doc = setSetting(doc, "asrMaxChars", settings.asrMaxChars);
  if (typeof settings.asrBackend === "string") doc = setSetting(doc, "asrBackend", settings.asrBackend);
  if (typeof settings.asrMaxMs === "number") doc = setSetting(doc, "asrMaxMs", settings.asrMaxMs);
  if (typeof settings.asrVadSeg === "number") doc = setSetting(doc, "asrVadMaxSeg", settings.asrVadSeg);

  const range = isObject(raw.exportRange) ? raw.exportRange : null;
  if (range) {
    const start = typeof range.start === "number" ? range.start : null;
    const end = typeof range.end === "number" ? range.end : null;
    if (start !== null || end !== null) {
      doc = setSetting(doc, "exportRange", {
        startMs: Math.max(0, Math.round(start ?? 0)),
        endMs: Math.max(0, Math.round(end ?? 0)),
      });
    }
  }

  doc = addTrack(doc, "subtitle", "字幕轨");
  doc = addTrack(doc, "audio", "音频轨");
  const trackId = doc.tracks.find((t) => t.kind === "subtitle")?.id ?? "";

  for (const item of raw.subtitles as unknown[]) {
    if (!isObject(item)) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const startMs = Math.max(0, Math.round(legacyNumber(item.startMs, 0)));
    const endMs = Math.max(startMs + 1, Math.round(legacyNumber(item.endMs, startMs + 1)));
    doc = addClip(doc, trackId, {
      kind: "subtitle",
      startMs,
      endMs,
      data: {
        text,
        fontSize: legacyNumber(item.fontSize, 60),
        fontFamily: typeof item.fontFamily === "string" ? item.fontFamily : "Microsoft YaHei",
        color: legacyColor(item.color),
        enterAnimation: LEGACY_ENTER.has(String(item.enterAnimation)) ? item.enterAnimation : "fadeIn",
        motion: LEGACY_MOVE.has(String(item.moveAnimation)) ? item.moveAnimation : "up",
      },
    });
  }

  if (typeof raw.audio === "string" && raw.audio) {
    doc = setSetting(doc, "legacyAudioPath", raw.audio);
  }

  return { ...doc, schemaVersion: SCHEMA_VERSION };
}

/** 工程文件带 schemaVersion，缺字段在这里补齐，未来升版只加一条迁移分支 */export function migrate(raw: unknown): ProjectDocument {
  if (!isObject(raw)) throw new Error("工程内容不是对象");
  if (Array.isArray(raw.subtitles)) return migrateLegacyProject(raw);
  const base = createEmptyDocument(typeof raw.name === "string" ? raw.name : "未命名工程");
  const selection = isObject(raw.selection) ? raw.selection : {};

  const tracks = Array.isArray(raw.tracks) ? raw.tracks.map(normalizeTrack) : [];
  // 轨道 id 重复同样去重；轨道 id 变了，片段的 trackId 引用要跟着改
  const trackSeen = new Set<string>();
  for (let i = 0; i < tracks.length; i += 1) {
    if (!tracks[i].id || trackSeen.has(tracks[i].id)) {
      const fresh = nextId("track");
      const old = tracks[i].id;
      tracks[i] = {
        ...tracks[i],
        id: fresh,
        clips: tracks[i].clips.map((c) => (c.trackId === old || !c.trackId ? { ...c, trackId: fresh } : c)),
      };
    } else {
      trackSeen.add(tracks[i].id);
    }
  }

  return {
    ...base,
    id: typeof raw.id === "string" ? raw.id : base.id,
    video: { ...base.video, ...(isObject(raw.video) ? raw.video : {}) },
    assets: Array.isArray(raw.assets) ? (raw.assets as Asset[]) : [],
    tracks,
    selection: {
      clips: Array.isArray(selection.clips) ? (selection.clips as string[]) : [],
      tracks: Array.isArray(selection.tracks) ? (selection.tracks as string[]) : [],
    },
    settings: isObject(raw.settings) ? { ...base.settings, ...raw.settings } : base.settings,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function serializeProject(doc: ProjectDocument, pretty = true): string {
  const error = validateDocument(doc);
  if (error) throw new Error(`工程文档无效：${error}`);
  return JSON.stringify(doc, null, pretty ? 2 : 0);
}

export function deserializeProject(text: string): ProjectDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("工程文件不是合法 JSON");
  }
  const doc = migrate(parsed);
  const error = validateDocument(doc);
  if (error) throw new Error(`工程文件无效：${error}`);
  return cloneDocument(doc);
}
