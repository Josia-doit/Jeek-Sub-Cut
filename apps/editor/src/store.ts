import type { Command, CommandStack, ModuleRegistry, ProjectDocument } from "@jeek/contracts";
import {
  addTrack,
  createCommandStack,
  createEmptyDocument,
  createEventBus,
  createModuleRegistry,
  insertClip,
  makeCommand,
  playheadEndMs,
  quantizeMs,
  setSetting,
  setSelection,
  sortTrack,
  TIMELINE_FLOOR_MS,
  timelineTotal,
  type FontEntry,
} from "@jeek/core";
import { create } from "zustand";
import { effectivePlaybackGain, playAudio, renderTrackAudio, setPlaybackGain, stopAudio } from "./lib/media";
import { MODULE_LOADERS, pickModules } from "./modules.config";

export type OverlayName = "none" | "asr" | "export" | "settings" | "modules" | "record" | "find" | "fonts"
  | "trackSubtitle" | "trackAudio";
export type ThemeName = "light" | "dark";

/** 主题持久化键（带版本号，与布局约定一致）：启动时读、切换时写，跟随上次选择 */
export const THEME_STORAGE_KEY = "jeek-theme-v1";
export function readStoredTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
export function writeStoredTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 隐私模式：忽略 */
  }
}

export interface AudioState {
  name: string;
  durationMs: number;
  peaks: number[];
  /** 解码后的音频只在运行时持有，不进工程文档 */
  buffer: AudioBuffer | null;
  url: string | null;
}

export interface AsrState {
  stage: "idle" | "extract" | "model" | "vad" | "recognize" | "split" | "done" | "error";
  progress: number;
  message: string;
  segDone: number;
  segTotal: number;
  logs: string[];
}

export interface ExportState {
  stage: "init" | "rendering" | "done" | "error";
  progress: number;
  message: string;
  output: string;
  size: number;
  rendered: number;
  total: number;
  hardwareEncoded: boolean;
}

export interface EditorState {
  /* 内核：唯一真相源 + 命令栈 + 模块注册表 */
  doc: ProjectDocument;
  stack: CommandStack;
  registry: ModuleRegistry;
  ready: boolean;
  canUndo: boolean;
  canRedo: boolean;

  /* 播放与视图 */
  playheadMs: number;
  playing: boolean;
  /** 点字幕列表播片段：只在 [from, to] 区间里播放，到 to 自动暂停 */
  clipRange: { from: number; to: number } | null;
  /** 播放器喇叭的静音开关：界面状态，不进工程文档、不占撤销栈 */
  volumeMuted: boolean;
  zoom: number;
  baseTotalMs: number;
  snapEnabled: boolean;
  followPlayhead: boolean;
  /** 同步是界面开关，不进工程文档、不占撤销栈；自动排序开关随排序一起进撤销栈 */
  syncWithAudio: boolean;
  autoSortOn: boolean;
  /** 工具条「关闭字幕」标签上显示的来源（文件名 / 语音转字幕），不进工程文档 */
  subtitleSourceName: string | null;
  /** 底部输入框在没有选中卡片时缓存的草稿文本，不进工程文档、不占撤销栈 */
  draftText: string;

  /* 媒体与任务 */
  audio: AudioState | null;
  recording: boolean;
  backgroundImage: HTMLImageElement | null;
  asr: AsrState;
  export: ExportState;
  /** 字体目录：用户导入的本地字体（内置字体不存这里），不进工程文档 */
  fontCatalog: FontEntry[];

  /* 界面 */
  theme: ThemeName;
  overlay: OverlayName;
  toast: string;

  /* 动作 */
  commit(label: string, next: ProjectDocument, ui?: Command["ui"]): void;
  undo(): void;
  redo(): void;
  update(partial: Partial<EditorState>): void;
  setSetting(key: string, value: unknown): void;
  /** 播放器喇叭：切换静音并立即作用于正在播放的那一路 */
  setVolumeMuted(value: boolean): void;
  /** 拖音量条：连续拖动只改文档不进撤销栈，松手才合成一条记录；播放中立即生效 */
  setMasterGain(value: number, commit: boolean): void;
  /** 选中卡片只是视图状态，不占撤销栈 */
  selectClips(ids: string[]): void;
  /** 拖动中的连续修改：只改文档，不进撤销栈 */
  previewSetting(key: string, value: unknown): void;
  /** 松手时把整段拖动合成一条撤销记录 */
  commitSettingDraft(label: string): void;
  setPlayhead(ms: number): void;
  /** 用户主动跳转（点标尺、拖播放头、点字幕）：停下声音再定位 */
  seekTo(ms: number): void;
  /** 点字幕列表：从卡片开头播到结尾自动暂停 */
  playClipRange(from: number, to: number): void;
  /** 清掉片段播放区间（手动跳转 / 全量播放 / 片段放完时调用） */
  clearClipRange(): void;
  /** 轨道总控：锁定 / 静音 / 显隐 */
  toggleTrackFlag(trackId: string, flag: "locked" | "muted" | "hidden"): void;
  /** 换了整份文档（导入字幕、载入工程）后重新定刻度基准 */
  rebase(): void;
  fitAll(): void;
  changeZoom(delta: number): void;
  setZoom(value: number): void;
  toggleSync(): void;
  toggleAutoSort(): void;
  /** 字体目录增删改：只动界面状态，导入的字体不进工程文档 */
  setFontCatalog(entries: FontEntry[]): void;
  notify(message: string): void;
}

/** 新建工程默认入场 350ms：过渡太短看不出动效，太长又拖慢卡点节奏 */
export const DEFAULT_ENTER_DURATION_MS = 350;

/** 旧工程文件里没有动画时长设置时补上默认值，载入后动效同样清晰可见 */
export function withDefaultEnterDuration(doc: ProjectDocument): ProjectDocument {
  return typeof doc.settings.enterDurationMs === "number"
    ? doc
    : setSetting(doc, "enterDurationMs", DEFAULT_ENTER_DURATION_MS);
}

/** 初始工程：字幕轨 + 音频轨，三条示例字幕让打开即可预览 */
function createStarterDocument(): ProjectDocument {
  let doc = createEmptyDocument("我的第一个工程");
  doc = setSetting(doc, "logicalShortEdge", 1440);
  doc = setSetting(doc, "background", "solid");
  doc = setSetting(doc, "backgroundColor", "#000000");
  doc = setSetting(doc, "fontColor", "#ffffff");
  doc = setSetting(doc, "fontSize", 60);
  doc = setSetting(doc, "subtitleStyle", "fit");
  doc = setSetting(doc, "fitRatio", 80);
  doc = setSetting(doc, "minFontSize", 90);
  doc = setSetting(doc, "maxFontSize", 100);
  doc = setSetting(doc, "fontFamily", "Microsoft YaHei");
  doc = setSetting(doc, "fontBold", true);
  doc = setSetting(doc, "fontItalic", false);
  doc = setSetting(doc, "fontUnderline", false);
  doc = setSetting(doc, "fontStrike", false);
  doc = setSetting(doc, "fontSampleText", "吉客字幕剪辑 JeekSubCut");
  // 文字描边：默认关闭，打开后沿用旧工程既有的画面基线
  doc = setSetting(doc, "strokeEnabled", false);
  doc = setSetting(doc, "strokeStyle", "outer");
  doc = setSetting(doc, "strokeColor", "#ffffff");
  doc = setSetting(doc, "strokeColor2", "#ffffff");
  doc = setSetting(doc, "strokeWidth", 5);
  // 轨道级设置放在 settings 里：工程持久化原样保留，渲染与音频链路都直接读
  doc = setSetting(doc, "subtitleOpacity", 100);
  doc = setSetting(doc, "audioNoiseReduction", false);
  doc = setSetting(doc, "audioUniformVolume", false);
  doc = setSetting(doc, "audioGainDb", 0);
  doc = setSetting(doc, "enterAnimation", "打字机");
  doc = setSetting(doc, "enterDurationMs", DEFAULT_ENTER_DURATION_MS);
  doc = setSetting(doc, "palette", ["#FFF4B5", "#FFB4A2", "#A0E7E5", "#B8C0FF", "#CDE77F"]);
  doc = setSetting(doc, "motion", "up");
  doc = setSetting(doc, "rotationMode", "auto");
  doc = setSetting(doc, "rotationInterval", 0);
  doc = setSetting(doc, "rotationSkipLast", true);
  doc = setSetting(doc, "stackLimit", 5);
  doc = setSetting(doc, "maxChars", 14);
  doc = setSetting(doc, "subtitleX", 30);
  doc = setSetting(doc, "subtitleY", 50);
  doc = setSetting(doc, "aspect", "landscape");
  doc = setSetting(doc, "resolution", "1080P");
  doc = setSetting(doc, "snapEnabled", true);
  doc = setSetting(doc, "syncWithAudio", false);
  doc = setSetting(doc, "autoSort", false);
  doc = setSetting(doc, "masterGain", 1);
  doc = setSetting(doc, "asrBackend", "vulkan");
  doc = setSetting(doc, "asrMaxChars", 14);
  doc = setSetting(doc, "asrMaxMs", 4500);
  doc = setSetting(doc, "asrVadMaxSeg", 8000);
  doc = setSetting(doc, "exportCodec", "h264");
  doc = setSetting(doc, "exportQuality", "balanced");
  doc = setSetting(doc, "exportCrf", 20);
  doc = setSetting(doc, "exportAccel", "auto");
  doc = setSetting(doc, "exportConcurrency", 0);
  doc = setSetting(doc, "exportFilename", "");
  doc = setSetting(doc, "exportDir", "");
  doc = setSetting(doc, "exportRange", null);
  doc = setSetting(doc, "subtitleExportFormat", "srt");
  doc = addTrack(doc, "subtitle", "字幕轨");
  doc = addTrack(doc, "audio", "音频轨");
  return doc;
}

let currentDoc = createStarterDocument();
const stack = createCommandStack();
const events = createEventBus();

/** 从命令携带的界面开关快照取回写补丁。与文档在同一批 set 中恢复，避免自动排序钩子抢先重排 */
function uiSnapshotPatch(ui: Command["ui"] | undefined, side: "before" | "after"): Partial<EditorState> {
  const snap = ui?.[side];
  if (!snap) return {};
  const patch: Partial<EditorState> = {};
  if (typeof snap.autoSortOn === "boolean") patch.autoSortOn = snap.autoSortOn;
  return patch;
}
const registry = createModuleRegistry({
  document: () => currentDoc,
  commands: stack,
  events,
});

/** 拖动滑块期间的起点快照：松手时用它合成一条撤销记录 */
let settingDraft: ProjectDocument | null = null;

/** 轨道长度下限：空轨道与不足 5 秒的工程都按 5 秒铺，时间轴与播放头共用同一口径 */
export const BASE_FLOOR_MS = TIMELINE_FLOOR_MS;

/** 时间轴最大缩放倍率 */
export const MAX_ZOOM = 20;

/** 时间轴与播放头共用同一口径：末尾留余量，音频块才往右拖得动 */
export const totalOf = timelineTotal;

/** 某张卡片所在轨道是否被锁定：锁定后拖动与一切编辑（切分/裁剪/删除/改名）都要被挡住 */
export function clipLocked(doc: ProjectDocument, clipId: string): boolean {
  const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  return Boolean(track?.locked);
}

/** 整条轨道是否锁定 */
export function trackLocked(doc: ProjectDocument, kind: "subtitle" | "audio"): boolean {
  return Boolean(doc.tracks.find((t) => t.kind === kind)?.locked);
}

const initialTotal = totalOf(currentDoc);

export const useEditor = create<EditorState>((set, get) => ({
  doc: currentDoc,
  stack,
  registry,
  ready: false,
  canUndo: false,
  canRedo: false,

  playheadMs: 0,
  playing: false,
  clipRange: null,
  volumeMuted: false,
  zoom: 1,
  baseTotalMs: Math.max(BASE_FLOOR_MS, initialTotal),
  snapEnabled: true,
  followPlayhead: true,
  syncWithAudio: false,
  autoSortOn: false,
  subtitleSourceName: null,
  draftText: "",

  audio: null,
  recording: false,
  backgroundImage: null,
  asr: { stage: "idle", progress: 0, message: "", segDone: 0, segTotal: 0, logs: [] },
  export: { stage: "init", progress: 0, message: "", output: "", size: 0, rendered: 0, total: 0, hardwareEncoded: false },
  fontCatalog: [],

  theme: readStoredTheme(),
  overlay: "none",
  toast: "",

  commit(label, next, ui) {
    const before = get().doc;
    settingDraft = null;
    currentDoc = next;
    stack.push(makeCommand(label, before, next, undefined, ui));
    set({
      doc: next,
      ...uiSnapshotPatch(ui, "after"),
      canUndo: stack.canUndo(),
      canRedo: stack.canRedo(),
    });
    events.emit("document:changed", { label });
  },

  undo() {
    const cmd = stack.undo();
    if (!cmd) return;
    settingDraft = null;
    currentDoc = cmd.before;
    set({
      doc: cmd.before,
      ...uiSnapshotPatch(cmd.ui, "before"),
      canUndo: stack.canUndo(),
      canRedo: stack.canRedo(),
    });
    events.emit("document:changed", { label: `撤销 ${cmd.label}` });
  },

  redo() {
    const cmd = stack.redo();
    if (!cmd) return;
    settingDraft = null;
    currentDoc = cmd.after;
    set({
      doc: cmd.after,
      ...uiSnapshotPatch(cmd.ui, "after"),
      canUndo: stack.canUndo(),
      canRedo: stack.canRedo(),
    });
    events.emit("document:changed", { label: `重做 ${cmd.label}` });
  },

  update(partial) {
    set(partial as EditorState);
  },

  setSetting(key, value) {
    const next = setSetting(get().doc, key, value);
    get().commit(`设置 ${key}`, next);
  },

  setVolumeMuted(value) {
    set({ volumeMuted: value });
    if (get().playing) setPlaybackGain(effectivePlaybackGain(get().doc, value));
  },

  setMasterGain(value, commit) {
    const s = get();
    const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    // 静音时拖滑块即视为恢复声音；拖到 0 仍保持静音
    if (s.volumeMuted && v > 0) set({ volumeMuted: false });
    s.previewSetting("masterGain", v);
    if (s.playing) setPlaybackGain(effectivePlaybackGain(get().doc, get().volumeMuted));
    if (commit) s.commitSettingDraft("总音量");
  },

  selectClips(ids) {
    const next = setSelection(get().doc, ids);
    if (next === get().doc) return;
    currentDoc = next;
    set({ doc: next });
    events.emit("document:changed", { label: "选中卡片" });
  },

  previewSetting(key, value) {
    const current = get().doc;
    if (!settingDraft) settingDraft = current;
    const next = setSetting(current, key, value);
    currentDoc = next;
    set({ doc: next });
    events.emit("document:changed", { label: `预览 ${key}` });
  },

  commitSettingDraft(label) {
    const draft = settingDraft;
    settingDraft = null;
    if (!draft) return;
    const next = get().doc;
    if (next === draft) return;
    stack.push(makeCommand(label, draft, next));
    set({ canUndo: stack.canUndo(), canRedo: stack.canRedo() });
    events.emit("document:changed", { label });
  },

  setPlayhead(ms) {
    // 上限是内容末端（最后一张卡片的末尾 = durationOf）：播放头能精确停在卡片末端，
    // 画面仍是最后一帧、又不会越过内容去显示空白帧。时间轴定位、播放、进度条、End 键
    // 全用这同一个值，从根上消灭「选不中最后一帧 / 尾部多一帧空白」的夹逼。
    const limit = playheadEndMs(get().doc);
    // 播放头是连续时间：按帧取整会吞掉每帧十几毫秒的推进量，画面就卡住不动
    set({ playheadMs: Math.max(0, Math.min(limit, ms)) });
  },

  seekTo(ms) {
    stopAudio();
    const limit = playheadEndMs(get().doc);
    set({ playing: false, clipRange: null, playheadMs: Math.max(0, Math.min(limit, ms)) });
  },

  playClipRange(from, to) {
    const s = get();
    stopAudio();
    const mixed = renderTrackAudio(s.doc, s.audio?.buffer ?? null);
    const gain = effectivePlaybackGain(s.doc, s.volumeMuted);
    if (mixed) playAudio(mixed, from, gain);
    set({ playheadMs: Math.max(0, from), playing: true, clipRange: { from, to } });
  },

  clearClipRange() {
    if (!get().clipRange) return;
    set({ clipRange: null });
  },

  toggleTrackFlag(trackId, flag) {
    const s = get();
    const track = s.doc.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const value = !track[flag];
    const next = {
      ...s.doc,
      tracks: s.doc.tracks.map((t) =>
        t.id === trackId ? { ...t, [flag]: value } : t,
      ),
    };
    const labelOf = { locked: "轨道锁定", muted: "轨道静音", hidden: "轨道显隐" } as const;
    s.commit(labelOf[flag], next);
    // 喇叭实时生效：播放中点静音立即改正在放的那路增益，不用重开
    if (flag === "muted" && s.playing) {
      setPlaybackGain(effectivePlaybackGain(next, s.volumeMuted));
    }
  },

  /** 适配：基准定住后，改卡片时长只让轨道变长变短，不挤压已有卡片像素宽度 */
  fitAll() {
    set({ baseTotalMs: totalOf(get().doc), zoom: 1 });
  },

  rebase() {
    set({ baseTotalMs: Math.max(BASE_FLOOR_MS, totalOf(get().doc)) });
  },

  /** 缩放是 1~20 的倍率，步进按当前倍率放大：0.35× 当前值，最少 0.25 */
  changeZoom(delta) {
    const cur = get().zoom;
    const step = Math.max(0.25, 0.35 * cur);
    get().setZoom(cur + (delta > 0 ? step : -step));
  },

  setZoom(value) {
    const next = Math.max(1, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
    if (next === get().zoom) return;
    set({ zoom: next });
  },

  toggleSync() {
    set({ syncWithAudio: !get().syncWithAudio });
  },

  toggleAutoSort() {
    const s = get();
    const before = s.autoSortOn;
    const after = !before;
    let next = s.doc;
    // 开启时把音频轨贴合与开关切换合成一条记录：撤销即关开关并回到贴合前的位置。
    // 排序幂等，同批 set 里开关已就位，持续生效钩子不会重复提交。
    if (after) {
      const audio = next.tracks.find((t) => t.kind === "audio");
      if (audio?.clips.length) next = sortTrack(next, audio.id, s.syncWithAudio);
    }
    s.commit(after ? "开启自动排序" : "关闭自动排序", next, {
      before: { autoSortOn: before },
      after: { autoSortOn: after },
    });
  },

  setFontCatalog(entries) {
    set({ fontCatalog: entries });
  },

  notify(message) {
    set({ toast: message });
    window.setTimeout(() => {
      if (get().toast === message) set({ toast: "" });
    }, 3200);
  },
}));

/** 组装层只按清单加载模块；增删模块改 modules.config.ts 一处即可 */
export async function activateDefaultModules(): Promise<void> {
  for (const load of MODULE_LOADERS) {
    const namespace = await load();
    for (const module of pickModules(namespace)) {
      if (!registry.has(module.id)) await registry.use(module);
    }
  }
  useEditor.setState({ ready: true });
}

/** 供非 React 代码读取当前播放头（拖动、切分、快捷键都用同一份） */
export const currentPlayhead = (): number => useEditor.getState().playheadMs;
