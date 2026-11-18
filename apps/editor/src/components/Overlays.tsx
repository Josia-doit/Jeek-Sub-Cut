import { useCallback, useEffect, useRef, useState } from "react";
import type { Clip } from "@jeek/contracts";
import { paintFrame } from "@jeek/engine";
import {
  DEFAULT_FONT_FAMILY,
  EXPORT_CRF_SLIDER_MAX,
  EXPORT_CRF_SLIDER_MIN,
  EXPORT_QUALITY,
  applyStyleRules,
  countMatches,
  defaultFontLabel,
  durationOf,
  fmtTimecode,
  fontNamesFromFile,
  fontFamilyOfFile,
  frameCountOf,
  insertClip,
  isSystemFont,
  mergeFontEntries,
  normalizeExportConfig,
  replaceSubtitleText,
  setSetting,
  sliceDocument,
  type ExportAccel,
  type ExportCodec,
  type ExportQuality,
  type FontEntry,
  type FontLabel,
} from "@jeek/core";
import {
  appendRecording,
  audioContext,
  audioToWavBuffer,
  computePeaks,
  exportVideoFrames,
  fetchAsrConfig,
  recognizeOnServer,
  renderTrackAudio,
  type RenderPhase,
  type RenderStageInfo,
  type AsrBackendOption,
  type AsrConfig,
} from "../lib/media";
import {
  defaultExportDir,
  downloadExport,
  freeSpaceOf,
  hasDesktopBridge,
  openDirectory,
  pickDirectory,
  readFontFile,
  revealInFolder,
} from "../lib/bridge";
import { isAltHeld, snappedRangeValue } from "../lib/range-snap";
import { cuesFromDocument, downloadBlob, downloadText, toSrt } from "../lib/srt";
import {
  applyFontFaces,
  ensureFontsLoaded,
  importFontByPath,
  importFontFile,
  loadFontLabels,
  normalizeUserPath,
  openFontsDirectory,
  removeFontFromCatalog,
  saveFontCatalog,
  scanFontsDirectory,
  setFontLabel,
  type FontLabels,
} from "../lib/fonts";
import { IconBold, IconFolderOpen, IconItalic, IconPencil, IconStrike, IconUnderline } from "./Icons";
import { loadAsrSplit } from "../modules.config";
import { canvasSize, previewSurface } from "./Preview";
import { useEditor, type AudioState } from "../store";

const RENDER_URL =
  (import.meta.env.VITE_RENDER_URL as string | undefined) ?? "http://127.0.0.1:5174";

/** MOV 的 ProRes 规格（ffmpeg profile 4 / 5）与画质档位（qscale 2 / 8 / 20，越小画质越好、文件越大） */
type MovSpec = "4444" | "4444xq";
type MovQuality = "fine" | "standard" | "light";
const MOV_QSCALE: Record<MovQuality, number> = { fine: 2, standard: 8, light: 20 };
const MOV_QUALITY_LABEL: Record<MovQuality, string> = { fine: "精细", standard: "标准", light: "轻量" };

/** 预估导出体积（GB）：基于各格式参考码率，按 分辨率×帧率 相对 1080p30 线性换算。
 * 仅作量级参考，实际体积随画面复杂度浮动；用途是导出前提醒用户避免意外的大文件。 */
function estimateExportSizeGB(opts: {
  format: "mp4" | "mov"; codec: string; quality: string; movQuality: string;
  width: number; height: number; fps: number; seconds: number;
}): number {
  const ref = 1920 * 1080 * 30;
  const scale = (opts.width * opts.height * opts.fps) / ref;
  let mbps: number;
  if (opts.format === "mp4") {
    // 1080p30 参考码率（Mbps）：快速偏高、精细偏低；H.265 约为 H.264 的一半
    const base = opts.quality === "fast" ? 18 : opts.quality === "high" ? 6 : 12;
    mbps = (opts.codec === "h265" ? base * 0.5 : base) * scale;
  } else {
    // ProRes 4444 实测约 150 Mbps@1080p30（近恒定码率，画质档位只做小幅调节）
    const qMul = opts.movQuality === "fine" ? 1.0 : opts.movQuality === "standard" ? 0.85 : 0.6;
    mbps = 150 * qMul * scale;
  }
  return ((mbps / 8) * opts.seconds) / 1024;
}

/** 把 GB 数值格式化成易读字符串 */
function formatSize(gb: number): string {
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(gb * 1024))} MB`;
}

/**
 * 逐帧渲染阶段的临时帧磁盘占用：每帧先存成图片再交给 ffmpeg 编码。
 * MOV 走无损 PNG（1080p 实测约 1 MB/帧），MP4 走 JPEG q0.94（约 200 KB/帧），按像素面积线性外推。
 */
function estimateTempGB(opts: { format: "mp4" | "mov"; width: number; height: number; frames: number }): number {
  const perFrame = (opts.format === "mov" ? 1.05 : 0.2) * 1048576;
  const scale = (opts.width * opts.height) / (1920 * 1080);
  return (Math.max(0, opts.frames) * perFrame * scale) / 1073741824;
}

const ASPECTS = [
  { value: "landscape", label: "16:9 横屏" },
  { value: "portrait", label: "9:16 竖屏" },
  { value: "square", label: "1:1 方形" },
  { value: "standard", label: "4:3 横屏" },
  { value: "story", label: "4:5 竖屏" },
  { value: "wide", label: "21:9 宽屏" },
];
const FPS = [24, 25, 30, 50, 60];
const RESOLUTIONS = [
  { value: "1080P", label: "1080P" },
  { value: "1440P", label: "1440P (2K)" },
  { value: "2160P", label: "2160P (4K)" },
];
const RES_TABLE: Record<string, string> = {
  "1080P": "1920×1080",
  "1440P": "2560×1440",
  "2160P": "3840×2160",
};
const ASPECT_RATIO: Record<string, number> = {
  landscape: 16 / 9,
  portrait: 9 / 16,
  square: 1,
  standard: 4 / 3,
  story: 4 / 5,
  wide: 21 / 9,
};

/** 逻辑画布的实际像素：短边固定，另一边按比例推出来 */
function canvasLabel(doc: { settings: Record<string, unknown> }): string {
  const short = Number(doc.settings.logicalShortEdge ?? 1440);
  const ratio = ASPECT_RATIO[String(doc.settings.aspect ?? "landscape")] ?? 16 / 9;
  const w = ratio >= 1 ? Math.round(short * ratio) : short;
  const h = ratio >= 1 ? short : Math.round(short / ratio);
  return `${w}×${h}`;
}

const ASPECT_PARTS: Record<string, [string, string]> = {
  landscape: ["16:9", "横屏"],
  portrait: ["9:16", "竖屏"],
  square: ["1:1", "方形"],
  standard: ["4:3", "横屏"],
  story: ["4:5", "竖屏"],
  wide: ["21:9", "宽屏"],
};

/** 导出文件名默认按时间戳起：20261110-182751 */
function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 导出默认名：时间戳在前，后面跟素材名（音频优先，其次导入的字幕文件）；都没有就只有时间戳。
 * 素材名去掉扩展名和非法字符，避免 safeExportName 把整个后缀当成容器后缀吃掉。 */
function defaultExportName(audioName: string | null, subtitleName: string | null): string {
  const stamp = stampName();
  const importedSubtitle = subtitleName && subtitleName !== "语音转字幕" ? subtitleName : null;
  const source = (audioName?.trim() || importedSubtitle?.trim() || "").replace(/[\\/:*?"<>|]/g, "_");
  const base = source.replace(/\.[a-z0-9]+$/i, "");
  return base ? `${stamp}_${base}` : stamp;
}

/** 时:分:秒，导出计时与录音计时共用 */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** 秒数保留一位，用于时长对比 */
function fmtSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
}

/** 预览框按成片真实比例给尺寸：面积大致恒定，竖屏不会变成一条窄缝 */
function previewBox(width: number, height: number, area: number, maxHeight = 420): { w: number; h: number } {
  const ratio = width / Math.max(1, height);
  const h = Math.min(maxHeight, Math.round(Math.sqrt(area / ratio)));
  return { w: Math.round(h * ratio), h };
}

/** 并行帧数档位：自动交给 ffmpeg，手动档可一直加到 24 线程 */
const CONCURRENCY_STEPS = [0, 4, 8, 12, 16, 24];

/**
 * 全局悬浮提示：主界面与所有弹出面板里，任何带 `data-tip` 的元素指向即显示。
 * 说明文字不占界面空间，也不受面板 overflow 裁剪（浮层挂在 document 上）。
 */
export function TipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    // 必须用 Element 而不是 HTMLElement：按钮里的图标是 SVG，<path> 属于 SVGElement，
    // 用 HTMLElement 判定会让指针一移进图标就判成「没有提示」，出现按钮边缘有、中心没有的割裂感
    const pick = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null;
    const onOver = (e: MouseEvent) => {
      const text = pick(e.target)?.getAttribute("data-tip") ?? "";
      setTip(text ? { text, x: e.clientX, y: e.clientY } : null);
    };
    const onMove = (e: MouseEvent) => {
      setTip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : null));
    };
    const onOut = (e: MouseEvent) => {
      const from = pick(e.target);
      const to = pick(e.relatedTarget);
      if (from && from !== to) setTip(null);
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
    };
  }, []);
  if (!tip) return null;
  const left = Math.min(Math.max(12, tip.x + 16), Math.max(12, window.innerWidth - 332));
  const flip = tip.y + 26 + 96 > window.innerHeight;
  return (
    <div
      className="jeek-tip-pop"
      style={{
        left,
        top: flip ? tip.y - 14 : tip.y + 22,
        transform: flip ? "translateY(-100%)" : undefined,
      }}
    >
      {tip.text}
    </div>
  );
}

/** 通用外壳：点遮罩不关闭，只有面板上的关闭按钮能关 */
function Modal({
  title,
  width,
  minHeight,
  height,
  bodyClassName,
  onClose,
  children,
  foot,
}: {
  title: string;
  width: number;
  minHeight?: number;
  height?: number;
  bodyClassName?: string;
  onClose: () => void;
  children: React.ReactNode;
  foot?: React.ReactNode;
}) {
  return (
    <div className="jeek-mask">
      <div className="jeek-modal" style={{ width, minHeight, height }}>
        <div className="jeek-modal-head">
          <h2 className="jeek-modal-title">{title}</h2>
          <button className="jeek-modal-x" title="关闭" onClick={onClose}>×</button>
        </div>
        <div className={`jeek-modal-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
        {foot && <div className="jeek-modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 设置 */

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const set = (key: string, value: unknown) => {
    const state = useEditor.getState();
    state.commit(`设置 ${key}`, setSetting(state.doc, key, value));
  };

  return (
    <Modal
      title="设置"
      width={380}
      onClose={onClose}
      foot={<div className="jeek-grow" />}
    >
      <div style={{ marginBottom: 24 }}>
        <div className="jeek-set-head">
          <label className="jeek-set-title">视频设置</label>
        </div>
        <div className="jeek-set-list">
          <div className="jeek-set-row" data-tip="画面宽高比：横屏 16:9、竖屏 9:16、方形 1:1。改动后画布与字幕按新比例重排，已有字幕的文字和时间点不变。">
            <span className="jeek-set-label">视频比例</span>
            <select
              className="jeek-set-select"
              value={String(doc.settings.aspect ?? "landscape")}
              onChange={(e) => set("aspect", e.target.value)}
            >
              {ASPECTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </div>
          <div className="jeek-set-row" data-tip={`每秒渲染的画面数，也是时间码、裁剪与拖拽的最小步进。当前 ${doc.video.fps} fps，1 帧约 ${(1000 / doc.video.fps).toFixed(2)} ms；帧率越高越流畅，导出耗时也越长。`}>
            <span className="jeek-set-label">帧率</span>
            <select
              className="jeek-set-select"
              value={doc.video.fps}
              onChange={(e) => {
                const state = useEditor.getState();
                const fps = Number(e.target.value);
                state.commit("设置帧率", { ...state.doc, video: { ...state.doc.video, fps } });
              }}
            >
              {FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </div>
          <div className="jeek-set-row" data-tip={`逻辑画布 ${canvasLabel(doc)}；导出短边按所选档位（当前 ${RES_TABLE[String(doc.settings.resolution ?? "1080P")]}）推导长边并取偶数。文字为矢量绘制，放大不糊。`}>
            <span className="jeek-set-label">导出分辨率</span>
            <select
              className="jeek-set-select"
              value={String(doc.settings.resolution ?? "1080P")}
              onChange={(e) => set("resolution", e.target.value)}
            >
              {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border-prominent)", paddingTop: 20, paddingBottom: 20 }}>
        <div className="jeek-about-card">
          <span className="jeek-about-name">吉客字幕剪辑</span>
          <span className="jeek-about-ver">v0.1.0</span>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ 导出 */

/** 文件名没写后缀就按容器补上；非法字符换成下划线 */
function safeExportName(raw: string, ext: string): string {
  const trimmed = (raw || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  const base = trimmed || stampName();
  // 后缀一律跟随所选格式，避免手填了 .mp4 却导出别的内容
  return `${base.replace(/\.[a-z0-9]+$/i, "")}.${ext}`;
}

/** 导出两阶段的真实进度：逐帧渲染与服务端视频编码各自独立计数、独立计时。
 * 用 ref 而不是 state 承接逐帧回调，避免几千帧渲染时每帧都触发一次 React 重渲染；
 * 界面由 250ms 的计时器驱动重绘，读到的始终是最新的真实进度。 */
interface RenderProgress {
  phase: RenderPhase | "idle";
  renderDone: number;
  renderTotal: number;
  renderStart: number;
  renderEnd: number;
  uploadRatio: number;
  encodeDone: number;
  encodeTotal: number;
  encodeStart: number;
  encodeEnd: number;
  message: string;
}
const emptyRenderProgress = (): RenderProgress => ({
  phase: "idle",
  renderDone: 0,
  renderTotal: 0,
  renderStart: 0,
  renderEnd: 0,
  uploadRatio: 0,
  encodeDone: 0,
  encodeTotal: 0,
  encodeStart: 0,
  encodeEnd: 0,
  message: "",
});

export function ExportPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const audio = useEditor((s) => s.audio);
  const subtitleSourceName = useEditor((s) => s.subtitleSourceName);
  const exp = useEditor((s) => s.export);
  const update = useEditor((s) => s.update);

  const [codec, setCodec] = useState<ExportCodec>("h264");
  const [quality, setQuality] = useState<ExportQuality>("balanced");
  const [crf, setCrf] = useState(EXPORT_QUALITY.balanced.crf);
  const [accel, setAccel] = useState<ExportAccel>("auto");
  const [concurrency, setConcurrency] = useState(0);
  /** MOV 专属：编码规格与画质档位；MP4 用上面的 codec / quality / crf / accel */
  const [movSpec, setMovSpec] = useState<MovSpec>("4444");
  const [movQuality, setMovQuality] = useState<MovQuality>("fine");
  const [filename, setFilename] = useState(() => defaultExportName(audio?.name ?? null, subtitleSourceName));
  const [dir, setDir] = useState("");
  /** 保存位置所在盘的剩余字节；-1 = 未知（浏览器环境或查询失败） */
  const [diskFree, setDiskFree] = useState(-1);
  const [note, setNote] = useState("");
  /** 导出格式：透明背景默认 MOV，不透明背景默认 MP4；两种格式都走离线逐帧渲染 + 服务端编码 */
  const [format, setFormat] = useState<"mp4" | "mov">(
    doc.settings.background === "transparent" ? "mov" : "mp4",
  );
  /** 导出窗口自己的预览画布：逐帧渲染都在这里，主界面播放器不受影响 */
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const [previewW, previewH] = canvasSize(doc);
  const exportStartedAt = useRef(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  /** 中止导出：渲染中关面板要先确认，确认后置位、终止在途请求/录制并复位状态 */
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const cancelledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 两阶段真实进度只存在 ref 里，由计时器驱动界面重绘 */
  const stageRef = useRef<RenderProgress>(emptyRenderProgress());
  /** 逐帧回调很密，向 store 写状态做 200ms 节流 */
  const stagePatchAt = useRef(0);
  /** 帧渲染完成的时刻：冻结「平均速度」，避免转码/编码阶段分母一直涨、数值持续掉落 */
  const renderEndRef = useRef(0);

  const aspect = String(doc.settings.aspect ?? "landscape");
  const resolution = String(doc.settings.resolution ?? "1080P");
  const cfg = normalizeExportConfig({ codec, quality, crf, accel, concurrency, resolution, aspect });
  const stage = exp.stage;
  const busy = stage === "rendering";

  /** 范围、时长与帧数：设置态的信息卡和执行态用的是同一份口径 */
  const rawRange = doc.settings.exportRange as { startMs: number; endMs: number } | null | undefined;
  const range = rawRange
    && Number.isFinite(rawRange.startMs) && Number.isFinite(rawRange.endMs)
    && rawRange.endMs > rawRange.startMs ? rawRange : null;
  const projectMs = Math.max(1, durationOf(doc));
  const selectedMs = range ? range.endMs - range.startMs : projectMs;
  const exportDoc = range ? sliceDocument(doc, range.startMs, selectedMs) : doc;
  const totalFrames = frameCountOf(exportDoc);
  const fps = doc.video.fps || 30;
  const hasAudio = Boolean(audio?.buffer)
    && exportDoc.tracks.some((t) => t.kind === "audio" && t.clips.length > 0);
  /** 预览框按成片真实比例给宽高，横屏、竖屏、方形都不会被塞进固定 16:9 的框里 */
  const box = previewBox(cfg.width, cfg.height, stage === "init" ? 132000 : 120000, stage === "init" ? 340 : 290);

  useEffect(() => {
    if (stage !== "rendering") return;
    const id = window.setInterval(() => {
      const start = exportStartedAt.current || Date.now();
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => window.clearInterval(id);
  }, [stage]);

  /** 两阶段进度都从真实帧数推算：阶段一 = 已渲染帧，阶段二 = 服务端 ffmpeg 已编码帧 */
  const isMov = format === "mov";
  /** 导出前实时预估体积，避免用户导出到一半才发现文件大得离谱（如 3 分钟 MOV 约 5.5 GB） */
  const estSeconds = selectedMs / 1000;
  const estimatedGB = estimateExportSizeGB({
    format, codec, quality, movQuality,
    width: cfg.width, height: cfg.height, fps, seconds: estSeconds,
  });
  // 非透明工程却选了 MOV：对比 MP4 体积，给出切换建议
  const opaqueProject = doc.settings.background !== "transparent";
  const mp4EstGB = opaqueProject && isMov
    ? estimateExportSizeGB({ format: "mp4", codec: "h264", quality: "balanced", movQuality, width: cfg.width, height: cfg.height, fps, seconds: estSeconds })
    : 0;
  /** 导出期间需要的临时帧空间（成品之外额外占用的部分，编码完成后自动删除） */
  const tempGB = estimateTempGB({ format, width: cfg.width, height: cfg.height, frames: totalFrames });
  const needBytes = Math.round((tempGB + estimatedGB * 1.05) * 1073741824);
  /** 盘上放不下：留 5% 余量给容器头、日志与系统占用 */
  const diskTight = diskFree >= 0 && needBytes > diskFree * 0.95;
  const diskFreeGB = diskFree >= 0 ? diskFree / 1073741824 : -1;
  const ap = stageRef.current;
  const nowMs = Date.now();
  const renderTotal = ap.renderTotal || totalFrames;
  const renderDone = ap.renderDone;
  const encodeTotal = ap.encodeTotal || totalFrames;
  const encodeDone = ap.encodeDone;
  const phase1Ratio = renderTotal > 0 ? Math.min(1, Math.max(0, renderDone / renderTotal)) : 0;
  const phase2Ratio = encodeTotal > 0 ? Math.min(1, Math.max(0, encodeDone / encodeTotal)) : 0;
  const overallRatio = stage === "done" ? 1 : phase1Ratio * 0.5 + phase2Ratio * 0.5;

  /** 速度按「当前阶段自己的时间窗」算，帧渲染一结束就把速度冻结，不再被后台编码时间稀释 */
  const renderClockMs = Math.max(1,
    (renderEndRef.current || ap.renderEnd || nowMs) - (ap.renderStart || exportStartedAt.current || nowMs));
  const renderSpeed = renderDone > 0 ? renderDone / (renderClockMs / 1000) : 0;
  const encodeClockMs = ap.encodeStart ? Math.max(1, (ap.encodeEnd || nowMs) - ap.encodeStart) : 0;
  const encodeSpeed = encodeClockMs > 0 && encodeDone > 0 ? encodeDone / (encodeClockMs / 1000) : 0;
  const inSecondPhase = ap.phase === "encode" || ap.phase === "mux";
  const currentSpeed = stage === "done"
    ? (inSecondPhase && encodeSpeed > 0 ? encodeSpeed : renderSpeed)
    : (ap.phase === "upload" ? 0 : inSecondPhase ? encodeSpeed : renderSpeed);
  const remainFrames = stage === "done" ? 0
    : inSecondPhase ? Math.max(0, encodeTotal - encodeDone)
      : ap.phase === "upload" ? 0 : Math.max(0, renderTotal - renderDone);
  const etaMs = currentSpeed > 0 && remainFrames > 0 ? (remainFrames / currentSpeed) * 1000 : 0;
  const realtimeRatio = currentSpeed > 0 ? currentSpeed / fps : 0;
  /** MOV 带 alpha，画布必须清成透明；MP4 是不透明容器，预览保持黑底才和成片一致 */
  const transparent = isMov;
  const showTransparentPreview = isMov;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const base = await defaultExportDir();
      if (alive && base) setDir(base);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 临时帧与成品落在同一块盘上，导出前就把该盘剩余空间量出来，空间不够提前说 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const free = await freeSpaceOf(dir || undefined);
      if (alive) setDiskFree(free);
    })();
    return () => {
      alive = false;
    };
  }, [dir, stage]);

  /** 未开始导出时绘制当前帧：透明格式按导出口径把画布清成透明，棋盘格才透得出来；
   * 不透明格式直接拷贝主界面画面，保证与主播放器所见一致 */
  useEffect(() => {
    if (stage === "rendering") return;
    const target = thumbRef.current;
    if (!target) return;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    if (format === "mov") {
      paintFrame(ctx, exportDoc, useEditor.getState().playheadMs, target.width, target.height, {
        transparent: true,
        image: useEditor.getState().backgroundImage,
      });
      return;
    }
    const source = previewSurface.canvas;
    if (!source) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(source, 0, 0, target.width, target.height);
  }, [doc, exportDoc, stage, format, previewW, previewH]);

  const patch = (next: Partial<typeof exp>) =>
    update({ export: { ...useEditor.getState().export, ...next } });

  const resetStage = () => {
    setNote("");
    stageRef.current = emptyRenderProgress();
    stagePatchAt.current = 0;
    renderEndRef.current = 0;
    exportStartedAt.current = 0;
    setElapsedMs(0);
    patch({ stage: "init", progress: 0, message: "", output: "", size: 0, rendered: 0, total: 0, hardwareEncoded: false });
  };

  const pickDir = async () => {
    const picked = await pickDirectory(dir || undefined);
    if (picked) {
      setDir(picked);
      setNote("");
    }
  };

  /** 帧渲染一结束就记下时刻：之后转码 / 透明编码再久，速度也不会被持续摊薄 */
  useEffect(() => {
    if (stage !== "rendering") return;
    if (exp.total > 0 && exp.rendered >= exp.total && !renderEndRef.current) {
      renderEndRef.current = Date.now();
    }
  }, [exp.rendered, exp.total, stage]);

  /** 把 media.ts 的四段回调折算成界面上的两条阶段进度：
   * 阶段一 = 逐帧渲染（上传属于交接），阶段二 = 服务端真实 ffmpeg 编码帧数 */
  const onRenderStage = (info: RenderStageInfo) => {
    const p = stageRef.current;
    const t = Date.now();
    p.phase = info.phase;
    p.message = info.message;
    if (info.phase === "render") {
      if (!p.renderStart) p.renderStart = t;
      p.renderDone = info.done;
      p.renderTotal = info.total;
      if (info.ratio >= 1) p.renderEnd = p.renderEnd || t;
    } else if (info.phase === "upload") {
      p.renderEnd = p.renderEnd || t;
      p.uploadRatio = info.ratio;
    } else if (info.phase === "encode") {
      if (!p.encodeStart) p.encodeStart = t;
      p.encodeDone = info.done;
      p.encodeTotal = info.total || p.renderTotal;
    } else {
      p.encodeEnd = p.encodeEnd || t;
      if (info.ratio >= 1) p.encodeDone = p.encodeTotal || p.renderTotal;
    }
    // 只把汇总状态写进 store，节流后一秒至多五次，不给逐帧渲染添堵
    if (t - stagePatchAt.current < 200 && info.ratio < 1) return;
    stagePatchAt.current = t;
    patch({
      stage: "rendering",
      message: info.message,
      rendered: p.renderDone,
      total: p.renderTotal || frameCountOf(exportDoc),
      progress: p.phase === "render"
        ? 0.02 + (p.renderTotal > 0 ? p.renderDone / p.renderTotal : 0) * 0.46
        : 0.5 + (p.encodeTotal > 0 ? p.encodeDone / p.encodeTotal : 0) * 0.48,
    });
  };

  const doExport = async () => {
    const thumb = thumbRef.current;
    if (!thumb) {
      patch({ stage: "error", message: "导出预览画布还没准备好" });
      return;
    }
    /* 逐帧编码必须在「游离、CPU 后备」的画布上做：
       界面上的预览画布会被合成器接管，窗口一旦被遮挡或最小化，读回它就要等合成器产帧，
       toBlob 会被压到约 1 秒一次（实测 1002ms/帧），导出看着像停摆。
       游离画布不参与合成，同样的 toBlob 实测 13ms，且不受窗口可见性影响。 */
    const canvas = document.createElement("canvas");
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      patch({ stage: "error", message: "画布不可用" });
      return;
    }
    const thumbCtx = thumb.getContext("2d");
    const bridgeReady = hasDesktopBridge();
    if (bridgeReady && !dir.trim()) {
      setNote("请选择保存位置");
      return;
    }
    setNote("");

    const state = useEditor.getState();
    const name = safeExportName(filename, format);

    let painted = 0;
    let lastPreviewBucket = -1;
    const PREVIEW_STEP_PERCENT = 5;
    const paint = (timeMs: number) => {
      paintFrame(ctx, exportDoc, timeMs, canvas.width, canvas.height, {
        transparent,
        image: useEditor.getState().backgroundImage,
      });
      // 预览窗不再逐帧跟随：按导出进度每 5% 抽一帧显示，省掉大量画布同步开销。
      // 先清空再整幅覆盖，否则透明帧会一层层叠上去。
      painted += 1;
      if (thumbCtx && totalFrames > 0) {
        const buckets = 100 / PREVIEW_STEP_PERCENT;
        const bucket = Math.min(buckets, Math.floor((painted / totalFrames) * buckets));
        if (bucket !== lastPreviewBucket) {
          lastPreviewBucket = bucket;
          thumbCtx.clearRect(0, 0, thumb.width, thumb.height);
          thumbCtx.drawImage(canvas, 0, 0);
        }
      }
    };
    const mixed = renderTrackAudio(exportDoc, state.audio?.buffer ?? null);

    const ac = new AbortController();
    abortRef.current = ac;
    cancelledRef.current = false;
    stageRef.current = emptyRenderProgress();
    stagePatchAt.current = 0;
    renderEndRef.current = 0;
    exportStartedAt.current = Date.now();
    setElapsedMs(0);
    try {
      patch({ stage: "rendering", progress: 0.02, message: "正在准备渲染环境…", output: "", size: 0, rendered: 0, total: totalFrames, hardwareEncoded: false });
      const result = await exportVideoFrames({
        canvas,
        paint,
        doc: exportDoc,
        audio: mixed,
        format,
        fps,
        renderUrl: RENDER_URL,
        codec,
        quality,
        crf,
        accel,
        concurrency,
        resolution,
        aspect,
        movSpec,
        movQscale: MOV_QSCALE[movQuality],
        signal: ac.signal,
        // 桌面桥模式：成品由主进程流式落盘，渲染进程不缓存整包（支持数 GB 大文件）
        skipResult: bridgeReady,
        // 临时帧优先落在成品同盘，长视频不会撑爆系统盘临时目录
        workDir: bridgeReady ? dir : undefined,
        onStage: onRenderStage,
      });
      const hardwareEncoded = result.hardwareEncoded;
      setElapsedMs(Date.now() - exportStartedAt.current);
      if (bridgeReady) {
        // 主进程直接从渲染服务把成品流式写入磁盘，渲染进程全程不持有整份文件，
        // 因而数 GB 的 MOV 也不会因为 ArrayBuffer 上限（约 2GB）而导出失败。
        const saved = await downloadExport({ renderUrl: RENDER_URL, jobId: result.jobId, dir, name });
        if (!saved.ok) throw new Error(saved.error ?? "写入文件失败");
        patch({
          stage: "done",
          progress: 1,
          message: "导出完成",
          output: saved.filePath ?? name,
          size: saved.size ?? 0,
          hardwareEncoded: saved.hardwareEncoded ?? hardwareEncoded,
        });
        useEditor.getState().notify(`已保存到 ${saved.filePath ?? name}`);
      } else {
        const resultBlob = result.blob;
        if (!resultBlob) throw new Error("浏览器模式缺少成品数据");
        downloadBlob(resultBlob, name);
        patch({
          stage: "done",
          progress: 1,
          message: "导出完成",
          output: name,
          size: resultBlob.size,
          hardwareEncoded,
        });
      }
    } catch (error) {
      setElapsedMs(Date.now() - exportStartedAt.current);
      const aborted = cancelledRef.current || (error instanceof DOMException && error.name === "AbortError");
      if (aborted) {
        // 用户主动取消：已 resetStage，不再报错，直接收尾
        return;
      }
      patch({ stage: "error", progress: 0, message: String(error instanceof Error ? error.message : error) });
    }
  };

  const seg = <T,>(options: Array<{ value: T; label: string }>, current: T, onPick: (value: T) => void) => (
    <div className="jeek-export-seg">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === current ? "is-on" : ""} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );

  const exportFileName = safeExportName(filename, format);
  const baseTitle = stage === "done" ? "导出完成" : stage === "error" ? "导出失败" : stage === "rendering" ? "正在导出" : "导出视频";
  const title = stage === "init" ? baseTitle : `${baseTitle} · ${exportFileName}`;
  const percent = Math.round(Math.min(1, Math.max(0, overallRatio)) * 100);
  const phase1Pct = Math.round(phase1Ratio * 100);
  const phase2Pct = Math.round(phase2Ratio * 100);
  const phase1Active = stage === "rendering" && (ap.phase === "idle" || ap.phase === "render");
  const phase2Active = stage === "rendering" && (ap.phase === "upload" || ap.phase === "encode" || ap.phase === "mux");
  const phase1Hint = stage === "done" ? "全部帧已渲染"
    : ap.phase === "upload" ? `逐帧渲染完成 · 帧上传 ${Math.round(ap.uploadRatio * 100)}%`
      : (ap.message || exp.message || "正在准备渲染环境…");
  const phase2Hint = ap.phase === "upload" ? `帧上传 ${Math.round(ap.uploadRatio * 100)}% · 上传完成后开始编码`
    : ap.phase === "encode" ? (ap.message || "正在编码视频…")
      : ap.phase === "mux" ? (ap.message || "正在取回成品…")
        : stage === "done" ? "视频编码完成" : "等待画面渲染完成";
  const etaLabel = stage === "done" ? "已完成"
    : stage === "error" ? "—"
      : etaMs > 0 ? fmtClock(etaMs)
        : ap.phase === "upload" ? "等待上传" : "计算中…";
  const currentStageLabel = inSecondPhase ? "视频编码" : ap.phase === "upload" ? "上传帧" : "画面渲染";
  const runningMessage = ap.message || exp.message || "正在准备渲染环境…";

  /** 下拉格式 → 一行可读标签（用于进度页「输出格式」与编码方式说明） */
  const formatLabel = (f: string) =>
    ({ mp4: "MP4（不透明）", mov: "MOV（通用透明）" }[f] ?? f);
  /** 编码方式按格式区分：MP4 写 H.264/H.265 + 显卡/CPU，MOV 写实际编码器 */
  const encodeLabel = (f: string) => {
    if (f === "mov") {
      const spec = movSpec === "4444xq" ? "ProRes 4444 XQ" : "ProRes 4444";
      const t = concurrency ? `${concurrency} 线程` : "自动";
      return `${spec} · ${MOV_QUALITY_LABEL[movQuality]}画质 · ${t}`;
    }
    const c = codec === "h265" ? "H.265" : "H.264";
    const a = stage === "done"
      ? (exp.hardwareEncoded ? "显卡 NVENC" : "CPU 软件")
      : ({ auto: "自动", gpu: "显卡 NVENC", cpu: "CPU 软件" }[accel] ?? "自动");
    const t = concurrency ? `${concurrency} 线程` : "自动";
    return `${c} · ${a} · ${t}`;
  };

  /** 渲染中点关闭 → 先确认；确认后终止在途任务并复位，避免残留计时进程 */
  const handleClose = () => {
    if (stage === "rendering") {
      setShowAbortConfirm(true);
      return;
    }
    resetStage();
    onClose();
  };
  const confirmAbort = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    setShowAbortConfirm(false);
    resetStage();
    onClose();
  };
  const hint =
    note ||
    (stage === "done" && exp.size
      ? `${(exp.size / 1048576).toFixed(1)} MB`
      : exp.hardwareEncoded
        ? "显卡加速编码"
        : `${doc.video.fps}fps · ${(ASPECT_PARTS[aspect] ?? ["16:9", "横屏"])[0]}`);

  return (
    <Modal
      title={title}
      width={960}
      minHeight={stage === "init" ? 560 : 640}
      onClose={handleClose}
      foot={
        <>
          <span className="jeek-grow">{hint}</span>
          <button
            className="jeek-btn-ghost"
            onClick={() => {
              if (stage === "error" || stage === "done") {
                resetStage();
                return;
              }
              handleClose();
            }}
          >
            {stage === "error" ? "重新设置" : "关闭"}
          </button>
          {stage !== "init" && (
            <button className="jeek-btn-ghost" onClick={() => void openDirectory(dir || exp.output)}>
              打开输出目录
            </button>
          )}
          {stage === "init" ? (
            <button className="jeek-btn-go" disabled={busy} onClick={() => void doExport()}>
              导出
            </button>
          ) : stage === "done" ? (
            <button className="jeek-btn-go" onClick={() => void revealInFolder(exp.output)}>
              打开文件夹
            </button>
          ) : stage === "error" ? (
            <button className="jeek-btn-go" onClick={() => void doExport()}>
              重试
            </button>
          ) : (
            <button className="jeek-btn-go" disabled>
              导出中…
            </button>
          )}
        </>
      }
    >
      <div className={`jeek-export-body ${stage === "init" ? "is-setup" : "is-running"}`}>
        <div className="jeek-export-left">
          <div className={`jeek-export-thumb${showTransparentPreview ? " is-transparent" : ""}`} style={{ width: box.w, height: box.h }}>
            <canvas ref={thumbRef} width={previewW} height={previewH} />
            <em>{`${cfg.width}×${cfg.height} · ${(ASPECT_PARTS[aspect] ?? ["16:9", "横屏"])[0]}`}</em>
          </div>
          <div className="jeek-export-preview-note">
            {stage === "init" ? <span>{`预览画面 · 按 ${fps} fps 导出`}</span> : null}
            <span>导出范围：{range ? "选定范围" : "全部帧"}{hasAudio ? " · 含音轨" : ""}</span>
          </div>
        </div>

        {stage === "init" ? (
          <div className="jeek-export-right">
            <div className="jeek-export-card">
              <div className="jeek-export-card-title">输出设置</div>
              <div className="jeek-export-form">
            <div className="jeek-export-row">
              <label>导出格式</label>
              <div className="jeek-export-control">
                {seg<"mp4" | "mov">(
                  [
                    { value: "mp4", label: "MP4 不透明" },
                    { value: "mov", label: "MOV 透明" },
                  ],
                  format,
                  setFormat,
                )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>预计体积</label>
              <div className="jeek-export-control">
                <span
                  className="jeek-export-size"
                  data-tip={isMov
                    ? "MOV 走 ProRes 4444，4:4:4:4 全透明通道本身码率很高（1080p30 实测约 150 Mbps，画面越复杂越高）。这是剪辑软件通用的透明格式，体积无法压到 MP4 量级；非必要请改用 MP4。"
                    : "MP4 走 H.264/H.265，体积远小于 MOV 透明格式；若无需透明通道，用 MP4 即可。"}
                >
                  {formatSize(estimatedGB)}
                  {opaqueProject && isMov && mp4EstGB > 0 && (
                    <em className="jeek-export-size-hint">
                      当前背景不透明，改用 MP4 约 {formatSize(mp4EstGB)}
                    </em>
                  )}
                </span>
              </div>
            </div>
            {opaqueProject && isMov && mp4EstGB > 0 && (
              <div className="jeek-export-size-warn">
                当前工程背景不透明，MOV 会额外携带用不上的透明通道，体积增大约 {Math.max(2, Math.round(estimatedGB / Math.max(0.001, mp4EstGB)))} 倍。如无需叠加到其他画面，建议改用 MP4。
              </div>
            )}

            <div className="jeek-export-row">
              <label>临时空间</label>
              <div className="jeek-export-control">
                <span
                  className={`jeek-export-size${diskTight ? " is-tight" : ""}`}
                  data-tip={`逐帧渲染时先把 ${totalFrames} 帧画面写成临时图片交给编码器，编码完成后自动删除。${isMov ? "MOV 用无损 PNG，约 1 MB/帧。" : "MP4 用 JPEG，约 0.2 MB/帧。"}这块空间必须落在成品保存位置所在的盘上。`}
                >
                  {formatSize(tempGB)}
                  {diskFree >= 0 && (
                    <em className="jeek-export-size-hint">
                      该盘可用 {formatSize(diskFreeGB)}
                    </em>
                  )}
                </span>
              </div>
            </div>
            {diskTight && (
              <div className="jeek-export-size-warn">
                保存位置所在磁盘空间不足：本次导出需要约 {formatSize(tempGB + estimatedGB * 1.05)}（临时帧 {formatSize(tempGB)} + 成品 {formatSize(estimatedGB)}），该盘只剩 {formatSize(diskFreeGB)}。请先清理磁盘，或把「保存位置」换到空间更大的盘。
              </div>
            )}

            <div className="jeek-export-row">
              <label>文件名</label>
              <div className="jeek-export-control">
                <input
                  className="jeek-input" style={{ height: 30 }}
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                />
              </div>
            </div>

            <div className="jeek-export-row">
              <label>保存位置</label>
              <div className="jeek-export-control">
                <span className="jeek-export-path" title={dir || "浏览器默认下载目录"}>
                  {dir || "浏览器默认下载目录"}
                </span>
                {hasDesktopBridge() && (
                  <button className="jeek-btn-ghost" style={{ height: 30 }} onClick={() => void pickDir()}>
                    选择
                  </button>
                )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>编码器</label>
              <div
                className="jeek-export-control"
                data-tip={isMov
                  ? "ProRes 4444 与 4444 XQ 都带完整透明通道，可直接导入剪辑软件。XQ 会在 MOV 内标记为更高规格档次；在当前编码器下两者的画质与文件体积一致，实际画质由下方「画质档位」决定。"
                  : undefined}
              >
                {format === "mp4"
                  ? seg<ExportCodec>(
                    [{ value: "h264", label: "H.264" }, { value: "h265", label: "H.265" }],
                    codec,
                    setCodec,
                  )
                  : seg<MovSpec>(
                    [{ value: "4444", label: "ProRes 4444" }, { value: "4444xq", label: "4444 XQ" }],
                    movSpec,
                    setMovSpec,
                  )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>分辨率</label>
              <div className="jeek-export-control">
                {seg(
                  [{ value: "1080P", label: "1080P" }, { value: "1440P", label: "1440P" }, { value: "2160P", label: "2160P" }],
                  resolution,
                  (value) => {
                    const state = useEditor.getState();
                    state.commit("设置分辨率", setSetting(state.doc, "resolution", value));
                  },
                )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>帧率</label>
              <div className="jeek-export-control">
                <select
                  className="jeek-select"
                  value={doc.video.fps || 30}
                  data-tip="导出视频的帧率（每秒画面数）。它决定时间码、裁剪与拖拽的最小步进，也影响流畅度与导出耗时。改这里会同步到工程帧率，时间轴随之变化。"
                  onChange={(e) => {
                    const fps = Number(e.target.value);
                    const state = useEditor.getState();
                    state.commit("设置帧率", { ...state.doc, video: { ...state.doc.video, fps } });
                  }}
                >
                  {FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
                </select>
              </div>
            </div>

            <div className="jeek-export-row">
              <label>编码速度</label>
              <div className={`jeek-export-control${isMov ? " is-disabled" : ""}`}>
                {isMov
                  ? <span className="jeek-export-locked" data-tip="ProRes 是帧内编码，开销由画面尺寸与帧数决定，没有可切换的速度档。">固定 · 帧内编码</span>
                  : seg<ExportQuality>(
                    [
                      { value: "fast", label: "快速" },
                      { value: "balanced", label: "标准" },
                      { value: "high", label: "精细" },
                    ],
                    quality,
                    setQuality,
                  )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>{isMov ? "画质档位" : "画质 CRF"}</label>
              <div
                className="jeek-export-control"
                data-tip={isMov
                  ? "控制 ProRes 量化强度：精细（qscale 2）画质最好、文件最大；标准（8）为平衡档；轻量（20）可显著减小体积（ProRes 为近恒定码率，降幅有限，约三到四成）。三档都完整保留透明通道。"
                  : undefined}
              >
                {isMov
                  ? seg<MovQuality>(
                    [
                      { value: "fine", label: "精细" },
                      { value: "standard", label: "标准" },
                      { value: "light", label: "轻量" },
                    ],
                    movQuality,
                    setMovQuality,
                  )
                  : <div className="jeek-export-crf">
                    <input
                      type="range"
                      min={EXPORT_CRF_SLIDER_MIN}
                      max={EXPORT_CRF_SLIDER_MAX}
                      step={1}
                      value={crf}
                      data-snap="1"
                      onChange={(e) => setCrf(snappedRangeValue(e))}
                    />
                    <b>{crf}</b>
                  </div>}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>编码加速</label>
              <div className={`jeek-export-control${isMov ? " is-disabled" : ""}`}>
                {isMov
                  ? <span className="jeek-export-locked" data-tip="ProRes 4444 没有显卡硬件编码器，由 CPU 按帧并行编码；可用「并行帧数」调整线程数。">CPU 编码 · 无显卡档</span>
                  : seg<ExportAccel>(
                    [
                      { value: "auto", label: "自动" },
                      { value: "gpu", label: "显卡" },
                      { value: "cpu", label: "CPU" },
                    ],
                    accel,
                    setAccel,
                  )}
              </div>
            </div>

            <div className="jeek-export-row">
              <label>并行帧数</label>
              <div className="jeek-export-control">
                {seg(
                  CONCURRENCY_STEPS.map((n) => ({ value: n, label: n === 0 ? "自动" : String(n) })),
                  concurrency,
                  setConcurrency,
                )}
              </div>
            </div>

            <div className="jeek-export-tip">
              {isMov
                ? "画质档位决定画质与体积，透明通道始终完整保留；ProRes 由 CPU 按帧并行编码，可用并行帧数调整线程。"
                : "CRF 越小画质越好、文件越大；显卡编码时自动换算为 CQ。自动档优先使用显卡 NVENC，显卡不可用时回退 CPU。"}
            </div>

            {note && <div className="jeek-export-note">{note}</div>}
              </div>
            </div>

          </div>
        ) : (
          <div className="jeek-export-runinfo">
            <div className="jeek-export-format-line">
              <span>输出格式</span><b className="jeek-export-format-tag">{formatLabel(format)}</b>
              <span>编码方式</span><b>{encodeLabel(format)}</b>
              <span>画面</span><b>{cfg.width}×{cfg.height} · {fps} fps</b>
              <span>时长</span><b>{fmtSeconds(selectedMs)}</b>
              <span>预计体积</span><b>{formatSize(estimatedGB)}</b>
            </div>

            <div className="jeek-export-phases">
                <div className={`jeek-export-phase ${phase1Active ? "is-active" : ""}`}>
                  <div className="jeek-export-phase-head">
                    <strong>① 画面渲染</strong>
                    <em>{phase1Hint}</em>
                    <b>{stage === "done" ? 100 : phase1Pct}%</b>
                  </div>
                  <div className="jeek-export-bar"><i style={{ width: `${stage === "done" ? 100 : phase1Pct}%` }} /></div>
                  <div className="jeek-export-phase-foot">
                    <span>{renderDone} / {renderTotal} 帧</span>
                    <span>{renderSpeed > 0 ? `${renderSpeed.toFixed(1)} 帧/秒` : "—"}</span>
                    <span>{phase1Active ? "进行中" : "已完成"}</span>
                  </div>
                </div>
                <div className={`jeek-export-phase ${phase2Active ? "is-active" : ""}`}>
                  <div className="jeek-export-phase-head">
                    <strong>② 视频编码</strong>
                    <em>{phase2Hint}</em>
                    <b>{stage === "done" ? 100 : phase2Pct}%</b>
                  </div>
                  <div className="jeek-export-bar"><i style={{ width: `${stage === "done" ? 100 : phase2Pct}%` }} /></div>
                  <div className="jeek-export-phase-foot">
                    <span>{encodeDone} / {encodeTotal} 帧</span>
                    <span>{encodeSpeed > 0 ? `${encodeSpeed.toFixed(1)} 帧/秒` : "—"}</span>
                    <span>{phase2Active ? `预计剩余 ${etaLabel}` : stage === "done" ? "已完成" : "等待中"}</span>
                  </div>
                </div>
            </div>

            <div className="jeek-export-runhead">
              <strong>{stage === "error" ? "导出失败" : stage === "done" ? "已保存" : `${percent}%`}</strong>
              <span>
                {stage === "done"
                  ? exp.output || "导出完成"
                  : stage === "error"
                    ? exp.message || "未知错误"
                    : runningMessage}
              </span>
              <b>{fmtClock(elapsedMs)}</b>
            </div>
            <div className="jeek-export-stats">
              <div><span>当前阶段</span><b>{currentStageLabel}</b></div>
              <div><span>阶段速度</span><b>{currentSpeed > 0 ? `${currentSpeed.toFixed(1)} 帧/秒` : "—"}</b></div>
              <div><span>实时倍率</span><b>{realtimeRatio > 0 ? `${realtimeRatio.toFixed(2)}×` : "—"}</b></div>
              <div><span>已用计时</span><b>{fmtClock(elapsedMs)}</b></div>
              <div><span>预计剩余</span><b>{etaLabel}</b></div>
            </div>
          </div>
        )}
      </div>

      {showAbortConfirm && (
        <div className="jeek-export-abort">
          <div className="jeek-export-abort-box">
            <p>导出正在进行中，关闭将<strong>终止当前任务</strong>，已渲染的内容不会保存为文件。确定要关闭吗？</p>
            <div className="jeek-export-abort-btns">
              <button className="jeek-btn-ghost" onClick={() => setShowAbortConfirm(false)}>继续导出</button>
              <button className="jeek-btn-go" onClick={confirmAbort}>终止并关闭</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ 录音 */

/** 毫秒 → MM:SS.s（口径照旧版 fmt） */
function fmtRecordClock(ms: number): string {
  const total = Math.max(0, Number(ms) || 0) / 1000;
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = (total % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** 实时波形：把时域数据画成一条线 */
function drawLiveWave(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, data: Uint8Array): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = Math.max(1, h / 130);
  ctx.beginPath();
  const n = data.length;
  const slice = w / n;
  for (let i = 0; i < n; i += 1) {
    const v = data[i] / 128 - 1;
    const y = (0.5 - v * 0.45) * h;
    const x = i * slice;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** 录制窗口的显示分档（秒）：15→30→60→2分…→30分，之后每 5 分钟加一档 */
const WAVE_WINDOWS = [15, 30, 60, 120, 240, 360, 480, 600, 900, 1200, 1500, 1800];
function waveWindowFor(seconds: number): number {
  for (const w of WAVE_WINDOWS) if (seconds <= w) return w;
  const last = WAVE_WINDOWS[WAVE_WINDOWS.length - 1];
  return last + Math.ceil((seconds - last) / 300) * 300;
}
function waveWindowLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`;
}

interface WaveSample { t: number; peak: number }
interface RecordedTake {
  id: string;
  buffer: AudioBuffer;
  durationMs: number;
  createdAt: string;
  inserted: boolean;
}
interface AppliedAudioSettings {
  noiseSuppression: boolean | null;
  echoCancellation: boolean | null;
  autoGainControl: boolean | null;
  sampleRate: number | null;
}

/** 时间轴音轨式波形：把累积采样按当前窗口分桶，画成上下对称的包络 + 录制头 */
function drawClipWave(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  samples: WaveSample[],
  windowSec: number,
): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, w, h);
  const totalMs = windowSec * 1000;
  const stepSec = windowSec <= 30 ? 5 : windowSec <= 120 ? 15 : windowSec <= 600 ? 60 : 300;
  ctx.strokeStyle = "rgba(148,163,184,.14)";
  ctx.lineWidth = 1;
  for (let s = stepSec; s < windowSec; s += stepSec) {
    const x = Math.round((s / windowSec) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(148,163,184,.22)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + 0.5);
  ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();

  const cols = Math.max(1, Math.floor(w / 3));
  const bucket = new Float32Array(cols);
  for (const s of samples) {
    if (s.t < 0 || s.t > totalMs) continue;
    const i = Math.min(cols - 1, Math.floor((s.t / totalMs) * cols));
    if (s.peak > bucket[i]) bucket[i] = s.peak;
  }
  const color = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#2f6bff";
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < cols; i += 1) {
    const peak = bucket[i];
    if (peak <= 0) continue;
    const bar = Math.max(2, Math.min(1, peak * 2.2) * h * 0.44);
    ctx.fillRect(i * (w / cols), h / 2 - bar, Math.max(1.5, w / cols - 0.8), bar * 2);
  }
  ctx.globalAlpha = 1;
  if (samples.length) {
    const head = Math.min(w - 1, (samples[samples.length - 1].t / totalMs) * w);
    ctx.fillStyle = "#34d399";
    ctx.fillRect(head, 0, 2, h);
  }
}

export function RecordPanel({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [gain, setGain] = useState(100);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(false);
  const [highpass, setHighpass] = useState(true);
  const [applied, setApplied] = useState<AppliedAudioSettings | null>(null);
  const [view, setView] = useState<"setup" | "capture">("setup");
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [takes, setTakes] = useState<RecordedTake[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playRatio, setPlayRatio] = useState(0);
  const [windowSec, setWindowSec] = useState(15);
  const [note, setNote] = useState("");
  const [alert, setAlert] = useState("");

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const hpRef = useRef<BiquadFilterNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunks = useRef<Blob[]>([]);
  const rafRef = useRef(0);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const clipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewSeq = useRef(0);
  const previewPromise = useRef<Promise<void> | null>(null);
  const waveSamples = useRef<WaveSample[]>([]);
  const lastSampleAt = useRef(0);
  const lastDrawAt = useRef(0);
  const elapsedRef = useRef(0);
  const recordingRef = useRef(false);
  const pausedRef = useRef(false);
  const windowSecRef = useRef(15);
  const takeSource = useRef<AudioBufferSourceNode | null>(null);
  const takeCtxRef = useRef<AudioContext | null>(null);
  const takeStartRef = useRef(0);
  const takeRafRef = useRef(0);

  /** 打开面板就申请麦克风并开始波形监控（旧版录音窗口一开就连麦） */
  const startPreview = useCallback((next: {
    deviceId: string;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    highpass: boolean;
  }) => {
    // 连麦是异步的：设备切换、开关切换、点「开始录制」都可能同时发起；
    // 用序号把过期的请求挡掉，否则旧的那次会覆盖新的 refs，录出来是空白
    const seq = ++previewSeq.current;
    if (recRef.current) return Promise.resolve();
    // Chromium 会把同一设备的多次 getUserMedia 复用成一次采集会话：旧音轨还活着时，
    // 新的 ideal 约束会被忽略（表现就是「勾不勾选都没区别」）。重建前先彻底停掉旧链路。
    cancelAnimationFrame(rafRef.current);
    const previousStream = streamRef.current;
    const previousCtx = ctxRef.current;
    streamRef.current = null;
    ctxRef.current = null;
    destRef.current = null;
    analyserRef.current = null;
    gainRef.current = null;
    hpRef.current = null;
    if (previousStream) previousStream.getTracks().forEach((t) => t.stop());
    if (previousCtx) void previousCtx.close().catch(() => {});
    const run = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: next.deviceId ? { exact: next.deviceId } : undefined,
            noiseSuppression: { ideal: next.noiseSuppression },
            echoCancellation: { ideal: next.echoCancellation },
            autoGainControl: { ideal: next.autoGainControl },
          },
        });
        // 过期请求直接丢掉；录制中也不换链路（换链路会把音源掐断，录出来是空白）
        if (seq !== previewSeq.current || recRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // 浏览器/驱动是否真的接受这三项约束，读回来给界面看，避免「勾了没反应」无从判断
        const trackSettings = stream.getAudioTracks()[0]?.getSettings();
        setApplied({
          noiseSuppression: typeof trackSettings?.noiseSuppression === "boolean" ? trackSettings.noiseSuppression : null,
          echoCancellation: typeof trackSettings?.echoCancellation === "boolean" ? trackSettings.echoCancellation : null,
          autoGainControl: typeof trackSettings?.autoGainControl === "boolean" ? trackSettings.autoGainControl : null,
          sampleRate: typeof trackSettings?.sampleRate === "number" ? trackSettings.sampleRate : null,
        });
        streamRef.current = stream;
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        // 面板挂载时还没有用户手势，浏览器策略下上下文是挂起的；
        // 先试着唤醒，失败也不阻塞（点「开始录制」时还会再唤醒一次）
        void ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const g = ctx.createGain();
        g.gain.value = gain / 100;
        gainRef.current = g;
        // 高通滤波：开启时 80Hz 截止滤掉呼吸/低频轰鸣；关闭时放到 20Hz 近似直通（0Hz 会让滤波器退化）
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = next.highpass ? 80 : 20;
        hpRef.current = hp;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;
        const dest = ctx.createMediaStreamDestination();
        destRef.current = dest;
        src.connect(g).connect(hp);
        hp.connect(analyser);
        hp.connect(dest);

        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const d = data[i] - 128;
            sum += d * d;
          }
          const rms = Math.sqrt(sum / data.length) / 128;
          setLevel(Math.min(1, rms * 2.2));
          const live = liveCanvasRef.current;
          if (live) {
            const ctx2d = live.getContext("2d");
            if (ctx2d) drawLiveWave(ctx2d, live, data);
          }
          const now = performance.now();
          if (recordingRef.current && !pausedRef.current && now - lastSampleAt.current >= 40) {
            lastSampleAt.current = now;
            waveSamples.current.push({ t: elapsedRef.current * 1000, peak: rms });
          }
          const win = waveWindowFor(elapsedRef.current);
          if (win !== windowSecRef.current) {
            windowSecRef.current = win;
            setWindowSec(win);
          }
          const clip = clipCanvasRef.current;
          if (clip && now - lastDrawAt.current >= 90) {
            lastDrawAt.current = now;
            const ctx2d = clip.getContext("2d");
            if (ctx2d) drawClipWave(ctx2d, clip, waveSamples.current, windowSecRef.current);
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
        setAlert("");
      } catch (error) {
        setAlert(`无法访问麦克风：${String(error)}`);
      }
    })();
    previewPromise.current = run;
    return run;
  }, [gain]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const mics = list.filter((d) => d.kind === "audioinput");
        setDevices(mics);
        if (mics[0]) setDeviceId(mics[0].deviceId);
      } catch {
        /* 没有权限时留空，录音时再申请 */
      }
      startPreview({
        deviceId: "",
        noiseSuppression,
        echoCancellation,
        autoGainControl,
        highpass,
      });
    })();
    return () => {
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(takeRafRef.current);
      try { takeSource.current?.stop(); } catch { /* 已经停止 */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void ctxRef.current?.close();
    };
    // 只在挂载时连一次麦克风；设备与降噪开关变更时由各自的 onChange 重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 录制中禁用设备与降噪开关（重建流会打断录制）；音量与高通可以热调 */
  const locked = recording;

  /** 高通与音量是链路内的 WebAudio 节点，热调即可；三项浏览器约束必须重连才生效 */
  const applyHighpass = (on: boolean) => {
    setHighpass(on);
    if (hpRef.current) hpRef.current.frequency.value = on ? 80 : 20;
  };

  const stopTakePlayback = () => {
    cancelAnimationFrame(takeRafRef.current);
    takeRafRef.current = 0;
    try { takeSource.current?.stop(); } catch { /* 已经停止 */ }
    takeSource.current = null;
    takeCtxRef.current = null;
    setPlayingId(null);
    setPlayRatio(0);
  };

  const togglePlayTake = (take: RecordedTake) => {
    if (playingId === take.id) { stopTakePlayback(); return; }
    stopTakePlayback();
    const ctx = audioContext();
    const src = ctx.createBufferSource();
    src.buffer = take.buffer;
    src.connect(ctx.destination);
    const duration = Math.max(0.001, take.buffer.duration);
    src.onended = () => {
      if (takeSource.current === src) {
        cancelAnimationFrame(takeRafRef.current);
        takeRafRef.current = 0;
        takeSource.current = null;
        takeCtxRef.current = null;
        setPlayingId(null);
        setPlayRatio(0);
      }
    };
    src.start();
    takeSource.current = src;
    takeCtxRef.current = ctx;
    takeStartRef.current = ctx.currentTime;
    setPlayingId(take.id);
    setPlayRatio(0);
    const tick = () => {
      const now = takeCtxRef.current?.currentTime ?? 0;
      setPlayRatio(Math.min(1, (now - takeStartRef.current) / duration));
      takeRafRef.current = requestAnimationFrame(tick);
    };
    takeRafRef.current = requestAnimationFrame(tick);
  };

  const removeTake = (id: string) => {
    if (playingId === id) stopTakePlayback();
    setTakes((prev) => prev.filter((t) => t.id !== id));
  };

  /** 只有点列表里的「插入」才写进工程；录制停止本身不动时间轴 */
  const insertTake = (take: RecordedTake) => {
    const state = useEditor.getState();
    const track = state.doc.tracks.find((t) => t.kind === "audio");
    if (!track) { setAlert("工程里没有音轨"); return; }
    const appended = appendRecording(state.doc, take.buffer, state.audio?.buffer ?? null);
    if (!appended) return;
    const merged: AudioState = {
      name: state.audio?.name ?? "录音混音",
      buffer: appended.buffer,
      peaks: computePeaks(appended.buffer),
      durationMs: (appended.buffer.length / appended.buffer.sampleRate) * 1000,
      url: state.audio?.url ?? null,
    };
    const next = insertClip(state.doc, track.id, {
      kind: "audio",
      startMs: appended.startMs,
      endMs: appended.endMs,
      inMs: appended.inMs,
      data: { gain: gain / 100 },
    });
    state.commit("插入录音", next);
    state.update({ audio: merged });
    setTakes((prev) => prev.map((t) => (t.id === take.id ? { ...t, inserted: true } : t)));
    state.notify(`已插入录音：${(take.durationMs / 1000).toFixed(1)}s`);
  };

  const start = async () => {
    if (!destRef.current) {
      // 面板刚打开时连麦可能还在路上：等它连上，别再抢一次麦克风
      const pending = previewPromise.current;
      if (pending) await pending;
      // 那次请求可能是过期的（设备刚切换过），等完还没就绪就自己再发起一次
      if (!destRef.current) {
        await startPreview({ deviceId, noiseSuppression, echoCancellation, autoGainControl, highpass });
      }
    }
    const ctx = ctxRef.current;
    if (!ctx || !destRef.current) {
      setAlert("没有可用的麦克风，无法录制");
      return;
    }
    setAlert("");
    setNote("");
    chunks.current = [];
    waveSamples.current = [];
    lastSampleAt.current = 0;
    lastDrawAt.current = 0;
    elapsedRef.current = 0;
    windowSecRef.current = 15;
    setWindowSec(15);
    setElapsed(0);
    // 面板是挂载时就连麦的，那时还没有用户手势，AudioContext 处于 suspended；
    // 不唤醒就采样，录出来的是一段空白（实测只有几毫秒）。
    if (ctx.state === "suspended") await ctx.resume();
    const dest = destRef.current;
    if (!dest) {
      setAlert("麦克风没有就绪，请重新打开录音面板");
      return;
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    // 录的是同一条链路（音量与高通之后）的输出，和电平表看到的波形一致
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(dest.stream, { mimeType: mime });
    } catch (error) {
      setAlert(`当前环境不支持录音：${String(error)}`);
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.start(1000);
    recRef.current = rec;
    recordingRef.current = true;
    pausedRef.current = false;
    setRecording(true);
    setPaused(false);
    setView("capture");
  };

  const pauseToggle = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.state === "recording") {
      rec.pause();
      pausedRef.current = true;
      setPaused(true);
    } else if (rec.state === "paused") {
      rec.resume();
      pausedRef.current = false;
      setPaused(false);
    }
  };

  const stop = async () => {
    const rec = recRef.current;
    if (!rec) return;
    const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    if (rec.state === "paused") rec.resume();
    rec.stop();
    await done;
    recRef.current = null;
    recordingRef.current = false;
    pausedRef.current = false;
    setRecording(false);
    setPaused(false);
    setLevel(0);

    if (!chunks.current.length) {
      setAlert("没有录到声音");
      return;
    }
    const blob = new Blob(chunks.current, { type: rec.mimeType });
    try {
      const buf = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
      const durationMs = (buf.duration || 0) * 1000;
      setTakes((prev) => [...prev, {
        id: `take-${Date.now().toString(36)}`,
        buffer: buf,
        durationMs,
        createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        inserted: false,
      }]);
      setNote("已完成");
    } catch (error) {
      setAlert(`录音处理失败：${String(error)}`);
    }
  };

  useEffect(() => {
    if (!recording || paused) return;
    const timer = window.setInterval(() => {
      setElapsed((v) => {
        const next = v + 0.1;
        elapsedRef.current = next;
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [recording, paused]);

  const flag = (v: boolean | null) => (v === null ? "未报告" : v ? "开" : "关");
  const appliedText = applied
    ? `设备实际生效：降噪 ${flag(applied.noiseSuppression)} · 回声消除 ${flag(applied.echoCancellation)} · 自动增益 ${flag(applied.autoGainControl)} · ${applied.sampleRate ? `${(applied.sampleRate / 1000).toFixed(1)} kHz` : "采样率未报告"} · 高通 ${highpass ? "80 Hz" : "关"}`
    : "正在读取设备约束…";

  if (view === "setup") {
    return (
      <Modal
        title="录音"
        width={820}
        onClose={onClose}
        foot={
          <>
            <span className="jeek-grow" data-tip="本次会话里已录下的片段数。片段只保存在当前录音窗口中，关闭面板后不会保留，记得先插入音轨。">
              <span className="jeek-rec-count">已录制 <b>{takes.length}</b> 段{takes.some((t) => !t.inserted) ? " · 含未插入" : ""}</span>
            </span>
            <button className="jeek-btn-ghost" onClick={onClose}>关闭窗口</button>
            <button
              className="jeek-btn-go"
              data-tip="打开独立的录制窗口。窗口打开后不会自动开始录音，需要再点窗口底部的「开始录制」。"
              onClick={() => setView("capture")}
            >
              录音面板
            </button>
          </>
        }
      >
        <section className="jeek-rec-card">
          <div className="jeek-rec-card-title">录音设备与参数</div>
          <div className="jeek-rec-field" data-tip="选择麦克风。切换设备会重新连接采集链路；录制进行中不可切换，避免掐断正在录音的音源。">
            <div className="jeek-rec-field-head"><span>录音设备</span></div>
            <select
              className="jeek-select"
              value={deviceId}
              onChange={(e) => {
                setDeviceId(e.target.value);
                void startPreview({
                  deviceId: e.target.value,
                  noiseSuppression,
                  echoCancellation,
                  autoGainControl,
                  highpass,
                });
              }}
              disabled={locked}
            >
              {devices.length === 0 && <option value="">默认麦克风</option>}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `麦克风 ${d.deviceId.slice(0, 6)}`}</option>
              ))}
            </select>
          </div>
          <div className="jeek-rec-field" data-tip="录音音量：0% 静音、100% 原样、200% 最大增益。拖动时靠近每 25% 的刻度会自动吸附，按住 Alt 临时不吸附；也可以停在两个刻度之间做细调；音量实时作用于预监和录制。">
            <div className="jeek-rec-field-head">
              <span>录音音量</span>
              <span className="jeek-rec-field-val">{gain}%</span>
            </div>
            <div className="jeek-rec-gain-wrap">
              <span className="jeek-rec-gain-end">0% · 静音</span>
              <input
                className="jeek-rec-gain-input"
                type="range" min={0} max={200} step={1} value={gain}
                data-snap="1"
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const snapped = Math.round(raw / 25) * 25;
                  const value = isAltHeld() ? raw : (Math.abs(raw - snapped) <= 6 ? snapped : raw);
                  setGain(value);
                  if (gainRef.current) gainRef.current.gain.value = value / 100;
                }}
              />
              <span className="jeek-rec-gain-end">200% · 增益</span>
              <div className="jeek-rec-gain-ticks">
                {[25, 50, 75, 100, 125, 150, 175].map((v) => (
                  <span key={v} className={`jeek-rec-tick ${gain === v ? "is-on" : ""}`} style={{ left: `${(v / 200) * 100}%` }}>
                    <i /><em>{v}</em>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="jeek-rec-field">
            <div
              className="jeek-rec-field-head"
              data-tip="这些开关会立即作用于当前麦克风采集链路。系统降噪、回声消除、自动增益由浏览器和声卡驱动决定是否真正采纳，下方会读回设备实际生效的状态；高通滤波由本地音频节点处理，一定生效。"
            >
              <span>降噪与增强</span>
            </div>
            <div className="jeek-rec-checks">
              {([
                ["系统降噪", noiseSuppression, setNoiseSuppression, "抑制环境底噪、风扇声等稳态噪声。是否生效取决于声卡驱动，可看下方读回状态。"],
                ["回声消除", echoCancellation, setEchoCancellation, "抑制从扬声器串回麦克风的回声，戴耳机录音时可关闭以避免人声被压低。"],
                ["自动增益", autoGainControl, setAutoGainControl, "由系统自动把过小或过大的输入拉到合适电平。想固定录音音量、避免忽大忽小时建议关闭。"],
                ["高通滤波", highpass, setHighpass, "用 80Hz 高通滤掉呼吸声、桌面震动等低频轰鸣；关闭后改为 20Hz 近似直通。"],
              ] as const).map(([label, on, toggle, tip]) => (
                <label key={label} className={`jeek-rec-check ${on ? "is-on" : ""}`} data-tip={tip}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={locked}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      if (label === "高通滤波") { applyHighpass(checked); return; }
                      toggle(checked);
                      void startPreview({
                        deviceId,
                        noiseSuppression: label === "系统降噪" ? checked : noiseSuppression,
                        echoCancellation: label === "回声消除" ? checked : echoCancellation,
                        autoGainControl: label === "自动增益" ? checked : autoGainControl,
                        highpass,
                      });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="jeek-rec-applied" data-tip="这是从浏览器读回的麦克风实际约束。显示「未报告」表示驱动没有回传该项，不代表开关一定无效；显示「开 / 关」才是设备真正采纳的值。">{appliedText}</div>
          </div>
        </section>

        <section className="jeek-rec-card">
          <div className="jeek-rec-card-title" data-tip="打开面板就连接麦克风并显示实时波形，这里只做监控、不会写入音轨。录制片段要在录制窗口里试听或插入。">
            实时波形 / 麦克风监控
            <span className="jeek-rec-timer jeek-rec-idle">{note ? "已完成" : "待机"}</span>
          </div>
          <div className="jeek-rec-monitor">
            <canvas ref={liveCanvasRef} className="jeek-rec-canvas" width={760} height={90} />
          </div>
          <div className="jeek-meter"><i style={{ width: `${Math.min(100, level * 130)}%` }} /></div>
        </section>

        {alert && <div className="jeek-rec-alert">{alert}</div>}
      </Modal>
    );
  }

  return (
    <Modal
      title={recording ? (paused ? "录制已暂停" : "正在录制") : "录制窗口"}
      width={960}
      height={720}
      bodyClassName="jeek-capture-body"
      onClose={() => { if (!recording) setView("setup"); }}
      foot={
        <>
          <span className="jeek-grow" data-tip="本次窗口里已录下的片段数。片段只存在当前窗口，关闭后不会保留。">
            <span className="jeek-rec-count">本次已录 <b>{takes.length}</b> 段</span>
          </span>
          <button
            className="jeek-btn-ghost"
            disabled={recording}
            data-tip={recording ? "正在录音，为避免中断本段录制，停止之后才能关闭窗口。" : "回到录音设置面板，已录制的片段仍保留在列表里。"}
            onClick={() => setView("setup")}
          >
            关闭窗口
          </button>
          <button
            className="jeek-btn-ghost"
            disabled={!recording}
            data-tip={paused ? "从暂停处继续本段录音，不会新建片段。" : "暂停当前录音，再点一次从暂停处继续。"}
            onClick={pauseToggle}
          >
            {paused ? "继续录制" : "暂停录制"}
          </button>
          <button
            className={recording ? "jeek-btn-danger" : "jeek-btn-go"}
            data-tip={recording ? "结束当前录音，把这一段加进下方列表。停止本身不会写进时间轴，需要点片段上的「插入」。" : "开始一段新录音。窗口打开后不会自动录制，必须点这里才启动，启动后可以暂停、继续、停止。"}
            onClick={() => (recording ? void stop() : void start())}
          >
            {recording ? "■ 停止录制" : "● 开始录制"}
          </button>
        </>
      }
    >
      <section className="jeek-capture-card">
        <div className="jeek-capture-head">
          <span className={`jeek-rec-dot ${paused ? "is-paused" : ""}`} />
          <strong>{recording ? (paused ? "已暂停" : "录制中") : "待机"}</strong>
          <span className="jeek-capture-clock jeek-rec-timer is-rec">{fmtClock(elapsed * 1000)}</span>
        </div>
        <div
          className="jeek-capture-wave"
          data-tip={`累积波形：横向是录制时间，纵向是实时音量。当前一屏显示 ${waveWindowLabel(windowSec)}，底部刻度标出具体时间点；录得越久，一屏覆盖的时间自动变长。`}
        >
          <canvas ref={clipCanvasRef} className="jeek-capture-canvas" width={900} height={170} />
        </div>
        <div className="jeek-capture-ruler">
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span key={p}>{fmtClock(windowSec * 1000 * p)}</span>
          ))}
        </div>
        <div className="jeek-capture-level" data-tip="录音链路上的实时电平，和波形看到的是同一路信号；持续顶到 100% 说明音量过大，建议调低录音音量。">
          <span>麦克风实时音量</span>
          <div className="jeek-meter"><i style={{ width: `${Math.min(100, level * 130)}%` }} /></div>
          <b>{Math.round(level * 100)}%</b>
        </div>
        <div className="jeek-capture-meta">
          <span>采样率 {applied?.sampleRate ? `${(applied.sampleRate / 1000).toFixed(1)} kHz` : "自动"}</span>
          <span>音量 {gain}%</span>
          <span>高通 {highpass ? "80 Hz" : "关"}</span>
          <span>降噪 {flag(applied?.noiseSuppression ?? null)}</span>
          <span>已录片段 {takes.length}</span>
        </div>
      </section>

      {alert && <div className="jeek-rec-alert">{alert}</div>}

      <section
        className="jeek-take-list"
        data-tip={`共 ${takes.length} 段。试听会按实际播放位置显示进度条；只有点「插入」才会把这一段写进时间轴音轨。片段较多时只在列表内部滚动。`}
      >
        <div className="jeek-rec-card-title">
          本次录制的音频
          <span className="jeek-rec-field-hint">共 {takes.length} 段</span>
        </div>
        {takes.length === 0 ? (
          <div className="jeek-take-empty">还没有录制片段，点右下角「开始录制」。</div>
        ) : takes.map((take, i) => (
          <div className="jeek-take-row" key={take.id}>
            <span className="jeek-take-index">{String(i + 1).padStart(2, "0")}</span>
            <div className="jeek-take-info">
              <b>{fmtRecordClock(take.durationMs)}</b>
              <span>{take.createdAt} 录制 · {take.inserted ? "已插入音轨" : "未插入"}</span>
              <div className="jeek-take-progress">
                <i style={{ width: `${playingId === take.id ? playRatio * 100 : 0}%` }} />
              </div>
            </div>
            <button
              className="jeek-btn-ghost"
              data-tip={playingId === take.id ? "停止试听，进度条归零。" : "从头试听这一段，进度条按实际播放位置推进。"}
              onClick={() => togglePlayTake(take)}
            >
              {playingId === take.id ? "暂停" : "试听"}
            </button>
            <button className="jeek-btn-ghost" data-tip="从列表里删掉这一段，不影响时间轴上已经插入的音轨。" onClick={() => removeTake(take.id)}>删除</button>
            <button
              className="jeek-btn-go"
              disabled={take.inserted}
              data-tip="把这一段紧贴现有音频卡片末尾插入时间轴，并合并进音轨。插入后本条会标记为已插入。"
              onClick={() => insertTake(take)}
            >
              {take.inserted ? "已插入" : "插入"}
            </button>
          </div>
        ))}
      </section>
    </Modal>
  );
}

/* ------------------------------------------------------------ 字体目录 */

/** 改名面板：只改软件里显示的中英名，字体文件与字体族名都不动 */
function FontRenamePanel({
  family,
  label,
  onClose,
}: {
  family: string;
  label: FontLabel;
  onClose: () => void;
}) {
  const [cn, setCn] = useState(label.cn);
  const [en, setEn] = useState(label.en);
  const save = () => {
    const nextCn = cn.trim();
    const nextEn = en.trim();
    if (!nextCn && !nextEn) {
      useEditor.getState().notify("中文名和英文名至少填一个");
      return;
    }
    setFontLabel(family, { cn: nextCn || nextEn, en: nextEn || nextCn });
    useEditor.getState().notify("字体名已更新");
    onClose();
  };
  return (
    <Modal
      title="修改字体名"
      width={520}
      onClose={onClose}
      foot={
        <>
          <span className="jeek-grow" />
          <button className="jeek-btn-ghost" onClick={onClose}>取消</button>
          <button className="jeek-btn-go" data-act="font.rename.save" onClick={save}>保存</button>
        </>
      }
    >
      <div className="jeek-form-col">
        <div data-tip="中文名只在软件里显示，用来认字体；不影响字体文件本身。">
          <label className="jeek-field">中文名</label>
          <input className="jeek-input" value={cn} autoFocus onChange={(e) => setCn(e.target.value)} />
        </div>
        <div data-tip="英文名同样只用于显示，可以和字体文件里的名字不一样。">
          <label className="jeek-field">英文名</label>
          <input className="jeek-input" value={en} onChange={(e) => setEn(e.target.value)} />
        </div>
        <div className="jeek-font-rename-sample" style={{ fontFamily: family }}>
          吉客字幕剪辑 JeekSubCut
        </div>
      </div>
    </Modal>
  );
}

/**
 * 导入面板：地址栏 + 打开按钮 + 自动填好的中英名。
 * 桌面版走系统文件对话框拿到完整路径，浏览器版退回文件选择器；
 * 名称按文件名自动拆成中文名 / 英文名（括号里的内容算进中文名），保存前都能改。
 */
function FontImportPanel({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (entry: FontEntry, label: FontLabel) => void;
}) {
  const [path, setPath] = useState("");
  const [cn, setCn] = useState("");
  const [en, setEn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 选完字体文件后读出来的临时地址（objectURL / dataURL），预览不等保存就能看到真实字形 */
  const [fontUrl, setFontUrl] = useState<string | null>(null);
  const tempFaceRef = useRef<FontFace | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /** 预览用的字体族名：中文名优先，其次英文名，都没填就按文件名解析 */
  const previewFamily = cn.trim() || en.trim()
    || (file ? fontFamilyOfFile(file.name) : path.trim() ? fontFamilyOfFile(normalizeUserPath(path)) : "");

  // 来源变化（选文件 / 填路径）时把字体读出来；桌面桥读物理路径，浏览器用 File 的 objectURL
  useEffect(() => {
    let alive = true;
    if (file) {
      const objectUrl = URL.createObjectURL(file);
      if (!alive) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = objectUrl;
      setFontUrl(objectUrl);
      return () => { alive = false; };
    }
    if (!path.trim()) {
      setFontUrl(null);
      return;
    }
    void (async () => {
      try {
        const read = await readFontFile(normalizeUserPath(path));
        if (!alive) return;
        setFontUrl(read?.ok && read.dataUrl ? read.dataUrl : null);
      } catch {
        if (alive) setFontUrl(null);
      }
    })();
    return () => { alive = false; };
  }, [file, path]);

  // 字体地址就绪后临时注册进 document.fonts：下面的预览立即按真实字形渲染；
  // 保存后面板卸载时移除临时字体，由正式的 @font-face 接管
  useEffect(() => {
    let alive = true;
    if (!fontUrl || !previewFamily) return;
    void (async () => {
      try {
        const face = new FontFace(previewFamily, `url(${fontUrl})`);
        await face.load();
        if (!alive) return;
        if (tempFaceRef.current) document.fonts.delete(tempFaceRef.current);
        document.fonts.add(face);
        tempFaceRef.current = face;
      } catch {
        // 字体解析失败就保持回退显示，不挡导入流程
      }
    })();
    return () => { alive = false; };
  }, [fontUrl, previewFamily]);

  // 面板卸载：清掉临时字体与 objectURL
  useEffect(() => () => {
    if (tempFaceRef.current) {
      document.fonts.delete(tempFaceRef.current);
      tempFaceRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const fillFromFile = (fileName: string) => {
    const parsed = fontNamesFromFile(fileName);
    setCn(parsed.cn);
    setEn(parsed.en);
  };

  const applyPath = (picked: string) => {
    setFile(null);
    setPath(picked);
    fillFromFile(normalizeUserPath(picked));
  };

  const openPicker = async () => {
    const api = (globalThis as unknown as {
      jeekStudio?: { pickFontFile?: () => Promise<{ ok: boolean; path?: string }> };
    }).jeekStudio;
    if (api?.pickFontFile) {
      const picked = await api.pickFontFile();
      if (picked?.ok && picked.path) applyPath(picked.path);
      return;
    }
    fileRef.current?.click();
  };

  const save = async () => {
    const name = cn.trim() || en.trim();
    if (!path.trim() && !file) {
      useEditor.getState().notify("先填字体文件地址，或点右边的文件夹按钮选一个字体文件");
      return;
    }
    if (!name) {
      useEditor.getState().notify("中文名和英文名至少填一个");
      return;
    }
    setBusy(true);
    const result = file ? await importFontFile(file, name) : await importFontByPath(path, name);
    setBusy(false);
    if (!result.ok || !result.entry) {
      useEditor.getState().notify(result.error ?? "导入字体失败");
      return;
    }
    onDone(result.entry, { cn: name, en: en.trim() || name });
    onClose();
  };

  return (
    <Modal
      title="导入本地字体"
      width={640}
      onClose={onClose}
      foot={
        <>
          <span className="jeek-grow" style={{ fontSize: 12, color: "var(--muted)" }}>
            保存后字体文件会拷进项目根的 fonts 目录，之后一直可用
          </span>
          <button className="jeek-btn-ghost" onClick={onClose}>取消</button>
          <button className="jeek-btn-go" data-act="font.import.save" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <div className="jeek-form-col">
        <div data-tip="可以直接粘贴字体文件的完整路径：带双引号、正斜线 D:/fonts/a.ttf、反斜线 D:\fonts\a.ttf 都能识别。也可以点右边的文件夹按钮用系统文件选择器挑。">
          <label className="jeek-field">字体文件地址</label>
          <div className="jeek-font-path">
            <input
              className="jeek-input"
              placeholder="D:\fonts\我的字体.ttf"
              value={path}
              onChange={(e) => {
                setFile(null);
                setPath(e.target.value);
                fillFromFile(e.target.value);
              }}
            />
            <button
              type="button"
              className="jeek-font-path-btn"
              aria-label="选择字体文件"
              data-act="font.import.pick"
              data-tip="用系统文件选择器挑一个 .ttf / .otf / .woff / .woff2 文件，选完自动把完整路径填到左边。"
              onClick={() => void openPicker()}
            >
              <IconFolderOpen />
            </button>
          </div>
        </div>
        <div data-tip="按文件名自动填好，可以改。中文名是列表里显示的名字；只填一个也行，另一个会自动跟它一样。">
          <label className="jeek-field">中文名</label>
          <input className="jeek-input" value={cn} onChange={(e) => setCn(e.target.value)} />
        </div>
        <div>
          <label className="jeek-field">英文名</label>
          <input className="jeek-input" value={en} onChange={(e) => setEn(e.target.value)} />
        </div>
        <div
          className="jeek-font-rename-sample"
          style={{ fontFamily: previewFamily || "inherit" }}
          data-tip="预览：选完字体文件（或填好路径）就会按这个字体实时渲染，改中文名 / 英文名不影响预览字形。"
        >
          吉客字幕剪辑 JeekSubCut
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) {
            setFile(picked);
            setPath(picked.name);
            fillFromFile(picked.name);
          }
          e.target.value = "";
        }}
      />
    </Modal>
  );
}

export function FontPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const catalog = useEditor((s) => s.fontCatalog);
  const options = mergeFontEntries(catalog);
  const current = String(doc.settings.fontFamily ?? DEFAULT_FONT_FAMILY);
  const [labels, setLabels] = useState<FontLabels>(() => loadFontLabels());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{ family: string; top: number; left: number } | null>(null);

  /** 示例文字与字形效果：预览用的就是画面最终渲染的同一份设置（默认加粗） */
  const DEFAULT_SAMPLE = "吉客字幕剪辑 JeekSubCut";
  const [sampleText, setSampleText] = useState(() =>
    String(doc.settings.fontSampleText ?? DEFAULT_SAMPLE));
  const bold = Boolean(doc.settings.fontBold ?? true);
  const italic = Boolean(doc.settings.fontItalic ?? false);
  const underline = Boolean(doc.settings.fontUnderline ?? false);
  const strike = Boolean(doc.settings.fontStrike ?? false);
  const sampleStyle: React.CSSProperties = {
    fontWeight: bold ? 700 : 400,
    fontStyle: italic ? "italic" : "normal",
    textDecoration: [underline && "underline", strike && "line-through"]
      .filter(Boolean).join(" ") || "none",
  };
  const toggleEffect = (key: "fontBold" | "fontItalic" | "fontUnderline" | "fontStrike") => {
    const state = useEditor.getState();
    const on = key === "fontBold"
      ? Boolean(state.doc.settings.fontBold ?? true)
      : Boolean(state.doc.settings[key]);
    state.commit("设置字形效果", setSetting(state.doc, key, !on));
  };
  const commitSample = () => {
    const value = sampleText.trim() ? sampleText : DEFAULT_SAMPLE;
    setSampleText(value);
    const state = useEditor.getState();
    if (String(state.doc.settings.fontSampleText ?? DEFAULT_SAMPLE) !== value) {
      state.commit("设置示例文字", setSetting(state.doc, "fontSampleText", value));
    }
  };
  const effects = [
    { key: "fontBold" as const, label: "加粗", on: bold, icon: <IconBold />,
      tip: "加粗：字幕文字用粗体渲染。默认开启，点一下可关闭；加粗与否完全按这里的设定。" },
    { key: "fontItalic" as const, label: "倾斜", on: italic, icon: <IconItalic />,
      tip: "倾斜：字幕文字用斜体渲染，可和加粗、下划线叠加。" },
    { key: "fontUnderline" as const, label: "下划线", on: underline, icon: <IconUnderline />,
      tip: "下划线：在字幕文字下方画线，线宽随字号变化。" },
    { key: "fontStrike" as const, label: "删除线", on: strike, icon: <IconStrike />,
      tip: "删除线：在字幕文字中间画线，可和其它字形效果叠加。" },
  ];

  /** 每次打开面板都扫一遍项目根目录的 fonts 文件夹：往里拷了字体，重开即可看到 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const scanned = await scanFontsDirectory();
      if (!alive || !scanned.length) return;
      const state = useEditor.getState();
      state.setFontCatalog(scanned);
      applyFontFaces(scanned);
      await ensureFontsLoaded(scanned);
    })();
    return () => { alive = false; };
  }, []);

  const labelOf = (font: FontEntry): FontLabel =>
    labels[font.family] ?? defaultFontLabel(font.family, font.fileName);

  const applyDefault = (family: string) => {
    const state = useEditor.getState();
    state.commit("设置全局字体", setSetting(state.doc, "fontFamily", family));
    state.notify(`全局字体已设为 ${labelOf({ family }).cn}`);
  };

  const onImported = async (entry: FontEntry, label: FontLabel) => {
    const state = useEditor.getState();
    const next = [entry, ...state.fontCatalog.filter((f) => f.family !== entry.family)];
    state.setFontCatalog(next);
    setLabels(setFontLabel(entry.family, label));
    applyFontFaces(next);
    await ensureFontsLoaded(next);
    const saved = await saveFontCatalog(next);
    state.notify(saved.ok ? `已导入字体 ${label.cn}` : (saved.error ?? "字体已导入，但没能保存"));
  };

  const onRemove = async (family: string) => {
    const state = useEditor.getState();
    const result = await removeFontFromCatalog(family);
    if (!result.ok) {
      state.notify(result.error ?? "删除字体失败");
      return;
    }
    const next = state.fontCatalog.filter((f) => f.family !== family);
    state.setFontCatalog(next);
    applyFontFaces(next);
    await ensureFontsLoaded(next);
    await saveFontCatalog(next);
    state.notify(`已删除字体 ${labelOf({ family }).cn}`);
  };

  const openFonts = async () => {
    const ok = await openFontsDirectory();
    if (!ok) useEditor.getState().notify("桌面版里可直接打开 fonts 文件夹；当前环境请手动打开项目根目录的 fonts");
  };

  /** 鼠标指向一行就弹大预览：贴在该行下方，下方空间不够就翻到上方 */
  const showPreview = (event: React.MouseEvent<HTMLDivElement>, family: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const height = 168;
    const below = rect.bottom + 8;
    setPreview({
      family,
      top: below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 8) : below,
      left: Math.max(16, Math.min(window.innerWidth - 580, rect.left + 24)),
    });
  };

  const previewFont = preview ? options.find((f) => f.family === preview.family) : null;
  const previewLabel = previewFont ? labelOf(previewFont) : null;

  return (
    <Modal
      title="字体管理"
      width={1080}
      onClose={onClose}
      foot={
        <>
          <span className="jeek-grow">共 {options.length} 款字体</span>
          <button className="jeek-btn-ghost" data-act="font.openDir" data-tip="打开项目根目录的 fonts 文件夹：把字体文件拷进去，再打开本面板就会自动识别。" onClick={() => void openFonts()}>
            打开字体目录
          </button>
          <button className="jeek-btn-ghost" onClick={onClose}>关闭</button>
          <button className="jeek-btn-go" data-act="font.import" onClick={() => setImporting(true)}>
            导入本地字体
          </button>
        </>
      }
    >
      <div className="jeek-font-import">
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          程序不附带任何第三方字体（避免授权问题）；下面五个是 Windows 系统字体，直接用系统字形。需要特殊字体请点右下「导入本地字体」，或先安装到系统再用它的字体名。选为默认会作用到全局字体。
        </span>
      </div>
      <div className="jeek-font-tools">
        <input
          className="jeek-font-sample-input"
          data-act="font.sample"
          aria-label="示例文字"
          value={sampleText}
          placeholder="输入用于预览的文字"
          data-tip="示例文字：输入什么，下面每一行字体与大预览里就显示什么；失焦或回车后记进工程，重开面板仍在。字形效果也按右边按钮如实显示。"
          onChange={(e) => setSampleText(e.target.value)}
          onBlur={commitSample}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <span className="jeek-font-tools-sep" />
        {effects.map((fx) => (
          <button
            key={fx.key}
            className={`jeek-font-fx ${fx.on ? "is-on" : ""}`}
            data-act={fx.key}
            data-on={fx.on ? "1" : "0"}
            aria-label={fx.label}
            aria-pressed={fx.on}
            data-tip={fx.tip}
            onClick={() => toggleEffect(fx.key)}
          >
            {fx.icon}
          </button>
        ))}
        <span className="jeek-font-tools-note">字形效果就是画面最终渲染的效果</span>
      </div>
      <div className="jeek-font-list" onMouseLeave={() => setPreview(null)}>
        {options.map((font) => {
          const label = labelOf(font);
          const system = isSystemFont(font.family);
          return (
            <div
              key={font.family}
              className={`jeek-font-row ${font.family === current ? "is-current" : ""}`}
              onMouseEnter={(e) => showPreview(e, font.family)}
            >
              {!system ? (
                <button
                  className="jeek-font-edit"
                  aria-label="修改字体名"
                  data-act="font.rename"
                  data-tip={`修改「${label.cn}」在列表里显示的中文名与英文名（只影响显示，不动字体文件）。`}
                  onClick={() => setRenaming(font.family)}
                >
                  <IconPencil />
                </button>
              ) : (
                <span className="jeek-font-edit is-placeholder" aria-hidden="true" />
              )}
              <div className="jeek-font-names">
                <span className="jeek-font-name" title={label.cn}>{label.cn}</span>
                <span className="jeek-font-en" title={label.en}>{label.en}</span>
              </div>
              <span className="jeek-font-sample" style={{ fontFamily: font.family, ...sampleStyle }}>
                {sampleText}
              </span>
              <span className="jeek-font-tag">{system ? "系统" : font.builtin ? "内置" : "本地"}</span>
              {font.family === current
                ? <span className="jeek-font-tag">使用中</span>
                : (
                  <button className="jeek-font-mini" onClick={() => applyDefault(font.family)}>设为默认</button>
                )}
              {!font.builtin && (
                <button className="jeek-font-mini is-danger" onClick={() => void onRemove(font.family)}>删除</button>
              )}
            </div>
          );
        })}
      </div>

      {preview && previewFont && previewLabel && (
        <div
          className="jeek-font-preview"
          style={{ top: preview.top, left: preview.left }}
        >
          <div className="jeek-font-preview-head">
            <b>{previewLabel.cn}</b>
            <span>{previewLabel.en}</span>
          </div>
          <div className="jeek-font-preview-big" style={{ fontFamily: preview.family, ...sampleStyle }}>
            {sampleText}
          </div>
          <div className="jeek-font-preview-small" style={{ fontFamily: preview.family }}>
            字幕效果预览 ABCabc 0123456789 你好世界
          </div>
        </div>
      )}

      {renaming && (
        <FontRenamePanel
          family={renaming}
          label={labelOf({ family: renaming })}
          onClose={() => {
            setLabels(loadFontLabels());
            setRenaming(null);
          }}
        />
      )}

      {importing && (
        <FontImportPanel
          onClose={() => setImporting(false)}
          onDone={(entry, label) => { void onImported(entry, label); }}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------ 语音转字幕 */

const ASR_STAGES = [
  {
    key: "extract",
    label: "提取音频",
    desc: "第一步 提取音频：按时间轴把音频片段拼成一段完整音轨（裁剪、插入的录音都会算进去），交给识别引擎。这一步只准备输入，不改动工程内容。",
  },
  {
    key: "recognize",
    label: "本地识别",
    desc: "第二步 本地识别：VAD 先把音轨切成一段段人声，再由本机的语音模型逐段转成文字。有显卡时走 Vulkan，没有显卡时用 CPU，速度差别主要在这一步。",
  },
  {
    key: "split",
    label: "分句对齐",
    desc: "第三步 分句对齐：把识别出的长句按标点、以及「单句最多字数 / 单句最长时长」切成一条条字幕，并把每条字幕对齐到具体时间码。",
  },
] as const;

/** 引擎阶段归到界面的三步里：初始化 / 模型 / VAD 都属于「本地识别」 */
const asrStepOf = (stage: string): number => {
  if (stage === "extract") return 0;
  if (stage === "split" || stage === "done") return 2;
  return 1;
};

interface AsrOutcome {
  subtitles: Array<{ text: string; startMs: number; endMs: number }>;
  stats: {
    vadSegments: number;
    segments: number;
    backend: string;
    vadMaxSeg: number;
    engineMs: number;
    gpuName: string;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

export function AsrPanel({ onClose }: { onClose: () => void }) {
  const asr = useEditor((s) => s.asr);
  const doc = useEditor((s) => s.doc);
  const audio = useEditor((s) => s.audio);
  const update = useEditor((s) => s.update);
  const commit = useEditor((s) => s.commit);
  const notify = useEditor((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AsrOutcome | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState("");
  const [asrConfig, setAsrConfig] = useState<AsrConfig | null>(null);
  const [view, setView] = useState<"setup" | "progress">("setup");
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void fetchAsrConfig(RENDER_URL).then((cfg) => {
      if (alive && cfg) setAsrConfig(cfg);
    });
    return () => {
      alive = false;
    };
  }, []);

  const set = (key: string, value: unknown) => {
    const state = useEditor.getState();
    state.commit(`设置 ${key}`, setSetting(state.doc, key, value));
  };

  const settings = doc.settings;
  const storedBackend = settings.asrBackend === "cpu" ? "cpu" : "vulkan";
  const backendAvail = asrConfig?.status.backends.find((b) => b.id === storedBackend)?.available ?? true;
  const backend = backendAvail ? storedBackend : (asrConfig?.status.defaultBackend ?? "cpu");
  const maxChars = clamp(Number(settings.asrMaxChars ?? 14), 8, 24);
  const maxMs = clamp(Number(settings.asrMaxMs ?? 4500), 2000, 8000);
  const vadMaxSeg = clamp(Number(settings.asrVadMaxSeg ?? 8000), 4000, 15000);

  const setAsr = (patch: Partial<typeof asr>) =>
    update({ asr: { ...useEditor.getState().asr, ...patch } });

  /** 日志窗口按行累积、去掉相邻重复，只保留最近 200 行 */
  const appendLog = (lines: string[]) =>
    setLogs((prev) => {
      const next = [...prev];
      for (const line of lines) {
        if (line && next[next.length - 1] !== line) next.push(line);
      }
      return next.slice(-200);
    });

  const run = async () => {
    setBusy(true);
    setOutcome(null);
    setNote("");
    setLogs([]);
    setShowAll(false);
    setView("progress");
    try {
      const state0 = useEditor.getState();
      appendLog(["按时间轴上的音频片段重建待识别音轨…"]);
      setAsr({ stage: "extract", progress: 0.08, message: "按时间轴片段重建音轨…", segDone: 0, segTotal: 0, logs: [] });
      const trackAudio = renderTrackAudio(state0.doc, state0.audio?.buffer ?? null);
      if (!trackAudio) throw new Error("时间轴上没有音频片段，先导入音频或录音");
      const wav = audioToWavBuffer(trackAudio);

      appendLog(["音轨就绪，正在启动本地识别引擎…"]);
      setAsr({ stage: "model", progress: 0.12, message: "正在启动本地识别引擎…" });
      const result = await recognizeOnServer(wav, RENDER_URL, {
        backend,
        vadMaxSeg,
        onProgress: (p) => {
          const stage = (
            ["extract", "model", "vad", "recognize", "split", "done", "error"].includes(p.stage)
              ? p.stage
              : "recognize"
          ) as typeof asr.stage;
          const incoming = Array.isArray(p.logs) ? p.logs.filter(Boolean) : [];
          appendLog([...incoming, p.detail ? `[${stage}] ${p.detail}` : ""]);
          setAsr({
            stage,
            progress: clamp(p.percent / 100, 0, 1),
            message: p.detail,
            segDone: p.segDone ?? 0,
            segTotal: p.segTotal ?? 0,
            logs: Array.isArray(p.logs) ? p.logs.slice(-6) : [],
          });
        },
      });
      if (!result.ok) throw new Error(result.error ?? "识别失败");

      appendLog(["引擎返回识别结果，正在按标点与语义断句…"]);
      setAsr({ stage: "split", progress: 0.94, message: "正在按标点与语义断句…" });
      const asrSplit = await loadAsrSplit();
      const subtitles = asrSplit.buildSubtitles(asrSplit.parseSrt(result.srt ?? ""), {
        maxChars,
        maxMs,
        fps: state0.doc.video.fps,
      });
      if (!subtitles.length) throw new Error("这段音频里没有识别到语音，换个有声素材试试");

      const stats = result.stats ?? {
        vadSegments: 0,
        segments: subtitles.length,
        backend,
        vadMaxSeg,
        engineMs: 0,
        gpuName: "",
      };
      appendLog([`断句完成：共 ${subtitles.length} 条字幕，识别耗时 ${(stats.engineMs / 1000).toFixed(1)} 秒。`]);
      setOutcome({ subtitles, stats });
      setAsr({
        stage: "done",
        progress: 1,
        message: `生成 ${subtitles.length} 条字幕`,
        segDone: stats.segments,
        segTotal: stats.vadSegments || stats.segments,
      });
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      appendLog([`识别未完成：${text}`]);
      setNote(text);
      setAsr({ stage: "error", progress: 0, message: text });
    } finally {
      setBusy(false);
    }
  };

  /** 分句结果整轨写入（旧版是替换已有字幕），再套全局样式规则 */
  const applyOutcome = () => {
    if (!outcome) return;
    const state = useEditor.getState();
    const track = state.doc.tracks.find((t) => t.kind === "subtitle");
    if (!track) return;
    const enterAnimation = String(state.doc.settings.enterAnimation ?? "打字机");
    const motion = String(state.doc.settings.motion ?? "up");
    const stamp = Date.now().toString(36);
    const clips: Clip[] = outcome.subtitles.map((sub, i) => ({
      id: `asr-${stamp}-${i}`,
      trackId: track.id,
      kind: "subtitle",
      startMs: sub.startMs,
      endMs: sub.endMs,
      inMs: 0,
      data: { text: sub.text, enterAnimation, motion },
      effects: [],
    }));
    let next = {
      ...state.doc,
      tracks: state.doc.tracks.map((t) => (t.kind === "subtitle" ? { ...t, clips } : t)),
    };
    // 套用全局样式规则：随机字号 + 调色板随机色 + 重算旋转计划
    next = applyStyleRules(next, {
      minFontSize: Number(next.settings.minFontSize ?? 90),
      maxFontSize: Number(next.settings.maxFontSize ?? 100),
      palette: Array.isArray(next.settings.palette) ? next.settings.palette : [],
      rotationMode: String(next.settings.rotationMode ?? "auto"),
      rotationInterval: Number(next.settings.rotationInterval ?? 0),
    });
    commit("语音转字幕", next);
    useEditor.getState().update({ subtitleSourceName: "语音转字幕" });
    notify(`已把 ${outcome.subtitles.length} 条字幕写进字幕轨`);
    onClose();
  };

  const step = asr.stage === "done" ? 3 : asrStepOf(asr.stage);
  const backendOptions: AsrBackendOption[] = asrConfig?.status.backends ?? [
    { id: "vulkan", label: "显卡加速 · Vulkan", desc: "调用显卡做推理，通常明显快于 CPU（首次运行需要预热；显卡驱动过旧或系统不支持 Vulkan 时请改用 CPU）", available: true, recommended: true },
    { id: "cpu", label: "CPU 通用", desc: "不依赖显卡，兼容性最好，速度较慢", available: true, recommended: false },
  ];
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, view]);

  /* 设置窗口：尺寸与录音面板一致 */
  if (view === "setup") {
    return (
      <Modal
        title="语音转字幕"
        width={820}
        onClose={onClose}
        foot={
          <>
            <span className="jeek-grow" />
            <button className="jeek-btn-ghost" onClick={onClose}>关闭</button>
            <button
              className="jeek-btn-go"
              data-tip="以时间轴上实际拼好的音轨为输入启动本地识别。点击后会打开独立的进度窗口，显示各阶段进度、运行日志和识别结果。"
              onClick={() => void run()}
            >
              开始识别
            </button>
          </>
        }
      >
        <div className="jeek-form-col" style={{ paddingBottom: 20 }}>
          <div
            className="jeek-asr-models"
            data-tip="当前可用 FunASR；另外两个模型端口已预留，后续版本开放，鼠标指向灰化项看说明。"
          >
            <button type="button" className="jeek-asr-model is-on">FunASR</button>
            <button type="button" className="jeek-asr-model is-disabled" disabled data-tip="待开发：Qwen3-ASR-0.6B 模型端口已预留，后续版本开放。">Qwen3-ASR-0.6B</button>
            <button type="button" className="jeek-asr-model is-disabled" disabled data-tip="待开发：MOSS-Transcribe-Diarize 0.9B 模型端口已预留，后续版本开放。">MOSS-Transcribe-Diarize 0.9B</button>
          </div>
          <div className="jeek-asr-flow">
            <div className="jeek-asr-flow-title">识别流程（点「开始识别」后自动走完三步）</div>
            <ol className="jeek-asr-steps">
              {ASR_STAGES.map((s, i) => (
                <li key={s.key} className="jeek-asr-step" data-tip={s.desc}>
                  <span className="jeek-asr-step-dot">{i + 1}</span>
                  <span className="jeek-asr-step-name">{s.label}</span>
                </li>
              ))}
            </ol>
          </div>

          <section
            className="jeek-rec-card"
            style={{ marginBottom: 12 }}
            data-tip="识别输入是时间轴上拼好的音轨，不是导入时的原始文件；裁剪、插入的录音片段都会被计入。下方是本机可用的显卡、引擎、模型、VAD 与 ffmpeg 就绪状态。"
          >
            <div className="jeek-rec-card-title">音频与设备</div>
            <div className="jeek-asr-devrow"><span className="jeek-asr-devk">音频文件</span><span className="jeek-asr-devv">{audio?.buffer ? "时间轴音轨（已拼好的音频片段）" : "未载入音频"}</span></div>
            <div className="jeek-asr-devrow"><span className="jeek-asr-devk">显卡</span><span className={`jeek-asr-devv ${asrConfig?.gpu ? "is-ok" : "is-bad"}`}>{asrConfig?.gpu ? `${asrConfig.gpu.name} · ${asrConfig.gpu.memory} 显存` : "未检测到独立显卡，可选用 CPU 识别"}</span></div>
            <div className="jeek-asr-devrow"><span className="jeek-asr-devk">识别资源</span><span className={`jeek-asr-devv ${asrConfig ? (asrConfig.status.ok ? "is-ok" : "is-bad") : ""}`}>{asrConfig ? (asrConfig.status.ok ? "已就绪：引擎 / 模型 / VAD / ffmpeg" : `资源缺失：${asrConfig.status.missing.join("、")}`) : "检测中…"}</span></div>
          </section>

          <div className="jeek-form-grid">
            <div style={{ gridColumn: "1 / -1" }}>
              <div
                className="jeek-field jeek-field-head"
                data-tip="选择由显卡（Vulkan）还是 CPU 执行语音推理。资源不可用时对应卡片会置灰；鼠标指向卡片可看该后端的详细说明。"
              >
                <span>计算后端</span>
              </div>
              <div className="jeek-asr-backends">
                {backendOptions.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    data-backend={b.id}
                    data-tip={b.desc}
                    className={`jeek-asr-backend ${backend === b.id ? "is-on" : ""} ${b.available ? "" : "is-disabled"}`}
                    disabled={!b.available || busy}
                    onClick={() => set("asrBackend", b.id)}
                  >
                    <span className="jeek-asr-backend-name">
                      {b.label}
                      {b.recommended ? <em className="jeek-asr-tag">推荐</em> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="jeek-asr-sliders">
            <div data-tip="VAD 把长音频切成语音片段时的单段上限。说得快、停顿少可以调大以减少切碎；背景噪声多或显存小就调小。">
              <label className="jeek-field">语音分段长度 · {Math.round(vadMaxSeg / 1000)} 秒</label>
              <input
                type="range" min={4} max={15} step={1}
                value={Math.round(vadMaxSeg / 1000)}
                data-snap="1"
                onChange={(e) => set("asrVadMaxSeg", snappedRangeValue(e) * 1000)}
              />
            </div>
            <div data-tip="断句后单条字幕最多保留的字数，超出会优先在标点处拆成下一条。">
              <label className="jeek-field">单句最多字数 · {maxChars} 字</label>
              <input
                type="range" min={8} max={24} step={1}
                value={maxChars}
                data-snap="1"
                onChange={(e) => set("asrMaxChars", snappedRangeValue(e))}
              />
            </div>
            <div data-tip="断句后单条字幕的最长时长，超出会强制切开，避免一条字幕在屏幕上停太久。">
              <label className="jeek-field">单句最长时长 · {(maxMs / 1000).toFixed(1)} 秒</label>
              <input
                type="range" min={2} max={8} step={0.5}
                value={maxMs / 1000}
                data-snap="1"
                onChange={(e) => set("asrMaxMs", Math.round(snappedRangeValue(e) * 1000))}
              />
            </div>
          </div>

          <div className="jeek-asr-note">
            上面三项参数只作用于第 ③ 步「分句对齐」的断句标准，不影响前面两步的音频提取与识别本身；想改识别精度请换「计算后端」。
          </div>
        </div>
      </Modal>
    );
  }

  /* 识别进度窗口：进度 / 日志 / 完成后的字幕列表 */
  return (
    <Modal
      title={asr.stage === "done" ? "识别完成" : asr.stage === "error" ? "识别未完成" : "识别进度"}
      width={820}
      height={720}
      bodyClassName="jeek-asr-body"
      onClose={onClose}
      foot={
        <>
          <span className="jeek-grow" data-tip="识别结果只有点「写入」才会改动工程；关闭窗口前未写入的字幕不会保留。">
            {outcome ? `已生成 ${outcome.subtitles.length} 条字幕` : busy ? "识别进行中" : "识别已结束"}
          </span>
          <button
            className="jeek-btn-ghost"
            disabled={busy}
            data-tip={busy ? "识别进行中，完成后才能关闭窗口，避免任务被中断。" : "关闭窗口。未写入的字幕不会保留。"}
            onClick={onClose}
          >
            关闭
          </button>
          {outcome && (
            <button
              className="jeek-btn-go"
              data-tip="用识别结果整轨替换现有字幕，并套用全局样式规则。这一步才真正改动工程，可以用撤销退回。"
              onClick={applyOutcome}
            >
              写入 {outcome.subtitles.length} 条字幕
            </button>
          )}
        </>
      }
    >
      <section className="jeek-asr-progress-card">
        <div className="jeek-asr-progress-head">
          <strong>{asr.stage === "done" ? "生成完成" : asr.stage === "error" ? "已停止" : "正在识别"}</strong>
          <span>{Math.round(asr.progress * 100)}%</span>
        </div>
        <div className="jeek-progress-bar"><i style={{ width: `${Math.round(asr.progress * 100)}%` }} /></div>
        {/* 这三格是「进度」不是「选项」：只有圆点会变状态，整块不接受点击、没有按钮外观 */}
        <ol className="jeek-asr-steps">
          {ASR_STAGES.map((s, i) => {
            const done = step > i;
            const current = step === i;
            return (
              <li
                key={s.key}
                className={`jeek-asr-step ${done ? "is-done" : ""} ${current ? "is-current" : ""}`}
                data-tip={s.desc}
              >
                <span className="jeek-asr-step-dot">{done ? "✓" : i + 1}</span>
                <span className="jeek-asr-step-name">{s.label}</span>
              </li>
            );
          })}
        </ol>
        <div className="jeek-asr-meta">
          <span>后端 {backend === "vulkan" ? "显卡 · Vulkan" : "CPU 通用"}</span>
          <span>设备 {asrConfig?.gpu?.name ?? "CPU / 未检测到独显"}</span>
          <span>当前阶段 {asr.message || "准备中"}</span>
          <span>语音分段 {asr.segTotal ? `${Math.min(asr.segDone, asr.segTotal)}/${asr.segTotal}` : "—"}</span>
          {outcome && <span>识别耗时 {(outcome.stats.engineMs / 1000).toFixed(1)}s</span>}
          {outcome && <span>字幕 {outcome.subtitles.length} 条</span>}
        </div>
        {note && <div className="jeek-rec-alert">{note}</div>}
      </section>

      <section className="jeek-asr-log-card" data-tip="识别引擎逐阶段输出的运行日志，新内容会自动滚到底部。">
        <div className="jeek-rec-card-title">运行日志</div>
        <div className="jeek-log jeek-asr-log" ref={logRef}>
          {logs.length ? logs.join("\n") : "等待识别启动…"}
        </div>
      </section>

      {outcome && (
        <section className="jeek-asr-result-card">
          <div className="jeek-rec-card-title">
            字幕列表
            <span className="jeek-rec-field-hint">共 {outcome.subtitles.length} 条 · 点「写入」后才进入时间轴</span>
          </div>
          <div className="jeek-asr-stats">
            <span>{outcome.subtitles.length} 条字幕</span>
            <span>{outcome.stats.backend === "vulkan" ? "GPU" : "CPU"} 识别</span>
            <span>{(outcome.stats.engineMs / 1000).toFixed(1)}s</span>
            <span>{outcome.stats.vadSegments || 0} 段语音</span>
          </div>
          <div className="jeek-asr-result">
            {outcome.subtitles.slice(0, showAll ? outcome.subtitles.length : 10).map((sub, i) => (
              <div className="jeek-asr-row" key={`${sub.startMs}-${i}`}>
                <span className="jeek-asr-time">{fmtTimecode(sub.startMs, doc.video.fps)}</span>
                <span>{sub.text}</span>
              </div>
            ))}
          </div>
          {outcome.subtitles.length > 10 && (
            <button className="jeek-btn-ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "收起列表" : `另有 ${outcome.subtitles.length - 10} 条`}
            </button>
          )}
        </section>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- 模块一览 */

export function ModulePanel({ onClose }: { onClose: () => void }) {
  const registry = useEditor((s) => s.registry);
  const modules = registry.list();
  const kinds = ["trackTypes", "panels", "tools", "commands", "inspectors", "settings", "exporters", "effects"];

  return (
    <Modal
      title="已加载模块"
      width={680}
      onClose={onClose}
      foot={<><span className="jeek-grow">共 {registry.contributions().length} 个贡献点</span><button className="jeek-btn-ghost" onClick={onClose}>关闭</button></>}
    >
      <div className="jeek-module-grid" style={{ paddingBottom: 20 }}>
        {modules.map((m) => (
          <div className="jeek-module-card" key={m.id}>
            <div className="jeek-module-name">{m.name}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
              {m.id} · v{m.version} · {registry.contributions().filter((c) => c.moduleId === m.id).length} 个贡献点
            </div>
            <div className="jeek-module-tags">
              {kinds.map((k) => {
                const n = registry.contributions(k as never).filter((c) => c.moduleId === m.id).length;
                return n > 0 ? <span className="jeek-tag" key={k}>{k} {n}</span> : null;
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ 查找替换 */

export function FindPanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const notify = useEditor((s) => s.notify);
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const matched = countMatches(doc, find, caseSensitive);

  const doReplace = () => {
    const state = useEditor.getState();
    const result = replaceSubtitleText(state.doc, find, replacement, caseSensitive);
    if (result.count === 0) { notify("没有找到要替换的文本"); return; }
    state.commit("查找替换", result.doc);
    notify(`已替换 ${result.count} 处`);
  };

  return (
    <Modal
      title="查找替换 (Ctrl+H)"
      width={380}
      onClose={onClose}
      foot={
        <>
          <span className="jeek-grow" />
          <button className="jeek-btn-ghost" onClick={onClose}>关闭</button>
          <button className="jeek-btn-primary" disabled={!find} onClick={doReplace}>替换全部</button>
        </>
      }
    >
      <div className="jeek-find-form">
        <label className="jeek-field" htmlFor="jeek-find-term">查找</label>
        <input
          id="jeek-find-term"
          className="jeek-input jeek-find-term"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="要查找的文本"
          autoFocus
        />
        <label className="jeek-field" htmlFor="jeek-find-replace">替换为</label>
        <input
          id="jeek-find-replace"
          className="jeek-input jeek-find-replace"
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          placeholder="替换后的文本"
        />
        <label className="jeek-find-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          区分大小写
        </label>
        <div className="jeek-find-count">{find ? `匹配 ${matched} 处` : "输入查找内容"}</div>
      </div>
    </Modal>
  );
}

export { downloadBlob, downloadText, toSrt, cuesFromDocument, fmtTimecode };
