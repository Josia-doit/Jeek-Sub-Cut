import { useEffect, useRef } from "react";
import type { ProjectDocument } from "@jeek/contracts";
import { paintFrame, evaluateFrame } from "@jeek/engine";
import { playbackEndMs } from "@jeek/core";
import { audioClockMs, effectivePlaybackGain, stopAudio } from "../lib/media";
import { fontsSettled } from "../lib/fonts";
import { useEditor } from "../store";
import { IconFullscreen, IconMuted, IconPause, IconPlay, IconVolume } from "./Icons";
import { snappedRangeValue } from "../lib/range-snap";

// 诊断用（临时）：把帧求值暴露到 window，便于像素探针核对几何
(window as unknown as { __jeekEvalFrame?: (t: number) => ReturnType<typeof evaluateFrame> }).__jeekEvalFrame =
  (t: number) => evaluateFrame(useEditor.getState().doc, t, 1280, 720);

/** 主界面画布：导出面板只在打开时拷一帧做静态缩略图，逐帧渲染用导出窗口自己的画布 */
export const previewSurface: {
  canvas: HTMLCanvasElement | null;
  paint: ((timeMs: number) => void) | null;
} = { canvas: null, paint: null };

const SIZES: Record<string, [number, number]> = {
  landscape: [1280, 720],
  portrait: [720, 1280],
  square: [720, 720],
  standard: [960, 720],
  story: [720, 900],
  wide: [1680, 720],
};

export function canvasSize(doc: ProjectDocument): [number, number] {
  return SIZES[String(doc.settings.aspect ?? "landscape")] ?? SIZES.landscape;
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

export function Preview({ onCommand }: { onCommand: (name: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playheadMs);
  const volumeMuted = useEditor((s) => s.volumeMuted);
  const masterGain = Number(doc.settings.masterGain ?? 1);
  const effectiveGain = effectivePlaybackGain(doc, volumeMuted);
  const [width, height] = canvasSize(doc);
  /** 透明背景时给播放器套棋盘格，直观提示「此处透明」而非死黑 */
  const transparentBg = doc.settings.background === "transparent";
  /** 播放长度跟随轨道末尾；播放头最远走到最后一帧的末尾（内容真正结束处），
   * 渲染层会把超出末帧的部分夹回最后一帧，所以尾部不再多空白帧，最后一帧也能被选中。 */
  const total = playbackEndMs(doc);
  const headLimit = playbackEndMs(doc);
  /** 空工程没有内容：进度条整条停在 0，不出现 0/0 的 NaN 宽度 */
  const progress = headLimit > 0 ? Math.min(100, (playhead / headLimit) * 100) : 0;

  useEffect(() => {
    let raf = 0;
    /** 没有声音时的起播锚点：-1 表示当前没在放 */
    let stillFrom = -1;
    let stillBase = 0;
    let lastDoc: ProjectDocument | null = null;
    let lastTime = -1;
    let lastImage: HTMLImageElement | null = null;

    /** 绘制逻辑单独抽出来：窗口在后台时 rAF 会被节流，挂载时必须同步画一帧 */
    const render = (force = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const current = useEditor.getState();
      const changed =
        force ||
        current.doc !== lastDoc ||
        current.playheadMs !== lastTime ||
        current.backgroundImage !== lastImage ||
        !fontsSettled();
      if (changed) {
        paintFrame(ctx, current.doc, current.playheadMs, canvas.width, canvas.height, {
          transparent: current.doc.settings.background === "transparent",
          image: current.backgroundImage,
        });
        lastDoc = current.doc;
        lastTime = current.playheadMs;
        lastImage = current.backgroundImage;
      }
      previewSurface.canvas = canvas;
      previewSurface.paint = (timeMs: number) => {
        const s = useEditor.getState();
        paintFrame(ctx, s.doc, timeMs, canvas.width, canvas.height, {
          transparent: s.doc.settings.background === "transparent",
          image: s.backgroundImage,
        });
      };
    };

    const loop = (now: number) => {
      const state = useEditor.getState();
      const limit = playbackEndMs(state.doc);

      if (state.playing) {
        // 有声音就跟着声卡时钟走；纯字幕预览用起播锚点算，两者都不受掉帧影响
        const voiced = audioClockMs();
        let next = voiced;
        if (next === null) {
          if (stillFrom < 0) {
            stillFrom = now;
            stillBase = state.playheadMs;
          }
          next = stillBase + (now - stillFrom);
        }
        const range = state.clipRange;
        if (range && next >= range.to) {
          // 点字幕播片段：到卡片结尾停住，不回绕；声音一并收掉
          state.setPlayhead(range.to);
          state.update({ playing: false });
          state.clearClipRange();
          stopAudio();
        } else if (next >= limit) {
          // 播到结尾停末帧，不回绕、不清零；声音一并收掉，免得画面停了还在响
          state.setPlayhead(limit);
          state.update({ playing: false });
          stopAudio();
        } else {
          state.setPlayhead(next);
        }
      } else {
        stillFrom = -1;
      }
      render();
      raf = requestAnimationFrame(loop);
    };
    render(true);
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seek = (clientX: number) => {
    const bar = stageRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 12) / Math.max(1, rect.width - 24)));
    useEditor.getState().seekTo(ratio * total);
  };

  return (
    <div
      ref={playerRef}
      className={`jeek-player${transparentBg ? " jeek-player--transparent" : ""}`}
      style={{ ["--player-ar" as string]: `${width} / ${height}` }}
      data-act="preview.surface"
      onClick={(e) => {
        // 控制条（进度条、播放 / 静音 / 全屏按钮）各管各的，点画面其余区域才切换播放
        if ((e.target as HTMLElement).closest(".jeek-player-ctrl")) return;
        onCommand("preview.toggle");
      }}
    >
      <canvas ref={canvasRef} width={width} height={height} />
      <div className="jeek-player-ctrl">
        <div className="jeek-player-ctrl-row">
          <button
            className="jeek-ctrl-btn"
            title={playing ? "暂停" : "播放"}
            aria-label={playing ? "暂停" : "播放"}
            onClick={() => onCommand("preview.toggle")}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <div
            className="jeek-volume-wrap"
            data-gain={effectiveGain}
          >
            <button
              className="jeek-ctrl-btn is-small"
              title={volumeMuted ? "取消静音" : "静音"}
              aria-label={volumeMuted ? "取消静音" : "静音"}
              aria-pressed={volumeMuted}
              data-act="preview.mute"
              onClick={() => useEditor.getState().setVolumeMuted(!volumeMuted)}
            >
              {volumeMuted ? <IconMuted /> : <IconVolume />}
            </button>
            <div className="jeek-volume-pop">
              <span className="jeek-volume-num" data-act="preview.volumeValue">
                {volumeMuted ? "静音" : Math.round(masterGain * 100)}
              </span>
              <input
                className="jeek-volume-slider"
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(masterGain * 100)}
                style={{ ["--vol-fill" as string]: `${Math.round(masterGain * 100)}%` }}
                title="总音量：向上推到 100% 是原始音量，向下降低，0% 静音。静音时拖动会自动恢复声音。每 10 档有轻微吸附，按住 Alt 临时不吸附。"
                aria-label="总音量"
                data-act="preview.volume"
                data-snap="1"
                onChange={(e) => useEditor.getState().setMasterGain(snappedRangeValue(e) / 100, false)}
                onPointerUp={(e) => useEditor.getState().setMasterGain(snappedRangeValue(e) / 100, true)}
                onKeyUp={(e) => useEditor.getState().setMasterGain(snappedRangeValue(e) / 100, true)}
              />
            </div>
          </div>
          <span className="jeek-ctrl-time">
            {clock(playhead)} / {clock(total)}
          </span>
          <span className="jeek-ctrl-spacer" />
          <button
            className="jeek-ctrl-btn jeek-ctrl-full"
            title="全屏"
            aria-label="全屏"
            onClick={() => {
              const el = playerRef.current;
              if (!el) return;
              if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
              else void el.requestFullscreen?.().catch(() => {});
            }}
          >
            <IconFullscreen />
          </button>
        </div>
        <div
          className="jeek-progress"
          ref={stageRef}
          onMouseDown={(e) => {
            seek(e.clientX);
            const move = (ev: MouseEvent) => seek(ev.clientX);
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <div className="jeek-progress-fill" style={{ width: `${progress}%` }} />
          <div className="jeek-progress-knob" style={{ left: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}
