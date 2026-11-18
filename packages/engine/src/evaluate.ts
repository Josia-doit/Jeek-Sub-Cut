import type { Clip, ProjectDocument } from "@jeek/contracts";
import { playheadEndMs } from "@jeek/core";

/* ---------------------------------------------------------------- 动效定义 */

export const MOTION_NAMES = [
  "fade",
  "up",
  "down",
  "left",
  "right",
  "zoom",
  "pop",
  "bounceUp",
  "blur",
  "swing",
  "typewriter",
  "fall",
  "rotateIn",
  "none",
] as const;
export type MotionName = (typeof MOTION_NAMES)[number];

export const MOTION_LABELS: Record<MotionName, string> = {
  fade: "淡入淡出",
  up: "上移",
  down: "下移",
  left: "左移",
  right: "右移",
  zoom: "缩放",
  pop: "弹出",
  bounceUp: "弹跳上浮",
  blur: "模糊入",
  swing: "摆动入",
  typewriter: "打字机",
  fall: "落下",
  rotateIn: "旋转入",
  none: "无",
};

export const EXIT_LABELS: Record<string, string> = {
  shrink: "缩小退场",
  pop: "弹性弹出",
  up: "上浮淡入",
  move: "上移",
};

export const ROTATION_LABELS: Record<string, string> = {
  off: "不插入旋转",
  clockwise: "顺时针90",
  counter: "逆时针90",
  alternate: "顺逆交替",
  random: "顺/逆时针随机",
  interval: "按滑块间隔",
};

/* ---------------------------------------------------------------- 帧求值时间轴常量 */
/* 旧版一切按帧计算（frame / fps），求值入口先换算成帧再算进度。
   所有长度都是「逻辑短边 1440」基准下的 CSS 像素，绘制时统一乘 factor。 */

export const ENTER_DURATION_SECONDS = 0.2;
export const STACK_TRANSITION_SECONDS = 0.25;
export const FIT_TRANSITION_SECONDS = 0.25;
export const TYPEWRITER_DURATION_SECONDS = 0.4;
export const STACK_GAP = 16;
export const TEXT_RIGHT_PADDING = 48;
export const STACK_LIMIT = 5;
export const ANCHOR_X = 0.3;
export const ANCHOR_Y = 0.4;

/* ---------------------------------------------------------------- 缓动：Remotion spring 等价实现 */
/* 旧版用 remotion 的 spring({ damping: 200, durationInFrames }) + interpolate 关键帧。
   这里逐字移植其物理积分与时间轴缩放，保证过渡形状与旧版一致。 */

type SpringConfig = {
  damping: number;
  mass: number;
  stiffness: number;
  overshootClamping: boolean;
};

const DEFAULT_SPRING: SpringConfig = {
  damping: 10,
  mass: 1,
  stiffness: 100,
  overshootClamping: false,
};

interface SpringState {
  toValue: number;
  prevPosition: number;
  lastTimestamp: number;
  current: number;
  velocity: number;
}

const springCalcCache = new Map<string, SpringState>();

function springAdvance(
  animation: SpringState,
  now: number,
  config: SpringConfig,
): SpringState {
  const { toValue, lastTimestamp, current, velocity } = animation;
  const deltaTime = Math.min(now - lastTimestamp, 64);
  const c = config.damping;
  const m = config.mass;
  const k = config.stiffness;
  const v0 = -velocity;
  const x0 = toValue - current;
  const zeta = c / (2 * Math.sqrt(k * m));
  const omega0 = Math.sqrt(k / m);
  const omega1 = omega0 * Math.sqrt(1 - zeta * zeta);
  const t = deltaTime / 1000;
  const sin1 = Math.sin(omega1 * t);
  const cos1 = Math.cos(omega1 * t);
  const underDampedEnvelope = Math.exp(-zeta * omega0 * t);
  const underDampedFrag1 =
    underDampedEnvelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
  const underDampedPosition = toValue - underDampedFrag1;
  const underDampedVelocity =
    zeta * omega0 * underDampedFrag1 -
    underDampedEnvelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1);
  const criticallyDampedEnvelope = Math.exp(-omega0 * t);
  const criticallyDampedPosition =
    toValue - criticallyDampedEnvelope * (x0 + (v0 + omega0 * x0) * t);
  const criticallyDampedVelocity =
    criticallyDampedEnvelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0);
  return {
    toValue,
    prevPosition: current,
    lastTimestamp: now,
    current: zeta < 1 ? underDampedPosition : criticallyDampedPosition,
    velocity: zeta < 1 ? underDampedVelocity : criticallyDampedVelocity,
  };
}

function springCalculation(frame: number, fps: number, config: SpringConfig): SpringState {
  const merged: SpringConfig = { ...DEFAULT_SPRING, ...config };
  const key = `${frame}|${fps}|${merged.damping}|${merged.mass}|${merged.overshootClamping}|${merged.stiffness}`;
  const cached = springCalcCache.get(key);
  if (cached) return cached;
  let animation: SpringState = {
    lastTimestamp: 0,
    current: 0,
    toValue: 1,
    velocity: 0,
    prevPosition: 0,
  };
  const frameClamped = Math.max(0, frame);
  const unevenRest = frameClamped % 1;
  for (let f = 0; f <= Math.floor(frameClamped); f += 1) {
    if (f === Math.floor(frameClamped)) f += unevenRest;
    const time = (f / fps) * 1000;
    animation = springAdvance(animation, time, merged);
  }
  springCalcCache.set(key, animation);
  return animation;
}

const measureSpringCache = new Map<string, number>();

function measureSpring(fps: number, config: SpringConfig, threshold = 0.005): number {
  const key = `${fps}|${config.damping}|${config.mass}|${config.overshootClamping}|${config.stiffness}|${threshold}`;
  const cached = measureSpringCache.get(key);
  if (cached !== undefined) return cached;
  let frame = 0;
  let finishedFrame = 0;
  const calc = (): SpringState => springCalculation(frame, fps, config);
  let difference = Math.abs(calc().current - 1);
  while (difference >= threshold) {
    frame += 1;
    difference = Math.abs(calc().current - 1);
  }
  finishedFrame = frame;
  for (let i = 0; i < 20; i += 1) {
    frame += 1;
    difference = Math.abs(calc().current - 1);
    if (difference >= threshold) {
      i = 0;
      finishedFrame = frame + 1;
    }
  }
  measureSpringCache.set(key, finishedFrame);
  return finishedFrame;
}

function spring(opts: {
  frame: number;
  fps: number;
  config?: Partial<SpringConfig>;
  durationInFrames?: number;
}): number {
  const { frame: passedFrame, fps, config = {}, durationInFrames } = opts;
  const merged: SpringConfig = { ...DEFAULT_SPRING, ...config };
  const naturalDuration =
    typeof durationInFrames !== "undefined" ? measureSpring(fps, merged) : undefined;
  const delayProcessed = passedFrame;
  const durationProcessed =
    durationInFrames === undefined
      ? delayProcessed
      : delayProcessed / (durationInFrames / (naturalDuration as number));
  if (durationInFrames && delayProcessed > durationInFrames) return 1;
  return springCalculation(durationProcessed, fps, merged).current;
}

/** 旧版 getSpringProgress：第 0 帧（含）进度为 0，入场随帧推进 */
export function getSpringProgress(
  frame: number,
  fps: number,
  durationSeconds: number,
): number {
  if (frame <= 0) return 0;
  return spring({
    fps,
    frame,
    config: { damping: 200 },
    durationInFrames: Math.max(1, Math.round(fps * durationSeconds)),
  });
}

/* ---------------------------------------------------------------- interpolate（旧版关键帧映射） */

function findRange(input: number, inputRange: number[]): number {
  let i: number;
  for (i = 1; i < inputRange.length - 1; ++i) {
    if (inputRange[i] >= input) break;
  }
  return i - 1;
}

function interpolateFunction(
  input: number,
  inputRange: number[],
  outputRange: number[],
  options: { extrapolateLeft?: string; extrapolateRight?: string; easing?: (n: number) => number },
): number {
  const { extrapolateLeft = "extend", extrapolateRight = "extend", easing = (num) => num } = options;
  let result = input;
  const [inputMin, inputMax] = inputRange;
  const [outputMin, outputMax] = outputRange;
  if (result < inputMin) {
    if (extrapolateLeft === "identity") return result;
    if (extrapolateLeft === "clamp") result = inputMin;
    else if (extrapolateLeft === "wrap") {
      const range = inputMax - inputMin;
      result = ((((result - inputMin) % range) + range) % range) + inputMin;
    }
  }
  if (result > inputMax) {
    if (extrapolateRight === "identity") return result;
    if (extrapolateRight === "clamp") result = inputMax;
    else if (extrapolateRight === "wrap") {
      const range = inputMax - inputMin;
      result = ((((result - inputMin) % range) + range) % range) + inputMin;
    }
  }
  if (outputMin === outputMax) return outputMin;
  result = (result - inputMin) / (inputMax - inputMin);
  result = easing(result);
  result = result * (outputMax - outputMin) + outputMin;
  return result;
}

function interpolate(
  input: number,
  inputRange: number[],
  outputRange: number[],
  options: { extrapolateLeft?: string; extrapolateRight?: string; easing?: (n: number) => number } = {},
): number {
  if (inputRange.length !== outputRange.length) {
    throw new Error("inputRange and outputRange must have the same length");
  }
  for (let i = 1; i < inputRange.length; ++i) {
    if (!(inputRange[i] > inputRange[i - 1])) {
      throw new Error("inputRange must be strictly monotonically increasing");
    }
  }
  const easing = options.easing ?? ((num: number) => num);
  const extrapolateLeft = options.extrapolateLeft ?? "extend";
  const extrapolateRight = options.extrapolateRight ?? "extend";
  if (typeof input !== "number") throw new TypeError("Cannot interpolate an input which is not a number");
  const range = findRange(input, inputRange);
  return interpolateFunction(
    input,
    [inputRange[range], inputRange[range + 1]],
    [outputRange[range], outputRange[range + 1]],
    { easing, extrapolateLeft, extrapolateRight },
  );
}

/* ---------------------------------------------------------------- 旧版可见索引：最后开始的字幕即当前句 */
/* 旧版 getVisibleSubtitleIndex 只看 startMs，忽略 endMs：
   时间落在间隙时仍显示上一句（已入场完成），不回退、不在间隙清屏。 */

function getVisibleSubtitleIndex(clips: Clip[], currentMs: number): number {
  // 二分找「最后一条 startMs <= 当前时间」：字幕上千条时每帧也不再全量回扫
  let lo = 0;
  let hi = clips.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (currentMs >= clips[mid].startMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* ---------------------------------------------------------------- 旧版入场动效关键帧（spring 进度 + interpolate） */
/* 括号内是旧版 EnterAnimationType 的名字，数值逐条取自 WaterfallSubtitles.tsx / page.chunk.js。 */

function enterMotionOf(fx: EnterFx, p: number): {
  opacity: number;
  scale: number;
  dx: number;
  dy: number;
  rotation: number;
  blur: number;
} {
  // 每段关键帧之间用 smoothstep：速度从 0 起、到 0 收，快速播放时也不像线性平移
  const ip = (ir: number[], or: number[]) =>
    interpolate(p, ir, or, {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: (t) => t * t * (3 - 2 * t),
    });
  const smooth = p * p * (3 - 2 * p);
  switch (fx) {
    case "none": // none
      return { opacity: 1, scale: 1, dx: 0, dy: 0, rotation: 0, blur: 0 };
    case "fade": // fadeIn + fadeOut
      return { opacity: smooth, scale: 1, dx: 0, dy: 0, rotation: 0, blur: 0 };
    case "slideUp": // slideUp
      return { opacity: p, scale: 1, dx: 0, dy: ip([0, 1], [75, 0]), rotation: 0, blur: 0 };
    case "slideLeft": // slideLeft
      return { opacity: p, scale: 1, dx: ip([0, 1], [110, 0]), dy: 0, rotation: 0, blur: 0 };
    case "zoom": // scale
      return { opacity: p, scale: ip([0, 1], [0.15, 1]), dx: 0, dy: 0, rotation: 0, blur: 0 };
    case "pop": // pop
      return {
        opacity: p,
        scale: ip([0, 0.72, 1], [0.4, 1.14, 1]),
        dx: 0,
        dy: ip([0, 1], [28, 0]),
        rotation: 0,
        blur: 0,
      };
    case "bounceUp": // bounceUp
      return {
        opacity: p,
        scale: ip([0, 0.78, 1], [0.85, 1.06, 1]),
        dy: ip([0, 0.76, 1], [150, -24, 0]),
        dx: 0,
        rotation: 0,
        blur: 0,
      };
    case "blur": // blurIn
      return {
        opacity: p,
        scale: ip([0, 1], [1.12, 1]),
        dx: 0,
        dy: 0,
        rotation: 0,
        blur: ip([0, 1], [28, 0]),
      };
    case "swing": // swingIn
      return {
        opacity: p,
        scale: 1,
        dx: ip([0, 1], [-55, 0]),
        dy: ip([0, 1], [18, 0]),
        rotation: ip([0, 0.72, 1], [-26, 7, 0]),
        blur: 0,
      };
    case "typewriter": // typewriter
      return { opacity: 1, scale: 1, dx: 0, dy: 0, rotation: 0, blur: 0 };
    case "fall": // dropIn
      return {
        opacity: p,
        scale: ip([0, 0.6, 0.8, 1], [1, 1, 1.08, 1]),
        dy: ip([0, 0.55, 0.75, 0.9, 1], [-200, 10, -7, 2, 0]),
        dx: 0,
        rotation: 0,
        blur: 0,
      };
    case "rotateIn": // rotateIn
      return {
        opacity: p,
        scale: ip([0, 1], [0.55, 1]),
        dx: ip([0, 1], [-40, 0]),
        dy: 0,
        rotation: ip([0, 1], [-130, 0]),
        blur: 0,
      };
    case "shrink": // zoomOut
      return {
        opacity: ip([0, 0.3, 1], [0, 1, 1]),
        scale: ip([0, 1], [3.4, 1]),
        dx: 0,
        dy: 0,
        rotation: 0,
        blur: ip([0, 0.5, 1], [10, 0, 0]),
      };
    case "elastic": // elasticPop
      return {
        opacity: p,
        scale: ip([0, 0.5, 0.72, 0.88, 1], [0, 1.35, 0.88, 1.08, 1]),
        dx: 0,
        dy: ip([0, 1], [20, 0]),
        rotation: 0,
        blur: 0,
      };
    case "floatUp": // riseFade
      return {
        opacity: p,
        scale: 1,
        dx: 0,
        dy: ip([0, 1], [55, 0]),
        rotation: 0,
        blur: ip([0, 1], [16, 0]),
      };
    default:
      return { opacity: 1, scale: 1, dx: 0, dy: 0, rotation: 0, blur: 0 };
  }
}

/* ---------------------------------------------------------------- 设置读取 */

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value ? value : fallback;

export interface FrameSettings {
  background: string;
  backgroundColor: string;
  backgroundImage: string | null;
  fontSize: number;
  fontColor: string;
  strokeColor: string;
  strokeWidth: number;
  /** 文字描边：outer=单层外描边 / double=双层描边（外深内浅）/ inner=内描边 */
  strokeStyle: "outer" | "double" | "inner";
  /** 双层描边的内圈颜色 */
  strokeColor2: string;
  strokeEnabled: boolean;
  /** 字幕轨所有内容的不透明度，0..1 */
  subtitleOpacity: number;
  motion: MotionName;
  /** 入场动画：每条字幕的 enterAnimation，缺省用全局值 */
  enterFx: EnterFx;
  motionPerClip: boolean;
  motionList: MotionName[];
  stackLimit: number;
  rotationMode: string;
  rotationInterval: number;
  rotationSkipLast: boolean;
  /** 字幕容器锚点，百分数；等价于旧版 anchorX / anchorY × 100 */
  subtitleX: number;
  subtitleY: number;
  aspect: string;
  maxChars: number;
  shadow: boolean;
  /** 字幕风格：custom=自定义字号 / fill=字幕铺满 / fit=屏幕适配（旧版 default/max/scale） */
  subtitleStyle: string;
  /** 屏幕适配比例，百分数（旧版 fitRatio × 100，默认 80） */
  fitRatio: number;
  /** 双层文字风格：底层半透明大字的文字高度占画面高度的百分比（默认 9） */
  duoBackdropScale: number;
  /** 双层文字风格：顶层实色小字的文字高度占画面高度的百分比（默认 5） */
  duoFrontScale: number;
  /** 粒子风格：文字高度占画面高度的百分比（默认 10） */
  particleSize: number;
  /** 粒子风格：汇聚（入场）时长毫秒，0=不使用汇聚（默认 900） */
  particleGatherMs: number;
  /** 粒子风格：飘散（出场）时长毫秒，0=不使用飘散（默认 900） */
  particleScatterMs: number;
  /** 粒子风格：扩散范围百分比，控制汇聚起点与飘散距离（默认 100） */
  particleSpread: number;
  /** 粒子风格：粒子密度档位 1~5，越大粒子越多（默认 3） */
  particleDensity: number;
  minFontSize: number;
  maxFontSize: number;
  fontFamily: string;
  /** 随机样式：关闭时所有字幕统一用全局入场动画（旧版 effSubs），开启时各自的 enterAnimation 生效 */
  randomStyle: boolean;
  /** 入场动画时长（秒）：左栏滑块可拉长过渡，让位移 / 缩放 / 旋转看得清楚 */
  enterDurationSeconds: number;
  /** 打字机逐字露出的时长（秒），不小于入场时长 */
  typewriterDurationSeconds: number;
  /** 字形效果：预览与画面用同一份设置，默认加粗 */
  fontBold: boolean;
  fontItalic: boolean;
  fontUnderline: boolean;
  fontStrike: boolean;
}

/** 中文界面上的入场动画名 → 内部标识 */
export const ENTER_FX_NAMES = [
  "无", "淡入淡出", "上滑入", "左滑入", "缩放", "弹出", "弹跳上浮", "模糊入",
  "摆动入", "打字机", "落下", "旋转入", "缩小退场", "弹性弹出", "上浮淡入",
] as const;

export type EnterFx =
  | "none" | "fade" | "slideUp" | "slideLeft" | "zoom" | "pop" | "bounceUp"
  | "blur" | "swing" | "typewriter" | "fall" | "rotateIn" | "shrink" | "elastic" | "floatUp";

/** 中文界面名 / 旧版英文枚举 / 内部标识，三种写法都能读 */
const ENTER_FX_MAP: Record<string, EnterFx> = {
  "无": "none",
  "淡入淡出": "fade",
  "淡入": "fade",
  "上滑入": "slideUp",
  "左滑入": "slideLeft",
  "缩放": "zoom",
  "弹出": "pop",
  "弹跳上浮": "bounceUp",
  "模糊入": "blur",
  "摆动入": "swing",
  "打字机": "typewriter",
  "落下": "fall",
  "旋转入": "rotateIn",
  "缩小退场": "shrink",
  "弹性弹出": "elastic",
  "上浮淡入": "floatUp",
  none: "none",
  fadeIn: "fade",
  slideUp: "slideUp",
  slideLeft: "slideLeft",
  scale: "zoom",
  pop: "pop",
  bounceUp: "bounceUp",
  blurIn: "blur",
  swingIn: "swing",
  typewriter: "typewriter",
  dropIn: "fall",
  rotateIn: "rotateIn",
  zoomOut: "shrink",
  elasticPop: "elastic",
  riseFade: "floatUp",
};

const FX_VALUES = new Set<EnterFx>([
  "none", "fade", "slideUp", "slideLeft", "zoom", "pop", "bounceUp",
  "blur", "swing", "typewriter", "fall", "rotateIn", "shrink", "elastic", "floatUp",
]);

export function resolveEnterFx(value: unknown): EnterFx {
  if (typeof value !== "string" || !value) return "fade";
  if (ENTER_FX_MAP[value]) return ENTER_FX_MAP[value];
  if (FX_VALUES.has(value as EnterFx)) return value as EnterFx;
  return "fade";
}

export function readFrameSettings(doc: ProjectDocument): FrameSettings {
  const s = doc.settings ?? {};
  /** 默认 350ms：过渡太短看不出动效，太长又拖慢卡点节奏。
   * 回归测试用 enterDurationMs: 200 显式锁定 0.2s 窗口以保留既有基线。 */
  const enterDurationSeconds = Math.max(0.05, Math.min(2, num(s.enterDurationMs, 350) / 1000));
  const typewriterDurationSeconds = Math.max(TYPEWRITER_DURATION_SECONDS, enterDurationSeconds);
  return {
    background: str(s.background, "solid"),
    backgroundColor: str(s.backgroundColor, "#000000"),
    backgroundImage: typeof s.backgroundImage === "string" ? s.backgroundImage : null,
    fontSize: num(s.fontSize, 60),
    fontColor: str(s.fontColor, "#ffffff"),
    strokeColor: str(s.strokeColor, "#ffffff"),
    strokeWidth: Math.max(0, Math.min(16, num(s.strokeWidth, 5))),
    strokeStyle: s.strokeStyle === "double" || s.strokeStyle === "inner" ? s.strokeStyle : "outer",
    strokeColor2: str(s.strokeColor2, "#ffffff"),
    strokeEnabled: Boolean(s.strokeEnabled ?? false),
    subtitleOpacity: Math.max(0, Math.min(1, num(s.subtitleOpacity, 100) / 100)),
    motion: str(s.motion, "up") as MotionName,
    enterFx: resolveEnterFx(s.enterAnimation ?? "fadeIn"),
    motionPerClip: Boolean(s.motionPerClip ?? false),
    motionList: Array.isArray(s.motionList) ? (s.motionList as MotionName[]) : [],
    stackLimit: Math.max(1, Math.min(12, num(s.stackLimit, STACK_LIMIT))),
    rotationMode: str(s.rotationMode, "auto"),
    rotationInterval: Math.max(1, num(s.rotationInterval, 2)),
    rotationSkipLast: Boolean(s.rotationSkipLast ?? true),
    subtitleX: num(s.subtitleX, ANCHOR_X * 100),
    subtitleY: num(s.subtitleY, ANCHOR_Y * 100),
    aspect: str(s.aspect, "landscape"),
    maxChars: Math.max(4, num(s.maxChars, 14)),
    shadow: Boolean(s.shadow ?? true),
    subtitleStyle: str(s.subtitleStyle, "fit"),
    fitRatio: Math.max(20, Math.min(100, num(s.fitRatio, 80))),
    duoBackdropScale: Math.max(2, Math.min(60, num(s.duoBackdropScale, 9))),
    duoFrontScale: Math.max(1, Math.min(40, num(s.duoFrontScale, 5))),
    particleSize: Math.max(2, Math.min(30, num(s.particleSize, 10))),
    particleGatherMs: Math.max(0, Math.min(3000, num(s.particleGatherMs, 900))),
    particleScatterMs: Math.max(0, Math.min(3000, num(s.particleScatterMs, 900))),
    particleSpread: Math.max(20, Math.min(300, num(s.particleSpread, 100))),
    particleDensity: Math.max(1, Math.min(5, Math.round(num(s.particleDensity, 3)))),
    minFontSize: Math.max(8, num(s.minFontSize, 90)),
    maxFontSize: Math.max(8, num(s.maxFontSize, 100)),
    fontFamily: str(s.fontFamily, "Microsoft YaHei"),
    randomStyle: Boolean(s.randomStyle ?? false),
    enterDurationSeconds,
    typewriterDurationSeconds,
    fontBold: Boolean(s.fontBold ?? true),
    fontItalic: Boolean(s.fontItalic ?? false),
    fontUnderline: Boolean(s.fontUnderline ?? false),
    fontStrike: Boolean(s.fontStrike ?? false),
  };
}

/** canvas 的 font 简写：预览里的字形效果与画面渲染共用这一种拼法 */
function fontSpec(size: number, family: string, bold: boolean, italic: boolean): string {
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${family}`;
}

/* ---------------------------------------------------------------- 文字度量（旧版同一套 canvas measureText） */

let fitCtx: CanvasRenderingContext2D | null | undefined;

function getFitCtx(): CanvasRenderingContext2D | null {
  if (fitCtx === undefined) {
    try {
      fitCtx = typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
    } catch {
      fitCtx = null;
    }
  }
  return fitCtx;
}

/** 无 canvas 的纯计算环境用旧版同一套字宽估算兜底 */
const measureCache = new Map<string, number>();
const MEASURE_CACHE_MAX = 2000;

/* ---------------------------------------------------------------- 静止层字形位图缓存（原型，可开关） */
/**
 * 只缓存画面已稳定（入场/换句过渡/旋转全部结束）且打字完成的整行文字。
 * 三条铁律（历史翻车点，务必保持）：
 *   1) key 绝不含镜头倍率 k / fit.scale —— 倍率每帧变会让缓存全失效、越播越卡；
 *   2) 位图盒按对齐方向包住文字：左对齐锚在左缘、右对齐锚在右缘，算反会整句消失；
 *   3) 动画中的当前句不走缓存，杜绝末字闪烁/隐藏。
 * 位图以固定 2× 超采样分辨率渲染，贴回时按 k/SS 缩放，因此 key 与倍率彻底解耦。
 */
const GLYPH_SS = 2;
const GLYPH_CACHE_MAX = 512;
const glyphCache = new Map<string, GlyphBitmap>();
const glyphStats = { hits: 0, misses: 0 };

interface GlyphBitmap {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  /** 文字锚点（左对齐=左缘、右对齐=右缘）在位图中的 x */
  anchorX: number;
  /** 文字垂直中线（对应原 midY）在位图中的 y */
  anchorY: number;
}

/** 运行期开关：默认开；设 globalThis.__JEEK_GLYPH_CACHE__ = false 即回退全矢量 */
function glyphCacheOn(): boolean {
  return (globalThis as Record<string, unknown>).__JEEK_GLYPH_CACHE__ !== false;
}

function glyphKey(layer: SubtitleLayer): string {
  // 只含"文字外观"的静态属性，绝不含 k / fit.scale / 动画参数。
  // ⚠️ align 必须在 key 里：位图锚点随对齐方向而变（右对齐锚在右缘 padL+tw，
  // 左对齐锚在左缘 padL）。外观相同但对齐不同的两条层若共用一张位图，
  // 后画的那条会按别人的锚点贴回，整句漂移一个文字宽度——且谁先建缓存决定
  // 贴成左还是右，表现为历史字幕随机漂移、有概率移回。
  return [
    layer.text.replace(/\s+/g, " "),
    layer.align,
    layer.fontSize, layer.fontFamily,
    layer.fontBold ? 1 : 0, layer.fontItalic ? 1 : 0,
    layer.fontUnderline ? 1 : 0, layer.fontStrike ? 1 : 0,
    layer.fontColor,
    layer.strokeEnabled ? 1 : 0, layer.strokeStyle,
    layer.strokeColor, layer.strokeColor2, layer.strokeWidth,
  ].join("|");
}

function buildGlyphBitmap(layer: SubtitleLayer): GlyphBitmap | null {
  if (typeof document === "undefined") return null;
  const probe = getFitCtx();
  if (!probe) return null;
  const text = layer.text.replace(/\s+/g, " ");
  const size = layer.fontSize * GLYPH_SS;
  const lineH = layer.lineHeight * GLYPH_SS;
  const strokeW = layer.strokeEnabled ? layer.strokeWidth * GLYPH_SS : 0;
  const outer = layer.strokeStyle === "double" ? strokeW * 1.5 : strokeW;
  const blur = 8 * GLYPH_SS;
  const shadowY = 2 * GLYPH_SS;
  const padL = Math.ceil(outer + blur + 2);
  const padR = Math.ceil(outer + blur + 2);
  const padT = Math.ceil(outer + blur + 2);
  const padB = Math.ceil(outer + blur + shadowY + 2);
  const spec = fontSpec(size, layer.fontFamily, layer.fontBold, layer.fontItalic);
  probe.font = spec;
  const tw = probe.measureText(text).width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(tw + padL + padR));
  canvas.height = Math.max(1, Math.ceil(lineH + padT + padB));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = spec;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = layer.fontColor;
  // 位图内始终按左对齐渲染；右对齐的"右缘"锚点 = padL + tw，贴回时右侧对齐 drawX
  const anchorX = layer.align === "right" ? padL + tw : padL;
  const anchorY = padT + lineH / 2;
  const setShadow = (on: boolean) => {
    ctx.shadowColor = on ? "rgba(0,0,0,0.6)" : "transparent";
    ctx.shadowBlur = on ? blur : 0;
    ctx.shadowOffsetY = on ? shadowY : 0;
  };
  setShadow(true);
  if (strokeW > 0) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = layer.strokeColor;
    if (layer.strokeStyle === "double") {
      ctx.lineWidth = strokeW * 3; ctx.strokeText(text, padL, anchorY);
      ctx.strokeStyle = layer.strokeColor2;
      ctx.lineWidth = strokeW * 1.4; ctx.strokeText(text, padL, anchorY);
    } else if (layer.strokeStyle === "outer") {
      ctx.lineWidth = strokeW * 2; ctx.strokeText(text, padL, anchorY);
    }
    setShadow(true);
    ctx.fillText(text, padL, anchorY);
    if (layer.strokeStyle === "inner") {
      setShadow(false);
      ctx.strokeStyle = layer.strokeColor;
      ctx.lineWidth = strokeW * 1.4; ctx.strokeText(text, padL, anchorY);
    }
  } else {
    ctx.fillText(text, padL, anchorY);
  }
  if (layer.fontUnderline || layer.fontStrike) {
    setShadow(false);
    ctx.lineWidth = Math.max(1, size / 18);
    ctx.strokeStyle = layer.fontColor;
    const lineAt = (y: number) => {
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + tw, y); ctx.stroke();
    };
    if (layer.fontUnderline) lineAt(anchorY + size * 0.36);
    if (layer.fontStrike) lineAt(anchorY - size * 0.02);
  }
  return { canvas, w: canvas.width, h: canvas.height, anchorX, anchorY };
}

function getGlyphBitmap(layer: SubtitleLayer): GlyphBitmap | null {
  const key = glyphKey(layer);
  const hit = glyphCache.get(key);
  if (hit) {
    glyphStats.hits += 1;
  } else {
    glyphStats.misses += 1;
    const bmp = buildGlyphBitmap(layer);
    if (!bmp) return null;
    if (glyphCache.size >= GLYPH_CACHE_MAX) glyphCache.clear();
    glyphCache.set(key, bmp);
  }
  // 探针只读：确认缓存真的命中，避免"跑通了但没走缓存"的假绿
  (globalThis as Record<string, unknown>).__JEEK_GLYPH_STATS__ = {
    ...glyphStats, size: glyphCache.size, on: glyphCacheOn(),
  };
  return glyphCache.get(key) ?? null;
}

/** 字体加载完成 / 目录变化后清空量宽缓存：同一文本在回退字体与真字体下宽度不同 */
export function clearMeasureTextCache(): void {
  measureCache.clear();
  glyphCache.clear(); // 字形会变，位图缓存一并失效
  meltRasterCache.clear(); // 粒子采样/文字位图由字体栅格化得到，字体变了必须重采
}

function measureTextWidth(text: string, size: number, family: string, bold = true, italic = false): number {
  const ctx = getFitCtx();
  if (ctx) {
    const spec = fontSpec(size, family, bold, italic);
    const key = `${spec}|${text}`;
    const hit = measureCache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = spec;
    const width = ctx.measureText(text).width;
    if (measureCache.size >= MEASURE_CACHE_MAX) measureCache.clear();
    measureCache.set(key, width);
    return width;
  }
  return [...text].reduce(
    (w, ch) => w + (ch.charCodeAt(0) > 255 ? 0.95 * size : 0.55 * size),
    0,
  );
}

type Sized = {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  fontBold: boolean;
  fontItalic: boolean;
  fontUnderline: boolean;
  fontStrike: boolean;
};

/** 旧版 resolveFontSize：default 原样，medium 放大 30%，max 按最长行反推并夹在 24..600 */
function resolveFontSize(sub: Sized, maxTextWidth: number, fontStyle: string): number {
  const base = sub.fontSize || 60;
  if (fontStyle === "medium") return Math.round(base * 1.3);
  if (fontStyle !== "max") return base;
  const text = sub.text.replace(/\r?\n/g, " ");
  const target = maxTextWidth * 0.96;
  let size = 60;
  const ctx = getFitCtx();
  if (ctx) {
    ctx.font = fontSpec(100, sub.fontFamily, sub.fontBold, sub.fontItalic);
    const w = ctx.measureText(text).width;
    if (w > 0) size = Math.floor((100 * target) / w);
  } else {
    const len = text.replace(/\s/g, "").length || 1;
    size = Math.floor(target / (0.9 * len));
  }
  return Math.max(24, Math.min(600, size));
}

/** 旧版 textWidthOf：精确量文字宽度，夹在 [fontSize, maxTextWidth] */
function textWidthOf(sub: Sized, fontSize: number, maxTextWidth: number): number {
  const width = measureTextWidth(sub.text, fontSize, sub.fontFamily, sub.fontBold, sub.fontItalic);
  return Math.min(maxTextWidth, Math.max(fontSize, width));
}

function fontStyleOf(value: string): "default" | "medium" | "max" | "scale" {
  if (value === "custom") return "default";
  if (value === "fill") return "max";
  if (value === "fit") return "scale";
  if (value === "default" || value === "medium" || value === "max" || value === "scale") return value;
  return "scale";
}

/* ---------------------------------------------------------------- 旧版旋转与对齐 */

type MoveAnimation = "up" | "clockwise90" | "counterclockwise90";
type Align = "left" | "right";

function moveOf(clip: Clip): MoveAnimation {
  const v = String(clip.data.moveAnimation ?? "");
  return v === "clockwise90" || v === "counterclockwise90" ? v : "up";
}

/** 旧版 getRotationDelta：顺时针 +90、逆时针 −90，其余 0 */
function rotationDeltaOf(move: MoveAnimation): number {
  if (move === "clockwise90") return 90;
  if (move === "counterclockwise90") return -90;
  return 0;
}

/** 旧版 getAlignState：由前面最近一次旋转方向决定，没旋转过就左对齐 */
function alignAt(clips: Clip[], index: number): Align {
  let align: Align = "left";
  for (let i = 0; i < index; i += 1) {
    const move = moveOf(clips[i]);
    if (move === "counterclockwise90") align = "left";
    else if (move === "clockwise90") align = "right";
  }
  return align;
}

/* ---------------------------------------------------------------- 帧求值 */

export interface SubtitleLayer {
  id: string;
  text: string;
  index: number;
  /** 0 = 当前句，越大越旧 */
  depth: number;
  enter: number;
  opacity: number;
  /** 淡出系数：淡入淡出风格在句子末尾还要平滑淡出，历史层同样吃到 */
  tailFade: number;
  scale: number;
  dx: number;
  dy: number;
  rotation: number;
  blur: number;
  visibleChars: number;
  motion: MotionName;
  fontSize: number;
  fontColor: string;
  fontFamily: string;
  fontBold: boolean;
  fontItalic: boolean;
  fontUnderline: boolean;
  fontStrike: boolean;
  /** 文字描边：整轨共用同一份设置 */
  strokeEnabled: boolean;
  strokeStyle: "outer" | "double" | "inner";
  strokeColor: string;
  strokeColor2: string;
  strokeWidth: number;
  /** 字幕轨不透明度，与入场动效的 opacity 相乘 */
  trackOpacity: number;
  isCurrent: boolean;
  /** 布局：旧版 DOM 的 left/bottom/text-align 语义，逻辑短边 1440 基准 */
  align: Align;
  /** 相对字幕容器底边向上偏移（逻辑 px） */
  bottom: number;
  textWidth: number;
  lineHeight: number;
  /** 文字锚点在容器内的 x（左对齐 0，右对齐 maxTextWidth） */
  x: number;
  inRotationGroup: boolean;
  /** 画面已稳定（入场 / 换句过渡 / 配对旋转全部完成）：静止层才允许走位图缓存 */
  settled: boolean;
}

/** 旧版旋转组：设了旋转的那条连同更旧的历史层整块绕文字端点转 90° */
export interface RotationGroup {
  pivotX: number;
  bottom: number;
  shiftX: number;
  rotation: number;
  layers: SubtitleLayer[];
}

export interface FitView {
  scale: number;
  tx: number;
  ty: number;
}

export interface EvaluatedFrame {
  timeMs: number;
  layers: SubtitleLayer[];
  settings: FrameSettings;
  currentIndex: number;
  total: number;
  width: number;
  height: number;
  /** 屏幕适配取景：整幅画面的缩放与把当前句对齐到中心的位移（逻辑坐标） */
  fit: FitView;
  /** 字幕容器：左缘、距底边高度、可用文字宽度（逻辑坐标） */
  anchor: { left: number; bottom: number; maxTextWidth: number };
  rotationGroups: RotationGroup[];
  logical: { width: number; height: number; factor: number };
}

type LayoutLayer = {
  index: number;
  sub: Sized;
  fontSize: number;
  delta: number;
  align: Align;
  textWidth: number;
  lineHeight: number;
  offset: number;
};

/**
 * 排序结果按「轨道 clips 数组引用」缓存：播放时工程不变，每帧不再复制 + 排序
 * 几百上千条卡片。工程任何写入都会换新的 clips 数组引用，缓存自动失效，无脏读。
 */
let sortCacheSource: Clip[] | null = null;
let sortCacheOutput: Clip[] = [];
function sortedSubtitleClips(
  track: ProjectDocument["tracks"][number] | undefined,
  hidden: boolean,
): Clip[] {
  if (!track || hidden) return [];
  if (track.clips === sortCacheSource) return sortCacheOutput;
  sortCacheSource = track.clips;
  sortCacheOutput = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  return sortCacheOutput;
}

export function evaluateFrame(
  doc: ProjectDocument,
  timeMs: number,
  width = doc.video.width,
  height = doc.video.height,
): EvaluatedFrame {
  const settings = readFrameSettings(doc);
  const subtitleTrack = doc.tracks.find((t) => t.kind === "subtitle");
  // 轨道总控的眼睛关掉时，这一轨的字幕整条不参与求值：预览与导出都立即看不到
  const clips = sortedSubtitleClips(subtitleTrack, subtitleTrack?.hidden ?? false);
  const fps = doc.video.fps;
  /** 淡入淡出：入场淡入之外，在句子末尾再留一段平滑淡出；只在 fade 风格生效 */
  const tailFadeOf = (clip: Clip): number => {
    if (resolveEnterFx(clip.data.enterAnimation ?? settings.enterFx) !== "fade") return 1;
    const span = Math.max(1, clip.endMs - clip.startMs);
    const window = Math.min(settings.enterDurationSeconds * 1000, span * 0.4);
    if (window <= 0) return 1;
    const t = Math.max(0, Math.min(1, (clip.endMs - timeMs) / window));
    return t * t * (3 - 2 * t);
  };
  // 播放头允许走到「最后一帧末尾」（内容真正结束处），但求值只画到最后一帧：
  // 把越界的 0.5ms 夹回末帧之内，末帧永远是最后一帧、不会画出空白的「第 frames 帧」。
  const safeMs = Math.max(0, Math.min(timeMs, Math.max(0, playheadEndMs(doc))));
  const frame = (safeMs / 1000) * fps;

  /* 旧版 composition 是 2560×1440；实际画布先归一到「短边 1440」的逻辑坐标 */
  const factor = Math.min(width, height) / 1440;
  const logicalWidth = width / factor;
  const logicalHeight = height / factor;
  const anchorLeft = (logicalWidth * settings.subtitleX) / 100;
  const anchorBottom = (logicalHeight * settings.subtitleY) / 100;
  const maxTextWidth = Math.max(160, logicalWidth - anchorLeft - TEXT_RIGHT_PADDING);
  const fontStyle = fontStyleOf(settings.subtitleStyle);
  const fitRatio = settings.fitRatio / 100;

  /** 旧版语义：当前句 = 最后一条 startMs <= 当前时间的字幕（忽略 endMs） */
  const currentIndex = getVisibleSubtitleIndex(clips, timeMs);
  const current = currentIndex === -1 ? undefined : clips[currentIndex];

  const sizedOf = (clip: Clip): Sized => ({
    text: String(clip.data.text ?? ""),
    fontSize: num(clip.data.fontSize, settings.fontSize),
    fontFamily: str(clip.data.fontFamily, settings.fontFamily),
    color: str(clip.data.color, settings.fontColor),
    fontBold: settings.fontBold,
    fontItalic: settings.fontItalic,
    fontUnderline: settings.fontUnderline,
    fontStrike: settings.fontStrike,
  });

  /** 旧版 layerOf：量字号、文字宽度、行高、对齐与旋转方向 */
  const layerOf = (index: number): LayoutLayer => {
    const clip = clips[index];
    const sub = sizedOf(clip);
    const fontSize = resolveFontSize(sub, maxTextWidth, fontStyle);
    return {
      index,
      sub,
      fontSize,
      delta: rotationDeltaOf(moveOf(clip)),
      align: alignAt(clips, index),
      textWidth: textWidthOf(sub, fontSize, maxTextWidth),
      lineHeight: fontSize + 14,
      offset: 0,
    };
  };

  /**
   * 文字左缘在字幕容器内的 x。
   * 左对齐：贴容器左缘（= 屏幕水平位置 subtitleX 的左边距）。
   * 右对齐：文字右缘落在「屏幕宽 − 同样的边距」处 —— 水平位置滑块同时控制
   * 左对齐的左边距与右对齐的右边距，两边对称，右对齐字幕不会贴到画面右缘。
   */
  const textLeftOf = (layer: LayoutLayer): number =>
    layer.align === "right"
      ? logicalWidth - 2 * anchorLeft - layer.textWidth
      : 0;

  /**
   * fitViewOf：屏幕适配取景——每一条字幕出现时，镜头都按这一句缩放到它占画面
   * fitRatio（默认 80%，设 100% 即满格）；历史字幕按同比例向上滚、出画即被裁掉。
   * 取景框只含当前句（宽 = 文字宽，高 = 行高），宽高谁先触到就按谁算。
   * （曾试过把历史句并入取景框来避免历史句出画，但那会让镜头不再按每句占比
   * 缩放、屏幕适配直接失效——哥哥明确裁定屏幕适配语义优先，历史句出画是既定观感。）
   */
  const fitViewOf = (index: number): FitView | null => {
    if (index < 0 || !clips[index]) return null;
    const layer = layerOf(index);
    if (!(layer.textWidth > 0 && layer.lineHeight > 0)) return null;
    // 取景框必须按「实际文字宽度」算：layer.textWidth 是旧版夹取到 maxTextWidth 的值，
    // 长句（实宽超出 maxTextWidth）若按夹取宽度取景，画面只能框住夹取宽度，
    // 文字右端（通常是最后一个字）会被裁出画面——哥哥实测的「吞字」。
    const realWidth = Math.max(
      1,
      measureTextWidth(layer.sub.text, layer.sub.fontSize, layer.sub.fontFamily, layer.sub.fontBold, layer.sub.fontItalic),
    );
    const realLeft = layer.align === "right" ? logicalWidth - 2 * anchorLeft - realWidth : 0;
    const boxLeft = anchorLeft + realLeft;
    const boxWidth = realWidth;
    const scale = Math.max(
      0.01,
      Math.min(
        (logicalWidth * fitRatio) / boxWidth,
        (logicalHeight * fitRatio) / layer.lineHeight,
      ),
    );
    const centerX = boxLeft + boxWidth / 2;
    const centerY = logicalHeight - anchorBottom - layer.lineHeight / 2;
    return {
      scale,
      tx: logicalWidth / 2 - centerX * scale,
      ty: logicalHeight / 2 - centerY * scale,
    };
  };

  const currentLayer = currentIndex >= 0 ? layerOf(currentIndex) : null;
  const currentStartFrame = current
    ? Math.round((current.startMs / 1000) * fps)
    : 0;
  const localFrame = frame - currentStartFrame;

  /* 0.25s smoothstep：既驱动屏幕适配插值，也驱动 A/B 配对旋转 */
  const transitionFrames = Math.max(1, Math.round(fps * FIT_TRANSITION_SECONDS));
  const raw = Math.min(1, Math.max(0, localFrame / transitionFrames));
  const eased = raw * raw * (3 - 2 * raw);

  const previousSubtitle = currentIndex > 0 ? clips[currentIndex - 1] : null;
  const transitionDelta = previousSubtitle ? rotationDeltaOf(moveOf(previousSubtitle)) : 0;
  const pairedRotation = transitionDelta * (eased - 1);

  const targetFit = fontStyle === "scale" ? fitViewOf(currentIndex) : null;
  const previousFit =
    fontStyle === "scale" && currentIndex > 0 ? fitViewOf(currentIndex - 1) : null;
  const fromFit = previousFit ?? targetFit;
  const fit: FitView =
    targetFit && fromFit
      ? {
          scale: fromFit.scale + (targetFit.scale - fromFit.scale) * eased,
          tx: fromFit.tx + (targetFit.tx - fromFit.tx) * eased,
          ty: fromFit.ty + (targetFit.ty - fromFit.ty) * eased,
        }
      : { scale: 1, tx: 0, ty: 0 };

  const layers: SubtitleLayer[] = [];
  const mkLayer = (
    layer: LayoutLayer,
    depth: number,
    bottom: number,
    overrides: Partial<SubtitleLayer>,
  ): SubtitleLayer => ({
    id: clips[layer.index].id,
    text: layer.sub.text,
    index: layer.index,
    depth,
    enter: 1,
    opacity: 1,
    tailFade: tailFadeOf(clips[layer.index]),
    scale: 1,
    dx: 0,
    dy: 0,
    rotation: 0,
    blur: 0,
    visibleChars: Infinity,
    motion: (MOTION_NAMES.includes(clips[layer.index].data.motion as MotionName)
      ? clips[layer.index].data.motion
      : settings.motion) as MotionName,
    fontSize: layer.fontSize,
    fontColor: layer.sub.color,
    fontFamily: layer.sub.fontFamily,
    fontBold: layer.sub.fontBold,
    fontItalic: layer.sub.fontItalic,
    fontUnderline: layer.sub.fontUnderline,
    fontStrike: layer.sub.fontStrike,
    strokeEnabled: settings.strokeEnabled,
    strokeStyle: settings.strokeStyle,
    strokeColor: settings.strokeColor,
    strokeColor2: settings.strokeColor2,
    strokeWidth: settings.strokeWidth,
    trackOpacity: settings.subtitleOpacity,
    isCurrent: depth === 0,
    align: layer.align,
    bottom,
    textWidth: layer.textWidth,
    lineHeight: layer.lineHeight,
    /** 右对齐时是「文字右缘」在容器内的 x；左对齐时是文字左缘（0） */
    x: layer.align === "right" ? textLeftOf(layer) + layer.textWidth : 0,
    inRotationGroup: false,
    settled: false,
    ...overrides,
  });

  if (currentLayer) {
    // 每条字幕自己的 enterAnimation 优先（列表里单条修改直接改这条的数据、立即生效），
    // 没写过的条目退回全局值。全局动画设置是「批量写入每条」，随时可再统一。
    const clipEnter = clips[currentIndex].data.enterAnimation;
    const fx = resolveEnterFx(clipEnter ?? settings.enterFx);
    /** 参与 A/B 配对旋转的新字幕不走自己的入场动画 */
    // 旋转配对期间新字幕同样走自己的入场动效（打字机逐字 / 淡入 / 上滑……），
    // 并叠加配对旋转——不再「旋转时跳过入场导致整行直接出现」。
    const motion = enterMotionOf(fx,
      localFrame <= 0 ? 0 : getSpringProgress(localFrame, fps, settings.enterDurationSeconds));
    let visibleChars = Infinity;
    if (fx === "typewriter") {
      const typewriterDuration = Math.max(1, Math.round(fps * settings.typewriterDurationSeconds));
      const charProgress = interpolate(
        localFrame,
        [0, typewriterDuration],
        [0, currentLayer.sub.text.length],
        { extrapolateRight: "clamp" },
      );
      visibleChars = Math.round(charProgress);
    }
    layers.push(
      mkLayer(currentLayer, 0, 0, {
        enter: localFrame <= 0 ? 0 : getSpringProgress(localFrame, fps, settings.enterDurationSeconds),
        opacity: motion.opacity,
        scale: motion.scale,
        dx: motion.dx,
        dy: motion.dy,
        rotation: motion.rotation + pairedRotation,
        blur: motion.blur,
        visibleChars,
        settled: transitionDelta === 0
          && localFrame > Math.max(transitionFrames, Math.round(fps * settings.enterDurationSeconds)),
      }),
    );
  }

  /* 历史层：向上累加「上一行行高 + 16」，第一层的位移随 0.25s spring 长出来。
     历史层不淡化、不缩小、不旋转 —— 旧版只写 bottom 偏移。 */
  const stackProgress =
    currentIndex > 0 ? getSpringProgress(localFrame, fps, STACK_TRANSITION_SECONDS) : 1;
  const history: LayoutLayer[] = [];
  let rotAt = -1;
  let rotDelta = 0;
  {
    let offset = 0;
    let prevLine = currentLayer ? currentLayer.lineHeight : 0;
    for (let i = currentIndex - 1; i >= 0 && history.length < STACK_LIMIT; i -= 1) {
      const layer = layerOf(i);
      if (layer.delta !== 0) {
        if (rotAt >= 0) break;
        rotAt = history.length;
        rotDelta = layer.delta;
      }
      offset += (prevLine + STACK_GAP) * (history.length === 0 ? stackProgress : 1);
      prevLine = layer.lineHeight;
      layer.offset = offset;
      history.push(layer);
    }
  }

  const historyLayers: SubtitleLayer[] = history.map((layer, n) =>
    mkLayer(layer, n + 1, layer.offset, {
      // 换句过渡（0.25s 堆叠 spring）结束后历史层画面静止，才允许走位图缓存
      settled: localFrame > transitionFrames,
    }),
  );
  layers.push(...historyLayers);

  /* 旋转组：A 与它更早的所有层作为一整块绕 A 的文字端点转 δ，形成 L 型拐角。
     组内层改用相对 A 的 bottom，绘制时统一套组的变换。 */
  const rotationGroups: RotationGroup[] = [];
  if (rotAt >= 0) {
    const pivot = history[rotAt];
    const pivotLeft = textLeftOf(pivot);
    const pivotX = pivot.delta < 0 ? pivotLeft : pivotLeft + pivot.textWidth;
    const nextAlign = rotAt === 0
      ? (currentLayer ? currentLayer.align : "left")
      : history[rotAt - 1].align;
    /** 旋转组的对接端 = 新字幕的对齐锚点（与 mkLayer 的 x 同源）：
        左对齐 = 容器左缘 0；右对齐 = 文字右缘（对称边距语义）。
        此前右对齐写成 maxTextWidth，与文字实际右缘差了 (anchorLeft − 48)，
        旋转组每换句都会平移一大段，观感是「右旋后与下一句割裂、远离」。 */
    const groupAnchorX = nextAlign === "right" ? logicalWidth - 2 * anchorLeft : 0;
    const rotationProgress = rotAt === 0 ? eased : 1;
    const shiftProgress = 1 - Math.pow(1 - rotationProgress, 3);
    const groupBottom = rotAt === 0 ? 0 : history[rotAt - 1].offset;
    const grouped: SubtitleLayer[] = [];
    for (let n = rotAt; n < history.length; n += 1) {
      const layer = mkLayer(history[n], n + 1, history[n].offset - pivot.offset, {
        inRotationGroup: true,
        settled: rotationProgress >= 1,
      });
      grouped.push(layer);
    }
    for (let n = rotAt; n < historyLayers.length; n += 1) {
      layers[n + 1] = grouped[n - rotAt];
    }
    rotationGroups.push({
      pivotX,
      bottom: groupBottom,
      shiftX: (groupAnchorX - pivotX) * shiftProgress,
      rotation: rotDelta * rotationProgress,
      layers: [...grouped].reverse(),
    });
  }

  return {
    timeMs,
    layers,
    settings,
    currentIndex,
    total: clips.length,
    width,
    height,
    fit,
    anchor: { left: anchorLeft, bottom: anchorBottom, maxTextWidth },
    rotationGroups,
    logical: { width: logicalWidth, height: logicalHeight, factor },
  };
}

/* ---------------------------------------------------------------- 画面绘制 */

/** 按显示字数折行：中文一字 1 权重，英文/数字两字符折算 1 个字。
   旧版画面是 whiteSpace:nowrap 不折行，这个工具只给字幕文本分行用。 */
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  let weight = 0;
  for (const ch of text) {
    const w = /[\u4e00-\u9fff]/.test(ch) ? 1 : 0.5;
    if (weight + w > maxChars && line) {
      lines.push(line);
      line = "";
      weight = 0;
    }
    line += ch;
    weight += w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export interface PaintOptions {
  transparent?: boolean;
  image?: CanvasImageSource | null;
  audioLevel?: number;
}

/** 在「容器原点」坐标系里画一层文字（含阴影 / 描边 / 下划线）。
    调用方已把原点平移到容器左缘与底边；动画位移 / 旋转 / 缩放在这里追加。
    k 是有效像素系数（factor × 屏幕适配倍数）：字号 / 阴影 / 坐标全部按它缩放，
    canvas 矩阵里不再有逐帧变化的缩放，Skia 的字形缓存才能稳定命中。 */
function drawLayerText(
  ctx: CanvasRenderingContext2D,
  layer: SubtitleLayer,
  k: number,
): void {
  const size = layer.fontSize * k;
  const textX = layer.x * k;
  const typing = layer.visibleChars !== Infinity;
  const fullText = layer.text.replace(/\s+/g, " ");
  const text = (typing
    ? [...layer.text].slice(0, layer.visibleChars).join("")
    : layer.text).replace(/\s+/g, " ");
  ctx.save();
  // CSS transform: translate(dx,dy) scale(s) rotate(r)，transformOrigin 在文字端点底边
  ctx.translate(layer.dx * k, layer.dy * k);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(layer.scale, layer.scale);

  /** 入场淡入 × 末尾淡出 × 整轨不透明度：轨道拉到 0 时这一轨全隐，背景不受影响 */
  ctx.globalAlpha = layer.opacity * layer.tailFade * layer.trackOpacity;
  if (layer.blur > 0) ctx.filter = `blur(${layer.blur * k}px)`;
  ctx.font = fontSpec(size, layer.fontFamily, layer.fontBold, layer.fontItalic);
  /**
   * 打字机始终把首字钉在「整句写完后的左端」，逐字向右露出。
   * 右对齐字幕若仍用 textAlign=right，首字会贴着右端点、后续字符把整句往左推，
   * 看上去就成了从右往左出现；这里改成左对齐 + 从最终左端起画，动画结束的位置不变。
   */
  ctx.textAlign = typing ? "left" : layer.align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = layer.fontColor;
  const drawX = typing && layer.align === "right"
    ? textX - ctx.measureText(fullText).width
    : textX;
  const midY = -layer.lineHeight * k * 0.5;

  // 静止层位图缓存：只接管画面完全稳定、打字完成、无滤镜的层。
  // 位图以固定 2× 分辨率渲染，这里按 k/SS 缩放贴回——缩放系数/k 都不进缓存 key。
  // 打字机当前句、入场/过渡/旋转中的层一律走下方全矢量路径，保证末字与动画正确。
  if (glyphCacheOn() && layer.settled && !typing && layer.blur === 0) {
    const bmp = getGlyphBitmap(layer);
    if (bmp) {
      const ratio = k / GLYPH_SS;
      const dst = drawX - bmp.anchorX * ratio;
      ctx.drawImage(bmp.canvas, dst, midY - bmp.anchorY * ratio, bmp.w * ratio, bmp.h * ratio);
      ctx.restore();
      return;
    }
  }

  // 旧版 textShadow: 0 2px 8px rgba(0,0,0,0.6)
  const applyTextShadow = () => {
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 8 * k;
    ctx.shadowOffsetY = 2 * k;
  };
  const clearTextShadow = () => {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  applyTextShadow();

  /* 文字描边：strokeText 的线宽是沿字形轮廓居中的，2×w 才留出向外 w 的一圈。
     多层描边时先关阴影，免得几道 stroke 把文字阴影叠成一团黑。 */
  if (layer.strokeEnabled && layer.strokeWidth > 0) {
    const w = layer.strokeWidth * k;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = layer.strokeColor;
    if (layer.strokeStyle === "double") {
      // 双层：外层宽描边 + 内层窄描边，最后落字身
      ctx.lineWidth = w * 3;
      ctx.strokeText(text, drawX, midY);
      ctx.strokeStyle = layer.strokeColor2;
      ctx.lineWidth = w * 1.4;
      ctx.strokeText(text, drawX, midY);
    } else if (layer.strokeStyle === "outer") {
      ctx.lineWidth = w * 2;
      ctx.strokeText(text, drawX, midY);
    }
    applyTextShadow();
    ctx.fillText(text, drawX, midY);
    if (layer.strokeStyle === "inner") {
      // 内描边：字身落定后再压一道细描边，颜色贴在字形边缘上、字身仍是主体
      clearTextShadow();
      ctx.lineWidth = w * 1.4;
      ctx.strokeText(text, drawX, midY);
      applyTextShadow();
    }
  } else {
    ctx.fillText(text, drawX, midY);
  }

  // 下划线 / 删除线按实际画出的文字宽度描线，和字形效果面板用的是同一份设置
  if (layer.fontUnderline || layer.fontStrike) {
    const shownWidth = ctx.measureText(text).width;
    const startX = ctx.textAlign === "right" ? drawX - shownWidth : drawX;
    ctx.lineWidth = Math.max(1, size / 18);
    ctx.strokeStyle = layer.fontColor;
    const strokeAt = (y: number) => {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(startX + shownWidth, y);
      ctx.stroke();
    };
    if (layer.fontUnderline) strokeAt(midY + size * 0.36);
    if (layer.fontStrike) strokeAt(midY - size * 0.02);
  }
  ctx.restore();
}

/** 双层文字风格：同一句画两层——底层半透明大字 + 顶层实色小字，都以画面中心为原点。
 *  两层字号各自按「文字高度占画面高度的百分比」直接取，所有句子用同一字号、宽度随内容自适应。 */
function paintDuoLayers(
  ctx: CanvasRenderingContext2D,
  doc: ProjectDocument,
  s: FrameSettings,
  width: number,
  height: number,
  timeMs: number,
): void {
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  const clips = sortedSubtitleClips(track, track?.hidden ?? false);
  // 只在自身 [startMs, endMs] 区间内显示：过了 endMs 就消失，不延续到下一条、不堆叠
  const active = clips.find((c) => timeMs >= c.startMs && timeMs < c.endMs);
  if (!active) return;
  const text = String(active.data.text ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ");
  if (!text) return;

  // 双层文字吃全局动画（单条 enterAnimation 优先），但不参与随机移动/配对旋转：
  // 两层始终以画面中心为原点同步入场，位移/缩放/模糊都走同一份确定性进度。
  const fps = doc.video.fps;
  const fx = resolveEnterFx(active.data.enterAnimation ?? s.enterFx);
  const localFrame = Math.max(0, Math.round(((timeMs - active.startMs) / 1000) * fps));
  const p = localFrame <= 0 ? 0 : getSpringProgress(localFrame, fps, s.enterDurationSeconds);
  const motion = enterMotionOf(fx, p);
  let shownText = text;
  if (fx === "typewriter") {
    const frames = Math.max(1, Math.round(fps * s.typewriterDurationSeconds));
    const chars = interpolate(localFrame, [0, frames], [0, text.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    shownText = [...text].slice(0, Math.round(chars)).join("");
  }
  const span = Math.max(1, active.endMs - active.startMs);
  const fadeWindow = Math.min(s.enterDurationSeconds * 1000, span * 0.4);
  const tailT = Math.max(0, Math.min(1, (active.endMs - timeMs) / Math.max(1, fadeWindow)));
  const tailFade = fx === "fade" ? tailT * tailT * (3 - 2 * tailT) : 1;

  const family = str(active.data.fontFamily, s.fontFamily);
  const color = str(active.data.color, s.fontColor);
  const opacity = s.subtitleOpacity * motion.opacity * tailFade;
  const cx = width / 2;
  const cy = height / 2;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (motion.blur > 0) ctx.filter = `blur(${motion.blur}px)`;
  ctx.translate(cx + motion.dx, cy + motion.dy);
  ctx.rotate((motion.rotation * Math.PI) / 180);
  ctx.scale(motion.scale, motion.scale);
  ctx.translate(-cx, -cy);

  // 双层字号口径：默认全片跟随同一份全局百分比；单条可在字幕列表写 data.duo*Scale 覆盖。
  // 范围与全局滑块保持一致，避免列表里输入越界值把某一句画成异常大小。
  const backScale = Math.max(2, Math.min(60, num(active.data.duoBackdropScale, s.duoBackdropScale)));
  const frontScale = Math.max(1, Math.min(40, num(active.data.duoFrontScale, s.duoFrontScale)));
  const backSize = height * backScale / 100;
  if (backSize > 0) {
    ctx.globalAlpha = 0.22 * opacity;
    ctx.font = fontSpec(backSize, family, s.fontBold, s.fontItalic);
    ctx.fillStyle = color;
    ctx.fillText(shownText, cx, cy);
  }

  // 顶层：实色小字，中心对齐；字号同样按画面高度百分比取，可单条覆盖，与衬底层用同一句话、同一对齐
  const frontSize = height * frontScale / 100;
  if (frontSize > 0) {
    ctx.globalAlpha = opacity;
    ctx.font = fontSpec(frontSize, family, s.fontBold, s.fontItalic);
    ctx.fillStyle = color;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillText(shownText, cx, cy);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (s.strokeEnabled && s.strokeWidth > 0) {
      const w = s.strokeWidth;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      if (s.strokeStyle === "double") {
        ctx.lineWidth = w * 3; ctx.strokeStyle = s.strokeColor; ctx.strokeText(shownText, cx, cy);
        ctx.lineWidth = w * 1.4; ctx.strokeStyle = s.strokeColor2; ctx.strokeText(shownText, cx, cy);
      } else if (s.strokeStyle === "outer") {
        ctx.lineWidth = w * 2; ctx.strokeStyle = s.strokeColor; ctx.strokeText(shownText, cx, cy);
      }
      if (s.strokeStyle === "inner") {
        ctx.lineWidth = w * 1.4; ctx.strokeStyle = s.strokeColor; ctx.strokeText(shownText, cx, cy);
      }
    }
    if (s.fontUnderline || s.fontStrike) {
      const tw = ctx.measureText(shownText).width;
      ctx.lineWidth = Math.max(1, frontSize / 18);
      ctx.strokeStyle = color;
      const lineAt = (y: number) => {
        ctx.beginPath(); ctx.moveTo(cx - tw / 2, y); ctx.lineTo(cx + tw / 2, y); ctx.stroke();
      };
      if (s.fontUnderline) lineAt(cy + frontSize * 0.36);
      if (s.fontStrike) lineAt(cy - frontSize * 0.02);
    }
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- 粒子风格：实心字 + 多燃点融化场 */

/** 一个沙尘粒子：绑定文字位图上的一个采样点及其融化时刻，随机量由种子固化 */
interface MeltParticle {
  x: number; y: number; t: number;
  s1: number; s2: number; s3: number; s4: number;
}
/** 文字栅格：完整实心字位图 + 逐像素融化时刻场 + 采样粒子，按静态量缓存，绝不含 timeMs */
interface MeltRaster {
  canvas: HTMLCanvasElement;
  /** 文字源像素：构建时取一次，逐帧只从内存拷贝，不再回读 canvas */
  src: ImageData;
  /** 离屏遮罩画布：整张文字贴回后按像素时刻场擦除，燃烧边缘是任意曲线，不是矩形格 */
  mask: HTMLCanvasElement;
  maskData: ImageData;
  bw: number; bh: number;
  /** 每个像素的融化时刻 0~255；汇聚时 <= 进度即显现，飘散时 <= 1-进度仍存在 */
  burn: Uint8Array;
  /** 有墨像素的索引列表，逐帧只处理这些像素 */
  ink: Int32Array;
  particles: MeltParticle[];
}
/** key = 文字|字体外观|颜色|字形效果|密度|clipId；这些静态量不变就复用 */
const meltRasterCache = new Map<string, MeltRaster>();
const MELT_CACHE_MAX = 96;

/** FNV-1a 字符串哈希 → [0,1) 确定性伪随机种子；无 Math.random，预览/导出同位 */
function particleSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** mulberry32：由固定种子派生一串可复现随机数，用来撒燃点/给粒子分配个性 */
function particleRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性二维值噪声：让燃点扩大的边缘像纸灰一样毛糙，而不是规整圆形 */
function particleNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (cx: number, cy: number) => {
    let v = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + Math.imul(seed, 2246822519)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** 密度档位 → 粒子采样步长（px）。档位越高步长越小、粒子越多；5 档逐像素采样 */
const DENSITY_STEP: Record<number, number> = { 1: 12, 2: 8, 3: 5, 4: 3, 5: 1 };

/** 把完整文字（含描边/阴影/下划线）画到离屏画布，供"实心字本体"逐格贴回 */
function paintMeltTextBitmap(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number, size: number,
  family: string, color: string, s: FrameSettings,
): void {
  ctx.font = fontSpec(size, family, s.fontBold, s.fontItalic);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  if (s.strokeEnabled && s.strokeWidth > 0) {
    const w = s.strokeWidth;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    if (s.strokeStyle === "double") {
      ctx.lineWidth = w * 3; ctx.strokeStyle = s.strokeColor; ctx.strokeText(text, x, y);
      ctx.lineWidth = w * 1.4; ctx.strokeStyle = s.strokeColor2; ctx.strokeText(text, x, y);
    } else if (s.strokeStyle === "outer") {
      ctx.lineWidth = w * 2; ctx.strokeStyle = s.strokeColor; ctx.strokeText(text, x, y);
    }
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillText(text, x, y);
    if (s.strokeStyle === "inner") {
      ctx.lineWidth = w * 1.4; ctx.strokeStyle = s.strokeColor; ctx.strokeText(text, x, y);
    }
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  if (s.fontUnderline || s.fontStrike) {
    const tw = ctx.measureText(text).width;
    ctx.lineWidth = Math.max(1, size / 18);
    ctx.strokeStyle = color;
    const lineAt = (ly: number) => {
      ctx.beginPath(); ctx.moveTo(x - tw / 2, ly); ctx.lineTo(x + tw / 2, ly); ctx.stroke();
    };
    if (s.fontUnderline) lineAt(y + size * 0.36);
    if (s.fontStrike) lineAt(y - size * 0.02);
  }
}

/** 构建文字栅格：实心位图 + 多燃点融化时刻场 + 采样粒子（一次 getImageData 同时喂给三者） */
function buildMeltRaster(
  text: string, family: string, color: string, s: FrameSettings,
  size: number, density: number, seedBase: string,
): MeltRaster | null {
  const spec = fontSpec(size, family, s.fontBold, s.fontItalic);
  const styleSig = `${s.strokeEnabled}|${s.strokeStyle}|${s.strokeWidth}|${s.strokeColor}|${s.strokeColor2}|${s.fontUnderline}|${s.fontStrike}`;
  const key = `burn4|${text}|${spec}|${color}|${styleSig}|${density}|${seedBase}`;
  const hit = meltRasterCache.get(key);
  if (hit) return hit;

  let raster: MeltRaster | null = null;
  try {
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return null;
    probe.font = spec;
    const tw = probe.measureText(text).width;
    const pad = Math.ceil(size * 0.6 + (s.strokeEnabled ? s.strokeWidth * 4 : 0)) + 16;
    const bw = Math.max(2, Math.ceil(tw) + pad * 2);
    const bh = Math.max(2, Math.ceil(size * 1.7) + pad * 2);
    const cvs = document.createElement("canvas");
    cvs.width = bw;
    cvs.height = bh;
    const bmp = cvs.getContext("2d", { willReadFrequently: true });
    if (!bmp) return null;
    paintMeltTextBitmap(bmp, text, bw / 2, bh / 2, size, family, color, s);
    const src = bmp.getImageData(0, 0, bw, bh);
    const data = src.data;

    const inkList: number[] = [];
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 8) inkList.push((i - 3) / 4);
    }
    if (!inkList.length) return null;
    const ink = Int32Array.from(inkList);
    const rnd = particleRng(Math.floor(particleSeed(`${seedBase}|${text}|burn`) * 0xffffffff));

    // 纸张燃烧：在字身上随机撒若干燃点，每个燃点有自己的起始时刻与扩张半径。
    // 逐像素取「到最近燃点的距离 / 半径 + 起始时刻」，再乘多尺度噪声 → 毛糙、互相吞并的灰烬边缘。
    const fireCount = Math.max(14, Math.min(48, Math.round(text.length * 3)));
    const fires: { x: number; y: number; t0: number; r: number }[] = [];
    for (let i = 0; i < fireCount; i += 1) {
      // 黄金比例低差异序列 + 抖动：燃点覆盖整句但不排成规则阵列，避免只剩一边先烧
      const u = (i * 0.618033988749895 + rnd() * 0.12) % 1;
      const at = ink[Math.floor(u * ink.length)];
      fires.push({
        x: (at % bw) + 0.5,
        y: Math.floor(at / bw) + 0.5,
        t0: rnd() * 0.22,
        r: size * (0.16 + rnd() * 0.3),
      });
    }
    const raw = new Float32Array(ink.length);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < ink.length; k += 1) {
      const idx = ink[k];
      const px = idx % bw;
      const py = Math.floor(idx / bw);
      const n = 0.36 * particleNoise(px / 23, py / 23, 11)
        + 0.34 * particleNoise(px / 8, py / 8, 23)
        + 0.2 * particleNoise(px / 3, py / 3, 37);
      const rough = (0.55 + 0.95 * n) * (0.9 + 0.2 * particleNoise(px / 1.7, py / 1.7, 53));
      let best = Infinity;
      for (let f = 0; f < fires.length; f += 1) {
        const fire = fires[f];
        const dx = px - fire.x;
        const dy = py - fire.y;
        const v = fire.t0 + Math.sqrt(dx * dx + dy * dy) / (fire.r * rough);
        if (v < best) best = v;
      }
      raw[k] = best;
      if (best < lo) lo = best;
      if (best > hi) hi = best;
    }
    const span = Math.max(1e-6, hi - lo);
    const burn = new Uint8Array(bw * bh);
    for (let k = 0; k < ink.length; k += 1) {
      burn[ink[k]] = Math.round(255 * (0.02 + 0.94 * (raw[k] - lo) / span));
    }

    // 采样粒子：密度决定步长；每颗粒子继承自己所在像素的融化时刻与独立的方向/速度种子。
    const pstep = DENSITY_STEP[density] ?? 6;
    const particles: MeltParticle[] = [];
    for (let y = 0; y < bh; y += pstep) {
      for (let x = 0; x < bw; x += pstep) {
        const idx = y * bw + x;
        if (data[idx * 4 + 3] > 90) {
          particles.push({
            x: x - bw / 2, y: y - bh / 2, t: burn[idx] / 255,
            s1: rnd(), s2: rnd(), s3: rnd(), s4: rnd(),
          });
        }
      }
    }

    const mask = document.createElement("canvas");
    mask.width = bw; mask.height = bh;
    const maskCtx = mask.getContext("2d", { willReadFrequently: true });
    if (!maskCtx) return null;
    raster = {
      canvas: cvs, src, mask, maskData: maskCtx.createImageData(bw, bh),
      bw, bh, burn, ink, particles,
    };
  } catch {
    return null;
  }
  if (meltRasterCache.size >= MELT_CACHE_MAX) meltRasterCache.clear();
  meltRasterCache.set(key, raster);
  return raster;
}

/** 粒子风格：实心字本体按多燃点融化场凝结/烧失 + 沙尘粒子同步汇入/飘出，全部按 timeMs 确定性求值。
 *  静止时是完整实心的原本字体（整张位图一次贴回），只有转场阶段才逐像素碎成沙尘。 */
function paintParticleLayers(
  ctx: CanvasRenderingContext2D,
  doc: ProjectDocument,
  s: FrameSettings,
  width: number,
  height: number,
  timeMs: number,
): void {
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  const clips = sortedSubtitleClips(track, track?.hidden ?? false);
  const active = clips.find((c) => timeMs >= c.startMs && timeMs < c.endMs);
  if (!active) return;
  const text = String(active.data.text ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ");
  if (!text) return;

  const family = str(active.data.fontFamily, s.fontFamily);
  const color = str(active.data.color, s.fontColor);
  const opacity = s.subtitleOpacity;
  const fontSize = height * s.particleSize / 100;
  const raster = buildMeltRaster(text, family, color, s, fontSize, s.particleDensity, String(active.id));
  if (!raster) return;
  const frameStart = performance.now();

  const cx = width / 2;
  const cy = height / 2;
  // 贴回坐标取整：避免整张文字落在半像素上被整体插值发虚
  const dstX = Math.round(cx - raster.bw / 2);
  const dstY = Math.round(cy - raster.bh / 2);
  const duration = active.endMs - active.startMs;
  const local = Math.max(0, Math.min(duration, timeMs - active.startMs));
  // 两个时长都不超过句子时长的一半，保证中间一定有静止成字阶段
  const gatherMs = Math.min(s.particleGatherMs, duration * 0.5);
  const scatterMs = Math.min(s.particleScatterMs, duration * 0.5);
  const scatterStart = duration - scatterMs;
  const spread = s.particleSpread / 100;

  const gathering = gatherMs > 0 && local < gatherMs;
  const scattering = scatterMs > 0 && local >= scatterStart;
  // cut 是「已融化」的分界：汇聚从 0 涨到 1（逐点显现），飘散从 1 落到 0（逐点烧失）
  const gatherP = gathering ? local / gatherMs : 1;
  const scatterP = scattering ? (local - scatterStart) / scatterMs : 0;
  const cut = gathering ? gatherP : 1 - scatterP;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (cut >= 1) {
    // 静止：完整实心的原本字体，一次贴回
    ctx.drawImage(raster.canvas, dstX, dstY);
  } else {
    // 转场：把源像素按融化时刻场写进离屏 ImageData 再一次贴回。
    // 边界是任意曲线，不存在逐格 drawImage 的矩形拼接缝。
    const mk = raster.mask.getContext("2d");
    if (mk) {
      const md = raster.maskData.data;
      md.fill(0);
      {
        const src = raster.src.data;
        const edge = 0.035;
        const ink = raster.ink;
        const burn = raster.burn;
        for (let k = 0; k < ink.length; k += 1) {
          const idx = ink[k];
          const alpha = (cut - burn[idx] / 255) / edge;
          if (alpha <= 0) continue;
          const o = idx * 4;
          md[o] = src[o]; md[o + 1] = src[o + 1]; md[o + 2] = src[o + 2];
          md[o + 3] = src[o + 3] * (alpha >= 1 ? 1 : alpha);
        }
        mk.putImageData(raster.maskData, 0, 0);
        ctx.drawImage(raster.mask, dstX, dstY);
      }
    }
  }

  // 沙尘粒子：每颗粒子继承一个像素的融化时刻，并拥有独立的方向角、速度、摆动相位。
  // 飘散方向以「右」和「右上」为主但角度各不相同；汇聚是同一条轨迹倒放。
  if (gathering || scattering) {
    const particles = raster.particles;
    const dot = Math.max(0.7, Math.min(1.9, fontSize / 72));
    const shortSide = Math.min(width, height);
    ctx.fillStyle = color;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < particles.length; i += 1) {
      const pt = particles[i];
      // 每颗粒子有自己的寿命与缓动指数：不再是同一时刻起步、同一速度齐步走
      const life = 0.2 + 0.26 * pt.s3;
      // 汇聚：融化时刻前 life 段内飞入；飘散：烧失之后 life 段内飘出
      const q = gathering
        ? (gatherP - (pt.t - life)) / life
        : (scatterP - (1 - pt.t)) / life;
      if (q <= 0 || q >= 1) continue;
      const e = Math.pow(q, 0.65 + 1.25 * pt.s4);
      const tx = cx + pt.x;
      const ty = cy + pt.y;
      // 角度：多数偏右，部分右上，没有统一斜率；速度/距离也各自独立
      let angle = -(0.05 + 0.82 * Math.pow(pt.s1, 1.3));
      if (pt.s2 < 0.22) angle *= 0.2;
      const dist = shortSide * spread * (0.1 + 0.28 * pt.s3) * (0.5 + pt.s4);
      const vx = Math.cos(angle) * dist;
      const vy = Math.sin(angle) * dist;
      // 双频摆动 + 呼吸：飞行中扩散、抖动，但整体仍朝右/右上推进
      const phase = q * (4.2 + 5.2 * pt.s3);
      const presence = gathering ? 1 - e : Math.min(1, q * 2.4);
      const swayX = Math.sin(pt.s4 * 17 + phase) * shortSide * 0.014 * spread * presence;
      const swayY = Math.cos(pt.s1 * 19 + phase * 0.8) * shortSide * 0.012 * spread * presence;
      // 弧线扰动：中途绕一下再继续前进，轨迹不再是平行直线
      const arc = Math.sin(Math.PI * q);
      const curl = arc * (pt.s2 - 0.5) * shortSide * 0.085 * spread;
      const lift = arc * (0.3 + 0.7 * pt.s1) * shortSide * 0.028 * spread;
      const x = tx + (gathering ? vx * (e - 1) : vx * e) + swayX + curl;
      const y = ty + (gathering ? vy * (e - 1) : vy * e) + swayY - lift;
      const breath = 1 + 0.2 * Math.sin(pt.s2 * 13 + q * 9);
      const a = Math.pow(1 - q, 1.25) * (0.45 + 0.55 * pt.s2) * breath;
      const sz = dot * (0.45 + 0.55 * breath) * (gathering ? e : Math.max(0.2, 1 - q * 0.85));
      if (a <= 0.01 || sz <= 0.05) continue;
      const halo = sz * 1.6;
      ctx.globalAlpha = a * opacity * 0.28;
      ctx.fillRect(x - halo, y - halo, halo * 2, halo * 2);
      ctx.globalAlpha = a * opacity;
      ctx.fillRect(x, y, sz, sz);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
  // 探针只读：粒子帧真实成本（粒子数 / 燃点像素 / 本次绘制毫秒），用于决定是否上 WebGL
  (globalThis as Record<string, unknown>).__JEEK_MELT_STATS__ = {
    particles: raster.particles.length,
    cells: raster.ink.length,
    density: s.particleDensity,
    cut: Math.round(cut * 100) / 100,
    gathering, scattering,
    transition: gathering || scattering,
    ms: performance.now() - frameStart,
  };
}

/** 屏幕适配只按当前句取景：逻辑短边 1440 等比映射到实际画布 */
export function paintFrame(
  ctx: CanvasRenderingContext2D,
  doc: ProjectDocument,
  timeMs: number,
  width: number,
  height: number,
  options: PaintOptions = {},
): EvaluatedFrame {
  const frame = evaluateFrame(doc, timeMs, width, height);
  const s = frame.settings;
  const { factor } = frame.logical;
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  if (!options.transparent && s.background !== "transparent") {
    if (s.background === "image" && options.image) {
      try {
        const iw = (options.image as HTMLImageElement).width || width;
        const ih = (options.image as HTMLImageElement).height || height;
        const cover = Math.max(width / iw, height / ih);
        const dw = iw * cover;
        const dh = ih * cover;
        ctx.drawImage(options.image, (width - dw) / 2, (height - dh) / 2, dw, dh);
      } catch {
        ctx.fillStyle = s.backgroundColor;
        ctx.fillRect(0, 0, width, height);
      }
    } else {
      ctx.fillStyle = s.backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }
  }

  // 双层文字：独立的双层居中绘制，不走堆叠/入场/fit 那套；只在自身时间区间显示。
  if (s.subtitleStyle === "duo") {
    paintDuoLayers(ctx, doc, s, width, height, timeMs);
    ctx.restore();
    return frame;
  }

  // 粒子文字：汇聚(左→右) + 静止 + 飘散(右上)，确定性求值、可 seek/可导出；
  // 独立分支不走打字机/入场/fit 那套，与本风格互斥。
  if (s.subtitleStyle === "particle") {
    paintParticleLayers(ctx, doc, s, width, height, timeMs);
    ctx.restore();
    return frame;
  }

  // 屏幕适配的缩放不走 canvas 矩阵（矩阵缩放每帧变化会让 Skia 的字形缓存全部失效，
  // 复杂字体每帧重新光栅化导致越播越卡），而是把缩放直接乘进字号与坐标：
  // 屏幕坐标 = (fit.tx + 逻辑x × fit.scale) × factor，字号 = 字号 × fit.scale × factor。
  const k = factor * frame.fit.scale;
  const originX = (frame.fit.tx + frame.anchor.left * frame.fit.scale) * factor;
  const originY = frame.fit.ty * factor + frame.fit.scale * (height - frame.anchor.bottom * factor);

  // 从最旧层画到当前层，保证当前句在最上面（全矢量绘制，不使用位图缓存）。
  for (const layer of [...frame.layers].reverse()) {
    if (layer.inRotationGroup) continue;
    ctx.save();
    ctx.translate(originX, originY - layer.bottom * k);
    drawLayerText(ctx, layer, k);
    ctx.restore();
  }

  for (const group of frame.rotationGroups) {
    ctx.save();
    ctx.translate(originX + group.shiftX * k, originY - group.bottom * k);
    ctx.translate(group.pivotX * k, 0);
    ctx.rotate((group.rotation * Math.PI) / 180);
    ctx.translate(-group.pivotX * k, 0);
    for (const layer of group.layers) {
      ctx.save();
      ctx.translate(0, -layer.bottom * k);
      drawLayerText(ctx, layer, k);
      ctx.restore();
    }
    ctx.restore();
  }

  ctx.restore();
  return frame;
}

/** 确定性帧指纹：给回归测试与导出校验用 */
export function fingerprintFrame(frame: EvaluatedFrame): string {
  const summary = frame.layers
    .map((l) =>
      `${l.id}:${l.depth}:${l.enter.toFixed(3)}:${l.bottom.toFixed(2)}:${l.align}:${l.text}`,
    )
    .join("|");
  const groups = frame.rotationGroups
    .map((g) => `${g.rotation.toFixed(2)}@${g.pivotX.toFixed(1)},${g.bottom.toFixed(1)}`)
    .join(";");
  let h = 2166136261;
  const text = `${frame.timeMs}|${frame.fit.scale.toFixed(4)}|${groups}|${summary}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
