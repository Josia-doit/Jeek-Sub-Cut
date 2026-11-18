/**
 * 契约层：只有类型、接口与常量，没有实现，也不依赖任何包。
 * 所有模块只从这里取类型。改实现不动契约，就不会波及其他模块。
 */

export const SCHEMA_VERSION = 1;
export const DEFAULT_FPS = 30;
export const LOGICAL_SHORT_EDGE = 1440;

export type Id = string;
export type Millis = number;

/* ---------------------------------------------------------------- 工程文档 */

export type AssetKind = "audio" | "video" | "image" | "font";

export interface Asset {
  id: Id;
  kind: AssetKind;
  uri: string;
  durationMs?: Millis;
}

/** 效果节点：调色、转场、美颜等未来能力都挂在这里，用 clipId / trackId 关联，不嵌套对象 */
export interface EffectNode {
  id: Id;
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface Clip {
  id: Id;
  trackId: Id;
  kind: string;
  startMs: Millis;
  endMs: Millis;
  /** 源内偏移：裁剪左端时推进，移动片段时不变 */
  inMs: Millis;
  assetId?: Id;
  /** 模块自定义数据（纯值），不允许放对象引用 */
  data: Record<string, unknown>;
  effects: EffectNode[];
}

export interface Track {
  id: Id;
  kind: string;
  name: string;
  clips: Clip[];
  muted: boolean;
  locked: boolean;
  /** 显隐：字幕轨可整轨隐藏（仅界面开关，不进撤销栈的视图状态也行，这里随文档便于持久化） */
  hidden?: boolean;
}

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
}

export interface Selection {
  clips: Id[];
  tracks: Id[];
}

/** 唯一真相源：UI 只做投影，渲染只做求值，导出只做序列化 */
export interface ProjectDocument {
  schemaVersion: number;
  id: Id;
  name: string;
  video: VideoConfig;
  assets: Asset[];
  tracks: Track[];
  selection: Selection;
  settings: Record<string, unknown>;
}

/* ---------------------------------------------------------------- 命令与撤销 */

export interface Command {
  id: Id;
  label: string;
  timestamp: number;
  before: ProjectDocument;
  after: ProjectDocument;
  /** 随命令一起撤销/重做的界面开关快照（键为 EditorState 上的布尔开关名），不进工程文档 */
  ui?: {
    before: Record<string, boolean>;
    after: Record<string, boolean>;
  };
}

export interface CommandStack {
  push(command: Command): void;
  undo(): Command | null;
  redo(): Command | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  readonly size: number;
}

/* ---------------------------------------------------------------- 事件与模块 */

export type EventHandler = (payload: unknown) => void;

export interface EventBus {
  on(type: string, handler: EventHandler): () => void;
  off(type: string, handler: EventHandler): void;
  emit(type: string, payload?: unknown): void;
}

export type ContributionKind =
  | "trackTypes"
  | "panels"
  | "commands"
  | "tools"
  | "inspectors"
  | "effects"
  | "exporters"
  | "settings";

export interface Contribution {
  id: Id;
  kind: ContributionKind;
  moduleId: Id;
  payload: Record<string, unknown>;
}

export interface ModuleContext {
  readonly commands: CommandStack;
  readonly events: EventBus;
  document(): ProjectDocument;
  /** moduleId 由注册表注入，模块不需要（也不允许）自己指定 */
  register(contribution: Omit<Contribution, "moduleId">): void;
  unregister(contributionId: Id): void;
}

export interface JeekModule {
  id: Id;
  name: string;
  version: string;
  activate(context: ModuleContext): void | Promise<void>;
  deactivate?(context: ModuleContext): void | Promise<void>;
}

export interface ModuleRegistry {
  use(module: JeekModule): Promise<void>;
  drop(moduleId: Id): Promise<void>;
  list(): readonly JeekModule[];
  contributions(kind?: ContributionKind): readonly Contribution[];
  has(moduleId: Id): boolean;
}

/* ---------------------------------------------------------------- 渲染契约 */

export interface RenderRequest {
  requestId: Id;
  document: ProjectDocument;
  fromMs: Millis;
  toMs: Millis;
  fps: number;
  width: number;
  height: number;
  output?: string;
}

export interface RenderProgress {
  requestId: Id;
  stage: string;
  renderedFrames: number;
  totalFrames: number;
  done: boolean;
  error?: string;
}

export interface RenderResult {
  requestId: Id;
  ok: boolean;
  frames: number;
  elapsedMs: number;
  output?: string;
  error?: string;
}

export interface FrameData {
  timeMs: Millis;
  width: number;
  height: number;
  /** 确定性帧指纹：首阶段用描述性校验和，真实像素由后续渲染后端产出 */
  checksum: string;
}

/** 一句话抽象：给定工程文档与时间点，返回一帧画面。实现可替换，上层零改动 */
export interface RenderProvider {
  readonly id: string;
  readonly capabilities: readonly string[];
  validate(request: RenderRequest): string | null;
  renderFrame(request: RenderRequest, timeMs: Millis): Promise<FrameData>;
  renderRange(
    request: RenderRequest,
    onProgress?: (progress: RenderProgress) => void,
  ): Promise<RenderResult>;
  cancel(requestId: Id): void;
}
