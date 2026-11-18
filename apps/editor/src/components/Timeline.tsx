import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Clip, Track } from "@jeek/contracts";
import {
  deleteClips,
  dragBounds,
  fillGaps,
  fmtTimecode,
  frameMs,
  moveClips,
  patchClip,
  playheadEndMs,
  quantizeMs,
  snapShift,
  snapTime,
  sortTrack,
  splitAllAt,
  trimClip,
  trimRange,
} from "@jeek/core";
import { totalOf, useEditor, type EditorState } from "../store";
import {
  IconFillGap,
  IconLink,
  IconMerge,
  IconPackLeft,
  IconRangeClear,
  IconRangeEnd,
  IconRangeStart,
  IconRedo,
  IconScissors,
  IconTrash,
  IconUndo,
  IconWaveText,
} from "./Icons";
import { snappedRangeValue } from "../lib/range-snap";

type DragMode = "move" | "trim-start" | "trim-end" | "junction" | "scrub" | "marquee";

interface DragState {
  mode: DragMode;
  clipId?: string;
  neighborId?: string;
  startX: number;
  startY: number;
  deltaMs: number;
  marquee: { x: number; y: number; w: number; h: number } | null;
  moved: boolean;
  bounds?: { lo: number; hi: number };
  snapPoints?: number[];
  /** 按下时锁定的整组移动 id（含同步字幕）；实时预览和松手落点共用，避免字幕松手才跳 */
  moveIds?: string[];
  /** 本次鼠标位移是否撞到整组可移动边界：拖动中即时反馈，不用等松手 */
  blocked?: boolean;
}

const MIN_CLICK = 4;
/** 吸附容差：9 像素，且至少一帧 */
const SNAP_PX = 9;
/** selector 必须返回稳定引用：每次新建的空数组会让状态订阅陷入无限重渲染 */
const NO_PEAKS: number[] = [];
const NICE_STEPS = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];

/** 导出范围起点 / 终点的图标在 Icons.tsx 里统一维护，这里只留轨道相关的 */

/* 轨道类型图标：字幕 = T + 文本编辑光标（工字），音频 = 音符 */
function IconSubtitleTrack() {
  return (
    <svg className="jeek-tl-ico jeek-tl-type-ico" viewBox="0 0 20 16" aria-hidden="true">
      <path d="M1.8 3h7.2M5.4 3v9.6" />
      <path d="M15.2 3.6v8.8M13.2 3.6h4M13.2 12.4h4" />
    </svg>
  );
}
function IconAudioTrack() {
  return (
    <svg className="jeek-tl-ico jeek-tl-type-ico" viewBox="0 0 20 16" aria-hidden="true">
      <ellipse cx="5.2" cy="11.5" rx="2.3" ry="1.8" />
      <path d="M7.5 11.5V4.1l6.4-1.5v6.3" />
      <ellipse cx="11.7" cy="9.9" rx="2.2" ry="1.7" />
    </svg>
  );
}

/* 轨道总控图标：锁定（锁头）/ 显隐（眼睛）/ 静音（喇叭） */
function IconLock({ closed }: { closed: boolean }) {
  return (
    <svg className="jeek-tl-ico" viewBox="0 0 16 16" aria-hidden="true">
      {closed
        ? <><path d="M4 7V5.2A4 4 0 0 1 12 5.2V7" /><rect x="3.4" y="7" width="9.2" height="6.2" rx="1.3" /></>
        : <><path d="M5 7.4V5.4A3 3 0 0 1 10.6 4.1" /><rect x="3.4" y="7" width="9.2" height="6.2" rx="1.3" /></>}
    </svg>
  );
}
function IconEye({ off }: { off: boolean }) {
  return (
    <svg className="jeek-tl-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8s2.4-3.8 6-3.8S14 8 14 8s-2.4 3.8-6 3.8S2 8 2 8Z" />
      <circle cx="8" cy="8" r="1.9" />
      {off && <path d="M3 13L13 3" />}
    </svg>
  );
}
function IconMute({ off }: { off: boolean }) {
  return (
    <svg className="jeek-tl-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 6h2.2L8 3.6v8.8L5.2 10H3z" />
      {off
        ? <><path d="M11 6l3 4M14 6l-3 4" /></>
        : <><path d="M10.5 6.2a3 3 0 0 1 0 3.6" /><path d="M12.4 5a5 5 0 0 1 0 6" /></>}
    </svg>
  );
}

/** 轨道设置入口：横向三个点 */
function IconMore() {
  return (
    <svg className="jeek-tl-ico jeek-tl-more-ico" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

/**
 * 剪映式轨道总控：独立固定在时间轴左侧的标题列里（不跟横向滚动走），
 * 顺序为「轨道类型图标 → 锁定 → 显隐/静音 → 三点设置」。不再塞进轨道内容里，
 * 避免遮住标尺起点、也避免把轨道高度撑出多余滚动条。
 */
function TrackMaster({ kind, track }: { kind: "subtitle" | "audio"; track: Track }) {
  const onToggle = (flag: "locked" | "muted" | "hidden") =>
    useEditor.getState().toggleTrackFlag(track.id, flag);
  const panelOpen = useEditor((s) =>
    s.overlay === (kind === "subtitle" ? "trackSubtitle" : "trackAudio"));
  const panelName = kind === "subtitle" ? ("trackSubtitle" as const) : ("trackAudio" as const);
  return (
    <div
      className={`jeek-tl-master jeek-tl-master-${kind}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span
        className="jeek-tl-master-type"
        data-tip={kind === "subtitle" ? "字幕轨" : "音频轨"}
      >
        {kind === "subtitle" ? <IconSubtitleTrack /> : <IconAudioTrack />}
      </span>
      <button
        className={`jeek-tl-master-btn ${track.locked ? "is-on" : ""}`}
        data-tip={track.locked ? "已锁定：本轨卡片不可拖动、裁剪、切分或改名，点此解锁" : "锁定本轨：卡片不可拖动，也不可用 Ctrl+B / Q / W / Delete 编辑"}
        onClick={() => onToggle("locked")}
      >
        <IconLock closed={track.locked} />
      </button>
      {kind === "subtitle" ? (
        <button
          className={`jeek-tl-master-btn ${track.hidden ? "is-on" : ""}`}
          data-tip={track.hidden ? "字幕轨已隐藏，点此恢复显示" : "隐藏本轨字幕：预览与导出都立即看不到，声音不受影响"}
          onClick={() => onToggle("hidden")}
        >
          <IconEye off={Boolean(track.hidden)} />
        </button>
      ) : (
        <button
          className={`jeek-tl-master-btn ${track.muted ? "is-on" : ""}`}
          data-tip={track.muted ? "音轨已静音，点此恢复声音" : "静音本轨音频：播放中点击立即无声，再点立即有声"}
          onClick={() => onToggle("muted")}
        >
          <IconMute off={track.muted} />
        </button>
      )}
      <button
        className={`jeek-tl-master-btn is-more ${panelOpen ? "is-on" : ""}`}
        title={kind === "subtitle" ? "字幕轨设置：不透明度" : "音轨设置：降噪、统一音量、分贝增益"}
        aria-label={kind === "subtitle" ? "字幕轨设置" : "音轨设置"}
        aria-expanded={panelOpen}
        data-act={`track.more.${kind}`}
        onClick={() => useEditor.getState().update({ overlay: panelOpen ? "none" : panelName })}
      >
        <IconMore />
      </button>
    </div>
  );
}

/** 标尺主刻度：分:秒，不足一整秒的主刻度带一位小数 */
const fmtTick = (ms: number): string => {
  const v = Math.max(0, ms);
  const sec = Math.floor(v / 1000);
  const frac = Math.floor((v % 1000) / 100);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}${frac ? `.${frac}` : ""}`;
};

/** 卡片悬停提示用短时间：分:秒.十分之一秒 */
const shortTime = (ms: number): string => {
  const tenths = Math.round(ms / 100);
  const total = Math.floor(tenths / 10);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}.${tenths % 10}`;
};

/** 同步开启且拖的是音频块时，与任一被拖音频块时间重叠的字幕一起走 */
function resolveMoveIds(state: EditorState, clipId?: string): string[] {
  const base = state.doc.selection.clips.length
    ? [...state.doc.selection.clips]
    : clipId ? [clipId] : [];
  const audio = state.doc.tracks.find((t) => t.kind === "audio");
  const movingAudio = audio?.clips.filter((c) => base.includes(c.id)) ?? [];
  if (!state.syncWithAudio || !movingAudio.length) return base;
  const subs = state.doc.tracks.find((t) => t.kind === "subtitle")?.clips ?? [];
  const synced = subs
    .filter((s) => movingAudio.some((a) => s.startMs < a.endMs && s.endMs > a.startMs))
    .map((s) => s.id);
  return [...new Set([...base, ...synced])];
}

/** 位移吸附候选：让被拖卡片的 start/end 落到别人边缘、播放头或整体平移边界上 */
function makeSnapPoints(
  state: EditorState,
  ids: string[],
  clipId: string,
  bounds: { lo: number; hi: number },
): number[] {
  const anchor = state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!anchor) return [bounds.lo];
  const s0 = anchor.startMs;
  const dur = anchor.endMs - anchor.startMs;
  const points = [bounds.lo];
  if (Number.isFinite(bounds.hi)) points.push(bounds.hi);
  const moving = new Set(ids);
  for (const track of state.doc.tracks) {
    for (const clip of track.clips) {
      if (moving.has(clip.id)) continue;
      const a = clip.startMs - s0;
      const b = clip.endMs - s0;
      points.push(a, b, a - dur, b - dur);
    }
  }
  const head = quantizeMs(state.playheadMs, state.doc.video.fps);
  points.push(head - s0, head - s0 - dur);
  return points;
}

function Waveform({ peaks, startMs, endMs, totalMs, width }: { peaks: number[]; startMs: number; endMs: number; totalMs: number; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const canvases = wrap.querySelectorAll("canvas");
    const cssW = Math.max(1, Math.round(width));
    const cssH = 48;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 切片：每块屏幕宽不超过 4096px，位图按 dpr 给足。这样超长音频在 20 倍缩放下
    // 也不会被浏览器「单个画布最大边长」上限截断、再被 CSS 放大糊成一团。
    const TILE = 4096;
    const tiles = Math.max(1, Math.ceil(cssW / TILE));
    const tileW = cssW / tiles;
    const color = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#2f6bff";
    const peakMs = Math.max(1e-6, totalMs / Math.max(1, peaks.length));
    const srcSpan = Math.max(1, endMs - startMs);
    for (let i = 0; i < tiles; i += 1) {
      const canvas = canvases[i] as HTMLCanvasElement | null;
      if (!canvas) continue;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const pW = Math.max(1, Math.min(16384, Math.round(tileW * dpr)));
      const pH = Math.round(cssH * dpr);
      if (canvas.width !== pW) canvas.width = pW;
      if (canvas.height !== pH) canvas.height = pH;
      ctx.setTransform(pW / tileW, 0, 0, pH / cssH, 0, 0);
      ctx.clearRect(0, 0, tileW, cssH);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55;
      const x0 = i * tileW;
      for (let x = 0; x < tileW; x += 2) {
        const tA = startMs + ((x0 + x) / cssW) * srcSpan;
        const tB = startMs + ((x0 + Math.min(tileW, x + 2)) / cssW) * srcSpan;
        const i0 = Math.max(0, Math.min(peaks.length - 1, Math.floor(tA / peakMs)));
        const i1 = Math.max(i0 + 1, Math.min(peaks.length, Math.ceil(tB / peakMs)));
        let peak = 0;
        for (let k = i0; k < i1; k += 1) if (peaks[k] > peak) peak = peaks[k];
        const bar = Math.max(1, peak * cssH * 0.86);
        ctx.fillRect(x, (cssH - bar) / 2, 1.4, bar);
      }
    }
  }, [peaks, startMs, endMs, totalMs, width]);

  const tiles = Math.max(1, Math.ceil(Math.max(1, Math.round(width)) / 4096));
  return (
    <div ref={ref} className="jeek-wave-wrap" style={{ display: "flex", width: "100%", height: "100%", minWidth: 0 }}>
      {Array.from({ length: tiles }).map((_, i) => (
        <canvas key={i} className="jeek-wave-canvas" style={{ flex: "1 1 0", minWidth: 0, height: "100%", display: "block" }} />
      ))}
    </div>
  );
}

/**
 * 播放头时间码：单独订阅播放头毫秒数。播放时它每帧重渲染的只是这一小格文本，
 * 整条时间轴（几百张卡片）不会再跟着每帧重渲染 —— 这是长工程播放越来越卡的主因。
 */
function TimecodeLabel() {
  const playheadMs = useEditor((s) => s.playheadMs);
  const doc = useEditor((s) => s.doc);
  return (
    <span
      className="jeek-tl-time"
      data-tip="播放头时间码：时:分:秒.帧。末位不是小数，而是这一秒里的第几帧（按当前帧率进制）。时间轴定位最远能精确停在最后一张卡片的末端（内容真正结束处），不多一帧也不少一帧。"
    >
      {fmtTimecode(Math.min(playheadMs, Math.max(0, playheadEndMs(doc))), doc.video.fps)}
    </span>
  );
}

/**
 * 播放头竖线 + 跟随滚动：同样只订阅播放头毫秒数。竖线位置与视口滚动都直接
 * 由这一小块组件更新，卡片 DOM 保持静止，播放多久都不会越拖越卡。
 */
function PlayheadCursor({
  pxPerMs,
  trackWidth,
  viewTotalMs,
  zoom,
  followPlayhead,
  viewportRef,
  viewRef,
}: {
  pxPerMs: number;
  trackWidth: number;
  viewTotalMs: number;
  zoom: number;
  followPlayhead: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.MutableRefObject<{ zoom: number; trackWidth: number; scrollLeft: number; playheadMs: number }>;
}) {
  const playheadMs = useEditor((s) => s.playheadMs);

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const prev = viewRef.current;
    if (followPlayhead && prev.playheadMs !== playheadMs && trackWidth > vp.clientWidth + 1) {
      const x = playheadMs * pxPerMs;
      const vw = vp.clientWidth;
      const sl = vp.scrollLeft;
      if (x < sl + 0.08 * vw || x > sl + 0.92 * vw) {
        vp.scrollLeft = Math.max(0, Math.min(trackWidth - vw, x - 0.5 * vw));
      }
    }
    viewRef.current = { ...prev, scrollLeft: vp.scrollLeft, playheadMs };
  }, [playheadMs, pxPerMs, trackWidth, followPlayhead, viewTotalMs]);

  return (
    <div className="jeek-tl-head" style={{ left: playheadMs * pxPerMs }}>
      <span className="jeek-tl-head-knob" />
    </div>
  );
}

export function Timeline({ onCommand }: { onCommand: (name: string) => void }) {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const baseTotalMs = useEditor((s) => s.baseTotalMs);
  const followPlayhead = useEditor((s) => s.followPlayhead);
  const syncOn = useEditor((s) => s.syncWithAudio);
  const autoSortOn = useEditor((s) => s.autoSortOn);
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const peaks = useEditor((s) => s.audio?.peaks ?? NO_PEAKS);
  const audioDuration = useEditor((s) => s.audio?.durationMs ?? 0);
  const commit = useEditor((s) => s.commit);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const [viewport, setViewport] = useState(1200);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * 上一帧的视图状态。缩放锚点必须拿「真实的滚动量」反推：早先把它记在缩放 effect 里、
   * 而播放头跟随 effect 随后又改了 scrollLeft，记录值就和 DOM 对不上，每缩放一档都按错的
   * 锚点重算一次，画面焦点于是来回漂。
   */
  const viewRef = useRef({ zoom, trackWidth: 0, scrollLeft: 0, playheadMs: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientWidth || 1200));
    ro.observe(el);
    setViewport(el.clientWidth || 1200);
    return () => ro.disconnect();
  }, []);

  const subtitleTrack = doc.tracks.find((t) => t.kind === "subtitle");
  const audioTrack = doc.tracks.find((t) => t.kind === "audio");
  const subClips = [...(subtitleTrack?.clips ?? [])].sort((a, b) => a.startMs - b.startMs);
  const audioClips = audioTrack?.clips ?? [];  const range = doc.settings.exportRange as { startMs: number; endMs: number } | null | undefined;
  /** 空态：两条轨道都没有任何卡片。此时播放头锁 0、标尺固定不缩放，轨道内容保持全空 */
  const isEmpty = subClips.length === 0 && audioClips.length === 0;

  const viewTotalMs = totalOf(doc);
  const pxPerMs = (viewport / Math.max(1, baseTotalMs)) * zoom;
  /**
   * 轨道像素宽度向下取整：`viewTotalMs * pxPerMs` 的浮点误差会让轨道比视口
   * 宽出零点几像素，浏览器就凭空画出一条横向滚动条。空态直接对齐视口宽度。
   */
  const trackWidth = Math.max(1, Math.floor(isEmpty ? viewport : viewTotalMs * pxPerMs));
  const msPerPx = viewTotalMs / trackWidth;
  const selected = new Set(doc.selection.clips);
  const hasSelection = selected.size > 0;

  // 主刻度随缩放反比收紧，次刻度每两个主刻度之间再切 5 份
  const baseStep = viewTotalMs <= 10000 ? 1000
    : viewTotalMs <= 30000 ? 2000
    : viewTotalMs <= 90000 ? 5000
    : viewTotalMs <= 180000 ? 10000 : 30000;
  const stepMs = NICE_STEPS.find((v) => v >= baseStep / zoom) ?? 600000;
  const minorStep = Math.max(10, stepMs / 5);
  const ticks: number[] = [];
  const minors: number[] = [];
  for (let t = 0; t <= viewTotalMs; t += stepMs) ticks.push(t);
  for (let t = 0; t <= viewTotalMs; t += minorStep) {
    if (Math.abs(t - Math.round(t / stepMs) * stepMs) > 0.5) minors.push(t);
  }
  /**
   * 靠近右边缘的主刻度文字会伸出轨道外面，把轨道撑宽零点几格并逼出滚动条：
   * 放不下的那一个主刻度只画刻度线，不画文字。
   */
  const labelTicks = ticks.filter((t) => t * pxPerMs <= trackWidth - 34);

  const trackRect = () => viewportRef.current?.querySelector(".jeek-tl-track")?.getBoundingClientRect() ?? null;
  const timeAt = (clientX: number): number => {
    const rect = trackRect();
    if (!rect || !rect.width) return 0;
    return Math.max(0, ((clientX - rect.left) / rect.width) * viewTotalMs);
  };

  /** 手动滚动（滚轮 / 拖滚动条）后把真实滚动量记下来，下一次缩放才锚得准 */
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onScroll = () => {
      viewRef.current.scrollLeft = vp.scrollLeft;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * 缩放锚点：只在倍率变化时让「播放头在屏幕上的横坐标」保持不动。
   * 播放头跟随滚动已移交 PlayheadCursor，这里只在低频的缩放 / 轨道宽度变化时运行，
   * 不再每帧执行，也就不会拖动整条时间轴重渲染。
   */
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const prev = viewRef.current;
    const playheadNow = useEditor.getState().playheadMs;
    const ratio = viewTotalMs > 0 ? Math.min(1, Math.max(0, playheadNow / viewTotalMs)) : 0;
    if (prev.zoom !== zoom && prev.trackWidth > 0) {
      const headX = ratio * prev.trackWidth - prev.scrollLeft;
      const maxScroll = Math.max(0, trackWidth - vp.clientWidth);
      vp.scrollLeft = Math.max(0, Math.min(maxScroll, ratio * trackWidth - headX));
    }
    viewRef.current = { zoom, trackWidth, scrollLeft: vp.scrollLeft, playheadMs: playheadNow };
  }, [zoom, trackWidth, viewTotalMs]);

  /** 拖动期间把光标锁在 html 上，左端 / 右端 / 分界三种手势不混淆 */
  useEffect(() => {
    const cl = document.documentElement.classList;
    const kinds = ["jeek-tl-dragging", "jeek-tl-drag-left", "jeek-tl-drag-right", "jeek-tl-drag-junction", "jeek-tl-drag-blocked"];
    cl.remove(...kinds);
    if (!drag) return;
    cl.add("jeek-tl-dragging");
    const kind = drag.mode === "trim-start" ? "left"
      : drag.mode === "trim-end" ? "right"
      : drag.mode === "junction" ? "junction" : "";
    if (kind) cl.add(`jeek-tl-drag-${kind}`);
    if (drag.blocked) cl.add("jeek-tl-drag-blocked");
    return () => cl.remove(...kinds);
  }, [drag !== null, drag?.mode, drag?.blocked]);

  const setDragState = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const beginDrag = (e: React.MouseEvent, mode: DragMode, clipId?: string, neighborId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    /**
     * 时间轴的 mousedown 一律 preventDefault（否则拖拽会顺手选中文字），
     * 代价是输入框不会自动失焦：点时间轴时手动收掉焦点，字幕列表里的文本编辑状态就能退出。
     */
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && /^(INPUT|TEXTAREA)$/.test(active.tagName)) active.blur();
    // 空态播放头锁在 0：点标尺 / 拖播放头都不响应
    if (mode === "scrub" && isEmpty) return;
    const state = useEditor.getState();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (clipId && mode !== "scrub" && mode !== "marquee") {
      if (additive && mode === "move") {
        // Ctrl / ⌘ / Shift 点卡片只增减选中，不进入拖动
        const ids = state.doc.selection.clips.includes(clipId)
          ? state.doc.selection.clips.filter((id) => id !== clipId)
          : [...state.doc.selection.clips, clipId];
        state.selectClips(ids);
        return;
      }
      // 拖动已选中的卡片时保留整个选区（框选 / Ctrl 多选后拖任一卡片整组移动）；
      // 只有在未选中的卡片上按下，才把选区重置成这一张（旧版 startMove 口径）
      if (!additive && !state.doc.selection.clips.includes(clipId)) state.selectClips([clipId]);
    }
    const fresh = useEditor.getState();
    // 锁定轨道：卡片只可点选，不可拖动 / 裁剪 / 调分界（点选已在上面完成）
    if (clipId && mode !== "scrub" && mode !== "marquee") {
      const clipTrack = fresh.doc.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      if (clipTrack?.locked) return;
    }
    let bounds: DragState["bounds"];
    let snapPoints: number[] | undefined;
    let moveIds: string[] | undefined;
    if (mode === "move" && clipId) {
      const ids = resolveMoveIds(fresh, clipId);
      moveIds = ids;
      bounds = dragBounds(fresh.doc, ids);
      snapPoints = makeSnapPoints(fresh, ids, clipId, bounds);
    }
    if (mode === "scrub") {
      // 按在标尺/播放头上即跟随，不必先点一下
      fresh.seekTo(snapTime(fresh.doc, timeAt(e.clientX), fresh.playheadMs, SNAP_PX, pxPerMs, {
        totalMs: viewTotalMs, enabled: fresh.snapEnabled && !e.altKey,
      }));
    }
    setDragState({
      mode, clipId, neighborId, bounds, snapPoints, moveIds,
      startX: e.clientX, startY: e.clientY,
      deltaMs: 0, marquee: null, moved: false, blocked: false,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const state = useEditor.getState();
      const minMove = d.mode === "move" || d.mode.startsWith("trim") || d.mode === "junction" ? 2 : MIN_CLICK;
      const moved = d.moved || Math.abs(dx) > minMove || Math.abs(dy) > minMove;
      const enabled = state.snapEnabled && !e.altKey;

      if (d.mode === "scrub") {
        state.seekTo(snapTime(state.doc, timeAt(e.clientX), state.playheadMs, SNAP_PX, pxPerMs, {
          totalMs: viewTotalMs, enabled,
        }));
        return;
      }
      if (d.mode === "marquee") {
        const rect = trackRect();
        const x = Math.min(d.startX, e.clientX) - (rect?.left ?? 0);
        const y = Math.min(d.startY, e.clientY) - (rect?.top ?? 0);
        setDragState({ ...d, moved, marquee: { x, y, w: Math.abs(dx), h: Math.abs(dy) } });
        return;
      }

      const raw = dx * msPerPx;
      let deltaMs = 0;
      let blocked = false;
      if (d.mode === "move") {
        const bounds = d.bounds ?? { lo: -Infinity, hi: Infinity };
        const clamped = Math.max(bounds.lo, Math.min(bounds.hi, raw));
        // 鼠标位移真的越过整组边界才算受阻；吸附点造成的位置变化不算。
        // 一开始的微小抖动（还没进入拖动）也不亮，避免误报。
        blocked = moved && Math.abs(clamped - raw) > 1e-6;
        const snapped = snapShift(state.doc, clamped, d.snapPoints ?? [], SNAP_PX, pxPerMs, enabled);
        deltaMs = Math.max(bounds.lo, Math.min(bounds.hi, snapped));
      } else if (d.clipId) {
        const clip = state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
        if (!clip) return;
        const track = state.doc.tracks.find((t) => t.clips.some((c) => c.id === d.clipId));
        /**
         * 边界与真正裁剪共用 `trimRange`：拖动时就按同一份上下限夹住，
         * 不会再出现「预览能拖过头、松手被打回」的两套口径。
         */
        const edge = d.mode === "trim-start" ? "start" : d.mode === "trim-end" ? "end" : "junction";
        const range = trimRange(state.doc, d.clipId, edge, d.neighborId);
        if (!range) return;
        const base = edge === "start" ? clip.startMs : clip.endMs;
        const neighbor = edge === "junction" && d.neighborId
          ? track?.clips.find((c) => c.id === d.neighborId)
          : undefined;
        const skip = edge === "junction"
          ? [base, clip.startMs, neighbor?.endMs ?? base]
          : [base];
        const options = { totalMs: viewTotalMs, enabled, includePlayhead: true, skip };
        const at = Math.max(range.lo, Math.min(range.hi, snapTime(
          state.doc,
          Math.max(range.lo, Math.min(range.hi, base + raw)),
          state.playheadMs,
          SNAP_PX,
          pxPerMs,
          options,
        )));
        deltaMs = at - base;
      }
      setDragState({ ...d, deltaMs, moved, blocked });
    };

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      setDragState(null);
      if (!d) return;
      const state = useEditor.getState();
      const enabled = state.snapEnabled && !e.altKey;

      if (d.mode === "marquee") {
        if (!d.marquee || d.marquee.w < MIN_CLICK) {
          // 空态播放头锁在 0：点在轨道后面的空白处也不改播放头位置
          if (isEmpty) return;
          state.seekTo(snapTime(state.doc, timeAt(e.clientX), state.playheadMs, SNAP_PX, pxPerMs, {
            totalMs: viewTotalMs, enabled,
          }));
          if (state.doc.selection.clips.length) state.selectClips([]);
          return;
        }
        const track = viewportRef.current?.querySelector(".jeek-tl-track");
        const rect = track?.getBoundingClientRect();
        if (!track || !rect) return;
        const l = d.marquee.x;
        const t = d.marquee.y;
        const r = l + d.marquee.w;
        const b = t + d.marquee.h;
        const hits: string[] = [];
        track.querySelectorAll<HTMLElement>(".jeek-tl-clip[data-id], .jeek-tl-audio-clip[data-id]").forEach((el) => {
          const bb = el.getBoundingClientRect();
          const x0 = bb.left - rect.left;
          const x1 = bb.right - rect.left;
          const y0 = bb.top - rect.top;
          const y1 = bb.bottom - rect.top;
          if (x1 > l + 0.5 && x0 < r - 0.5 && y1 > t + 0.5 && y0 < b - 0.5 && el.dataset.id) {
            hits.push(el.dataset.id);
          }
        });
        state.selectClips(hits);
        return;
      }
      if (d.mode === "scrub" || !d.moved || Math.abs(d.deltaMs) < 1e-6 || !d.clipId) return;

      if (d.mode === "move") {
        const ids = d.moveIds?.length ? d.moveIds : resolveMoveIds(state, d.clipId);
        const result = moveClips(state.doc, ids, d.deltaMs);
        if (result.applied !== 0) commit("移动卡片", result.doc);
      } else if (d.mode === "junction" && d.neighborId) {
        commit("调整分界", trimClip(state.doc, d.clipId, "junction", d.deltaMs, d.neighborId));
      } else if (d.mode === "trim-start" || d.mode === "trim-end") {
        commit("裁剪卡片", trimClip(
          state.doc,
          d.clipId,
          d.mode === "trim-start" ? "start" : "end",
          d.deltaMs,
        ));
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag !== null, msPerPx, pxPerMs, viewTotalMs, snapEnabled, commit, isEmpty, audioDuration]);

  const offsetFor = (clip: Clip): number => {
    if (!drag?.moved || drag.mode !== "move") return 0;
    // 用按下时锁定的整组 id（含同步字幕），和松手落点同一份；否则字幕要等 commit 才跳
    const ids = drag.moveIds?.length
      ? drag.moveIds
      : doc.selection.clips.length ? doc.selection.clips : drag.clipId ? [drag.clipId] : [];
    return ids.includes(clip.id) ? drag.deltaMs : 0;
  };

  /** 当前是否属于整组移动（含同步字幕）：拖动中给同步卡片同样的视觉反馈 */
  const inMoveGroup = (clip: Clip): boolean =>
    Boolean(drag?.moved && drag.mode === "move" && drag.moveIds?.includes(clip.id));

  /** 同步字幕、多选卡片共用拖动样式；撞到边界时整组一起给出受阻反馈 */
  const dragClass = (clip: Clip): string => {
    const active = Boolean(drag?.moved && (drag.clipId === clip.id || inMoveGroup(clip)));
    return `${active ? "is-dragging" : ""} ${active && drag?.blocked ? "is-blocked" : ""}`;
  };

  const widthFor = (clip: Clip): number => {
    let start = clip.startMs;
    let end = clip.endMs;
    const min = frameMs(doc.video.fps);
    if (drag?.moved) {
      // 交界拖动：左卡只改右端、右卡只改左端，两个边界同时跟着鼠标走
      if (drag.clipId === clip.id) {
        if (drag.mode === "trim-start") start = Math.min(end - min, start + drag.deltaMs);
        if (drag.mode === "trim-end" || drag.mode === "junction") end = Math.max(start + min, end + drag.deltaMs);
      }
      if (drag.mode === "junction" && drag.neighborId === clip.id) {
        start = Math.min(end - min, clip.startMs + drag.deltaMs);
      }
    }
    return Math.max(0, (end - start) * pxPerMs);
  };

  const leftFor = (clip: Clip): number => {
    let start = clip.startMs + offsetFor(clip);
    if (drag?.moved) {
      if (drag.clipId === clip.id && drag.mode === "trim-start") {
        start = Math.min(clip.endMs - frameMs(doc.video.fps), clip.startMs + drag.deltaMs);
      }
      if (drag.mode === "junction" && drag.neighborId === clip.id) {
        start = Math.min(clip.endMs - frameMs(doc.video.fps), clip.startMs + drag.deltaMs);
      }
    }
    return Math.max(0, start * pxPerMs);
  };

  const editText = (clipId: string, text: string) => {
    const state = useEditor.getState();
    commit("修改字幕", patchClip(state.doc, clipId, { text }));
    setEditing(null);
  };

  const applyAutoSort = () => {
    const s = useEditor.getState();
    if (!s.autoSortOn || !audioTrack?.clips.length) return;
    const next = sortTrack(s.doc, audioTrack.id, s.syncWithAudio);
    if (next !== s.doc) s.commit("音频自动排序", next);
  };

  /** 回到空态时把视图复位：缩放归 1、基准回到空轨长度、播放头回 0，标尺不再停在上一层被压缩的状态 */
  useEffect(() => {
    if (!isEmpty) return;
    const s = useEditor.getState();
    const target = totalOf(s.doc);
    if (s.zoom !== 1 || s.baseTotalMs !== target) s.fitAll();
    if (s.playheadMs !== 0) s.seekTo(0);
  }, [isEmpty]);

  /**
   * 内容变长时把刻度基准跟上（只在 ×1「自动」且内容超出基准时往上补）：
   * 否则基准停在旧长度，轨道会略宽于视口，凭空冒出一条本不该有的横向滚动条。
   * 只增不减——裁剪让内容变短时基准不动，卡片像素宽度不会跟着抖。
   */
  useEffect(() => {
    const s = useEditor.getState();
    if (s.zoom === 1 && viewTotalMs > s.baseTotalMs + 1) {
      s.update({ baseTotalMs: viewTotalMs });
    }
  }, [viewTotalMs, zoom]);

  return (
    <div
      className="jeek-timeline-card"
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) {
          // 空态标尺不缩放：没有内容时按住 Ctrl 滚轮也不动
          if (isEmpty) return;
          e.preventDefault();
          const s = useEditor.getState();
          const step = Math.max(0.25, 0.35 * s.zoom);
          s.setZoom(s.zoom + (e.deltaY < 0 ? step : -step));
        } else if (e.altKey) {
          e.preventDefault();
          const step = Math.max(70, 0.12 * viewport);
          if (viewportRef.current) viewportRef.current.scrollLeft += e.deltaY < 0 ? -step : step;
        }
      }}
    >
      <div className="jeek-tl-toolbar">
        <span className="jeek-tl-title">时间轴</span>
        <TimecodeLabel />

        <span className="jeek-tl-sep" />
        <button
          className="jeek-tl-ico-btn"
          data-act="timeline.fill"
          aria-label={syncOn ? "消除缝隙" : "自动填充"}
          data-tip={syncOn
            ? "消除缝隙：字幕与音频卡片一起向前贴合，任一条轨道先贴住前一张就整组停住。开启「同步」时字幕会跟着音频一起走。"
            : "自动填充：把每条字幕延长到下一条字幕的起始时间，填满字幕之间的空隙，不改动音频片段。"}
          onClick={() => onCommand(syncOn ? "timeline.removeGaps" : "timeline.fill")}
        >
          <IconFillGap />
        </button>
        <button
          className={`jeek-tl-ico-btn is-toggle ${syncOn ? "is-on" : ""}`}
          data-act="timeline.sync"
          aria-label="同步"
          data-tip="同步开关：开启后拖动音频块，会带着同一时间区段的字幕一起移动，保持声画对位；关闭后两条轨道各自独立拖动。左边的贴合按钮也会在「自动填充 / 消除缝隙」之间切换。"
          onClick={() => {
            useEditor.getState().toggleSync();
            applyAutoSort();
          }}
        >
          <IconLink />
        </button>
        <button
          className={`jeek-tl-ico-btn is-toggle ${autoSortOn ? "is-on" : ""}`}
          data-act="timeline.sort"
          aria-label="自动排序"
          data-tip="自动排序：开启后音频轨从 0 帧开始首尾相接——剪短的卡片贴到前一张，第一张卡也贴到 0 帧。同步开启时，落在空隙里的字幕会阻碍贴合。"
          onClick={() => useEditor.getState().toggleAutoSort()}
        >
          <IconPackLeft />
        </button>

        <span className="jeek-tl-sep" />
        <button
          className="jeek-tl-ico-btn"
          data-act="asr.open"
          aria-label="语音转字幕"
          data-tip="打开语音转字幕：先设置断句标准与计算后端，点「开始识别」后会另开进度窗口显示各阶段进度、运行日志和识别出的字幕列表。"
          onClick={() => onCommand("asr.open")}
        >
          <IconWaveText />
        </button>
        <button
          className={`jeek-tl-ico-btn is-toggle ${range?.startMs != null ? "is-on" : ""}`}
          data-act="range.start"
          aria-label="导出范围起点"
          data-tip="在播放头位置设置导出范围起点（快捷键 I）。再次点击可把起点改到新的播放头位置；范围外的轨道会变暗。"
          onClick={() => onCommand("range.start")}
        >
          <IconRangeStart />
        </button>
        <button
          className={`jeek-tl-ico-btn is-toggle ${range?.endMs != null ? "is-on" : ""}`}
          data-act="range.end"
          aria-label="导出范围终点"
          data-tip="在播放头位置设置导出范围终点（快捷键 O）。再次点击可把终点改到新的播放头位置；导出只输出起点到终点之间的内容。"
          onClick={() => onCommand("range.end")}
        >
          <IconRangeEnd />
        </button>
        <button
          className={`jeek-tl-ico-btn ${!range ? "is-disabled" : ""}`}
          data-act="range.clear"
          aria-label="清除导出范围"
          disabled={!range}
          data-tip="清除已设置的导出范围（快捷键 P），区间外不再变暗，导出重新按整条轨道计算。"
          onClick={() => onCommand("range.clear")}
        >
          <IconRangeClear />
        </button>

        <div className="jeek-tl-zoom">
          <span className="jeek-tl-zoom-label">缩放</span>
          <input
            className="jeek-tl-zoom-range"
            type="range"
            min={1}
            max={20}
            step={0.05}
            value={zoom}
            disabled={isEmpty}
            data-snap="1"
            data-tip={isEmpty
              ? "还没有可显示的内容，时间轴不可缩放。载入字幕或音频后即可缩放。"
              : "时间轴缩放：最左端 ×1 自动适应屏幕完整显示整条轨道，向右最大可放大到 ×20，以播放头为中心向两边扩展。也可以用 Ctrl + 滚轮缩放。按住 Alt 临时不吸附。"}
            onChange={(e) => useEditor.getState().setZoom(snappedRangeValue(e))}
          />
          <span className="jeek-tl-zoom-val">{zoom <= 1.001 ? "自动" : `×${zoom.toFixed(1)}`}</span>
        </div>

        <span className="jeek-tl-sep" />
        <button
          className="jeek-tl-ico-btn"
          data-act="undo"
          aria-label="撤销"
          disabled={!canUndo}
          data-tip="撤销上一步编辑（Ctrl+Z）"
          onClick={() => onCommand("undo")}
        >
          <IconUndo />
        </button>
        <button
          className="jeek-tl-ico-btn"
          data-act="redo"
          aria-label="重做"
          disabled={!canRedo}
          data-tip="重做被撤销的编辑（Ctrl+Y / Ctrl+Shift+Z）"
          onClick={() => onCommand("redo")}
        >
          <IconRedo />
        </button>
        <button
          className="jeek-tl-ico-btn"
          data-act="clip.delete"
          aria-label="删除选中"
          disabled={!hasSelection}
          data-tip="删除选中的字幕或音频片段（Delete）"
          onClick={() => onCommand("clip.delete")}
        >
          <IconTrash />
        </button>
        <button
          className="jeek-tl-ico-btn"
          data-act="clip.split"
          aria-label="切分"
          disabled={!hasSelection}
          data-tip="把播放头处的字幕与音频各自截成两段（Ctrl+B）"
          onClick={() => onCommand("clip.split")}
        >
          <IconScissors />
        </button>
        <button
          className="jeek-tl-ico-btn"
          data-act="subtitle.merge"
          aria-label="合并选中"
          disabled={selected.size < 2}
          data-tip="合并选中（Ctrl+E）：把选中的两张以上字幕卡片并成一张——起点取最早那张的开头、终点取最晚那张的末尾，文本按时间顺序拼接，只保留第一张的样式。中间有空隙也会一并填平；选中里有锁定轨的卡片时先解锁再合并。"
          onClick={() => onCommand("subtitle.merge")}
        >
          <IconMerge />
        </button>

        <span className="jeek-tl-hint" data-act="timeline.selection">
          {selected.size === 0 ? "当前无选中卡片" : `已选中 ${selected.size} 张卡片`}
        </span>
      </div>

      <div className="jeek-tl-body">
        {/* 左侧固定标题列：轨道类型图标 + 锁定 + 显隐/静音，不随轨道横向滚动，也不遮挡标尺 */}
        <div className="jeek-tl-headers">
          <div className="jeek-tl-head-ruler" />
          <div className="jeek-tl-head-gap" />
          <div className="jeek-tl-head-lane">{subtitleTrack && <TrackMaster kind="subtitle" track={subtitleTrack} />}</div>
          <div className="jeek-tl-head-gap is-mid" />
          <div className="jeek-tl-head-lane is-audio">{audioTrack && <TrackMaster kind="audio" track={audioTrack} />}</div>
        </div>

        <div className={`jeek-tl-viewport ${isEmpty ? "is-empty" : ""}`} ref={viewportRef}>
          <div className="jeek-tl-track" style={{ width: trackWidth }} onMouseDown={(e) => beginDrag(e, "marquee")}>
            <div className="jeek-tl-ruler" onMouseDown={(e) => beginDrag(e, "scrub")}>
              {minors.map((t) => (
                <span className="jeek-tl-tick-minor" key={`m${t}`} style={{ left: t * pxPerMs }} />
              ))}
              {labelTicks.map((t) => (
                <span className="jeek-tl-tick" key={t} style={{ left: t * pxPerMs + 2 }}>
                  {fmtTick(t)}
                </span>
              ))}
            </div>

          <div className="jeek-tl-gap is-top" />

          <div className="jeek-tl-lane">
            {!subtitleTrack?.hidden && (
              <>
              {subClips.map((clip, index) => {
                const isSelected = selected.has(clip.id);
                const w = widthFor(clip);
                return (
                  <div
                    key={clip.id}
                    data-id={clip.id}
                    className={`jeek-tl-clip ${isSelected ? "is-selected" : ""} ${dragClass(clip)}`}
                    style={{ left: leftFor(clip), width: w }}
                    onMouseDown={(e) => beginDrag(e, "move", clip.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      // 锁定轨道不允许改名
                      const host = useEditor.getState().doc.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
                      if (host?.locked) {
                        useEditor.getState().notify("轨道已锁定，先解锁再修改字幕");
                        return;
                      }
                      setEditing(clip.id);
                    }}
                    title={`${shortTime(clip.startMs)} → ${shortTime(clip.endMs)}  ${String(clip.data.text ?? "")}`}
                  >
                    <span className="jeek-tl-handle" onMouseDown={(e) => beginDrag(e, "trim-start", clip.id)} title="拖动修改起始时间" />
                    {editing === clip.id ? (
                      <input
                        className="clip-editor"
                        autoFocus
                        defaultValue={String(clip.data.text ?? "")}
                        style={{ flex: 1, minWidth: 0, height: 24, margin: "0 2px", fontSize: 11, border: "1px solid var(--border-focus)", borderRadius: 4, background: "var(--surface)", color: "var(--foreground)" }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onBlur={(e) => editText(clip.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") editText(clip.id, e.currentTarget.value);
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <span className="jeek-tl-clip-text">
                        {index + 1}. {String(clip.data.text ?? "")}
                      </span>
                    )}
                    <span className="jeek-tl-handle" onMouseDown={(e) => beginDrag(e, "trim-end", clip.id)} title="拖动修改结束时间" />
                  </div>
                );
              })}
            {/* 分界手柄挂在轨道层而不是卡片里，避免被卡片的 overflow 裁掉半个热区 */}
            {subClips.slice(0, -1).map((clip, i) => {
              const right = subClips[i + 1];
              const joined = Math.abs(right.startMs - clip.endMs) < 1
                && (clip.endMs - clip.startMs) * pxPerMs >= 22
                && (right.endMs - right.startMs) * pxPerMs >= 22;
              if (!joined) return null;
              const live = drag?.moved && drag.mode === "junction" && drag.clipId === clip.id && drag.neighborId === right.id
                ? drag.deltaMs : 0;
              return (
                <span
                  key={`junction-${clip.id}`}
                  className="jeek-tl-junction"
                  style={{ left: (clip.endMs + live) * pxPerMs }}
                  title="拖动调整两张字幕的分界：左边延长、右边缩短"
                  onMouseDown={(e) => beginDrag(e, "junction", clip.id, right.id)}
                />
              );
            })}
              </>
            )}
          </div>

          <div className="jeek-tl-gap is-mid" />

          <div className="jeek-tl-audio-lane">
            {audioClips.map((clip) => {
              const isSelected = selected.has(clip.id);
              return (
                <div
                  key={clip.id}
                  data-id={clip.id}
                  className={`jeek-tl-audio-clip ${isSelected ? "is-selected" : ""} ${dragClass(clip)}`}
                  style={{ left: leftFor(clip), width: widthFor(clip) }}
                  onMouseDown={(e) => beginDrag(e, "move", clip.id)}
                  title={`音频 ${fmtTimecode(clip.startMs, doc.video.fps)} → ${fmtTimecode(clip.endMs, doc.video.fps)} · 源自 ${fmtTimecode(clip.inMs, doc.video.fps)}`}
                >
                  <span
                    className="jeek-tl-audio-handle is-start"
                    title="拖动修改起始时间"
                    onMouseDown={(e) => beginDrag(e, "trim-start", clip.id)}
                  />
                  {peaks.length > 0 && (
                    <Waveform
                      peaks={peaks}
                      startMs={clip.inMs}
                      endMs={clip.inMs + (clip.endMs - clip.startMs)}
                      totalMs={audioDuration}
                      width={widthFor(clip)}
                    />
                  )}
                  <span
                    className="jeek-tl-audio-handle is-end"
                    title="拖动修改结束时间"
                    onMouseDown={(e) => beginDrag(e, "trim-end", clip.id)}
                  />
                </div>
              );
            })}
            {/* 相邻音频卡片之间同样给一个分界手柄：左右两边同时改时长，和字幕卡片一致 */}
            {(() => {
              const sorted = [...audioClips].sort((a, b) => a.startMs - b.startMs);
              return sorted.slice(0, -1).map((clip, i) => {
                const right = sorted[i + 1];
                const joined = Math.abs(right.startMs - clip.endMs) < 1
                  && (clip.endMs - clip.startMs) * pxPerMs >= 22
                  && (right.endMs - right.startMs) * pxPerMs >= 22;
                if (!joined) return null;
                const live = drag?.moved && drag.mode === "junction" && drag.clipId === clip.id && drag.neighborId === right.id
                  ? drag.deltaMs : 0;
                return (
                  <span
                    key={`audio-junction-${clip.id}`}
                    className="jeek-tl-junction is-audio"
                    style={{ left: (clip.endMs + live) * pxPerMs }}
                    title="拖动调整两张音频卡片的分界：左边延长、右边缩短，最多到各自的音频源长度"
                    onMouseDown={(e) => beginDrag(e, "junction", clip.id, right.id)}
                  />
                );
              });
            })()}
          </div>

          {range && (
            <>
              <div className="jeek-tl-range-dim" style={{ left: 0, width: Math.max(0, range.startMs * pxPerMs) }} />
              <div className="jeek-tl-range-dim" style={{ left: range.endMs * pxPerMs, width: Math.max(0, trackWidth - range.endMs * pxPerMs) }} />
            </>
          )}

          <PlayheadCursor
            pxPerMs={pxPerMs}
            trackWidth={trackWidth}
            viewTotalMs={viewTotalMs}
            zoom={zoom}
            followPlayhead={followPlayhead}
            viewportRef={viewportRef}
            viewRef={viewRef}
          />

          {drag?.marquee && drag.marquee.w > MIN_CLICK && (
            <div
              className="jeek-marquee"
              style={{ left: drag.marquee.x, top: drag.marquee.y, width: drag.marquee.w, height: drag.marquee.h }}
            />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 供快捷键调用的裁剪：Q 去掉播放头之前，W 去掉播放头之后 */
export function trimAtPlayhead(side: "q" | "w"): void {
  const state = useEditor.getState();
  const ids = state.doc.selection.clips;
  if (!ids.length) return;
  const hit = state.doc.tracks.flatMap((t) => t.clips.map((c) => ({ c, locked: t.locked }))).find((x) => x.c.id === ids[0]);
  if (!hit) return;
  // 锁定轨道不允许裁剪（Q / W）
  if (hit.locked) {
    state.notify("轨道已锁定，先解锁再裁剪");
    return;
  }
  const clip = hit.c;
  const at = Math.max(clip.startMs, Math.min(clip.endMs, state.playheadMs));
  if (side === "q") {
    const delta = at - clip.startMs;
    if (delta > 0) state.commit("裁剪左端", trimClip(state.doc, clip.id, "start", delta));
  } else {
    const delta = at - clip.endMs;
    if (delta < 0) state.commit("裁剪右端", trimClip(state.doc, clip.id, "end", delta));
  }
}

export { splitAllAt, deleteClips, fillGaps };
