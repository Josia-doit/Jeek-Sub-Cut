import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatGainDb, GAIN_DB_MAX, GAIN_DB_SILENT } from "@jeek/core";
import { useEditor } from "../store";
import { snappedRangeValue } from "../lib/range-snap";

/**
 * 轨道设置浮层锚在三点按钮旁边，不铺遮罩：拖滑块时画布仍然可见，
 * 不透明度与音频处理的效果能直接看出来。按 × 或点浮层外任意位置关闭。
 */
function useAnchor(kind: "subtitle" | "audio") {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 120, top: 200 });
  useLayoutEffect(() => {
    const btn = document.querySelector(`[data-act="track.more.${kind}"]`);
    const el = ref.current;
    if (!btn || !el) return;
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right + 10));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top - h / 2 + 12));
    setPos({ left, top });
  }, [kind]);
  return { ref, pos };
}

/** 连续拖动只改文档，松手合成一条撤销记录 */
const preview = (key: string, value: unknown) =>
  useEditor.getState().previewSetting(key, value);
const commit = (label: string) =>
  useEditor.getState().commitSettingDraft(label);

function PanelShell({
  kind,
  title,
  onClose,
  children,
}: {
  kind: "subtitle" | "audio";
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { ref, pos } = useAnchor(kind);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = ref.current;
      const target = event.target as Element | null;
      if (!el || !target || el.contains(target)) return;
      // 三点按钮自己负责开/关与两个面板之间的切换，不在这里抢先关掉
      if (target.closest?.('[data-act^="track.more."]')) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);
  return (
    <div
      className="jeek-track-pop"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      data-panel={`track.${kind}`}
    >
      <div className="jeek-track-pop-head">
        <span className="jeek-track-pop-title">{title}</span>
        <button
          className="jeek-track-pop-x"
          title="关闭"
          aria-label="关闭"
          data-act={`track.close.${kind}`}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

export function TrackSubtitlePanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const opacity = Number(doc.settings.subtitleOpacity ?? 100);
  return (
    <PanelShell kind="subtitle" title="字幕轨设置" onClose={onClose}>
      <div className="jeek-track-pop-row">
        <div className="jeek-track-pop-label">
          <span>不透明度</span>
          <span className="jeek-track-pop-val" data-act="track.subtitle.opacityValue">
            {Math.round(opacity)}%
          </span>
        </div>
        <input
          className="jeek-track-pop-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={opacity}
          data-snap="1"
          title="整轨字幕的不透明度：100% 原样，向左拖动逐渐变淡，0% 时这一轨的字幕完全隐藏，画布背景不受影响。每 10 档有轻微吸附，按住 Alt 临时不吸附。"
          aria-label="字幕轨不透明度"
          data-act="track.subtitle.opacity"
          onChange={(e) => preview("subtitleOpacity", snappedRangeValue(e))}
          onPointerUp={() => commit("字幕轨不透明度")}
          onKeyUp={() => commit("字幕轨不透明度")}
          onBlur={() => commit("字幕轨不透明度")}
        />
        <div className="jeek-track-pop-scale"><span>0% 全隐</span><span>100% 原样</span></div>
      </div>
    </PanelShell>
  );
}

export function TrackAudioPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const setSetting = useEditor((s) => s.setSetting);
  const noiseReduction = Boolean(doc.settings.audioNoiseReduction ?? false);
  const uniformVolume = Boolean(doc.settings.audioUniformVolume ?? false);
  const gainDb = Number(doc.settings.audioGainDb ?? 0);
  return (
    <PanelShell kind="audio" title="音轨设置" onClose={onClose}>
      <div className="jeek-track-pop-row">
        <label className="jeek-track-pop-check">
          <input
            type="checkbox"
            checked={noiseReduction}
            title="对音轨所有音频做基础降噪"
            data-act="track.audio.noise"
            onChange={(e) => setSetting("audioNoiseReduction", e.currentTarget.checked)}
          />
          <span>
            音频降噪
            <span className="jeek-track-pop-hint">
              对音轨所有音频做基础降噪：滤掉低频隆隆声，压低静音段的底噪。
            </span>
          </span>
        </label>
      </div>

      <div className="jeek-track-pop-row">
        <label className="jeek-track-pop-check">
          <input
            type="checkbox"
            checked={uniformVolume}
            title="把所有音频卡片的音量自动统一"
            data-act="track.audio.uniform"
            onChange={(e) => setSetting("audioUniformVolume", e.currentTarget.checked)}
          />
          <span>
            统一音量
            <span className="jeek-track-pop-hint">
              按每张音频卡片自身的响度自动拉齐，片段之间不再忽大忽小。
            </span>
          </span>
        </label>
      </div>

      <div className="jeek-track-pop-row">
        <div className="jeek-track-pop-label">
          <span>音量增益</span>
          <span className="jeek-track-pop-val" data-act="track.audio.gainValue">
            {formatGainDb(gainDb)}
          </span>
        </div>
        <input
          className="jeek-track-pop-range"
          type="range"
          min={GAIN_DB_SILENT}
          max={GAIN_DB_MAX}
          step={1}
          value={gainDb}
          data-snap="1"
          title="整轨增益：0 dB 是原始音量，向左 30 档降低、向右 30 档增强，最左额外一档 -∞ 为静音。1 dB 一档，每 10 档有轻微吸附，按住 Alt 临时不吸附。"
          aria-label="音轨音量增益"
          data-act="track.audio.gain"
          onChange={(e) => preview("audioGainDb", snappedRangeValue(e))}
          onPointerUp={() => commit("音轨音量增益")}
          onKeyUp={() => commit("音轨音量增益")}
          onBlur={() => commit("音轨音量增益")}
        />
        <div className="jeek-track-pop-scale">
          <span>-∞ 静音</span><span>0 dB 原始</span><span>+30 dB</span>
        </div>
      </div>
    </PanelShell>
  );
}
