import type { ProjectDocument } from "@jeek/contracts";
import {
  applyGain,
  applyNoiseReduction,
  dbToGain,
  durationOf,
  frameCountOf,
  readAudioProcessing,
  segmentNormalizeGain,
} from "@jeek/core";

export interface DecodedAudio {
  name: string;
  buffer: AudioBuffer;
  peaks: number[];
  durationMs: number;
  url: string;
}

let sharedContext: AudioContext | null = null;
export const audioContext = (): AudioContext => {
  if (!sharedContext) sharedContext = new AudioContext();
  if (sharedContext.state === "suspended") void sharedContext.resume();
  return sharedContext;
};

/** 波形峰值：每毫秒取一次绝对值最大（超长音频自动降密度），绘制时再按当前缩放做区间降采样 */
export function computePeaks(buffer: AudioBuffer): number[] {
  const channel = buffer.getChannelData(0);
  const step = Math.max(
    1,
    Math.round(buffer.sampleRate / 1000),
    Math.ceil(channel.length / 600000),
  );
  const peaks: number[] = [];
  for (let i = 0; i < channel.length; i += step) {
    let max = 0;
    const end = Math.min(channel.length, i + step);
    for (let j = i; j < end; j += 1) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const data = await file.arrayBuffer();
  const buffer = await audioContext().decodeAudioData(data.slice(0));
  return {
    name: file.name,
    buffer,
    peaks: computePeaks(buffer),
    durationMs: (buffer.duration || 0) * 1000,
    url: URL.createObjectURL(file),
  };
}

/** 按时间轴片段重建音轨：片段的 inMs 是源内偏移，移动片段不改 inMs。
 *  音轨面板的降噪 / 统一音量 / 分贝增益都在这里一次性落到样本上，
 *  播放、成品导出、语音转字幕三处拿到的是同一份处理结果。 */
export function renderTrackAudio(doc: ProjectDocument, source: AudioBuffer | null): AudioBuffer | null {
  if (!source) return null;
  const track = doc.tracks.find((t) => t.kind === "audio");
  if (!track || track.clips.length === 0) return null;
  const ctx = audioContext();
  const totalMs = Math.max(1, durationOf(doc));
  const rate = source.sampleRate;
  const out = ctx.createBuffer(source.numberOfChannels, Math.ceil((totalMs / 1000) * rate), rate);
  const src = source.getChannelData(0);
  const proc = readAudioProcessing(doc.settings ?? {});
  for (const clip of track.clips) {
    const from = Math.max(0, Math.floor((clip.inMs / 1000) * rate));
    const length = Math.max(0, Math.floor(((clip.endMs - clip.startMs) / 1000) * rate));
    const to = Math.floor((clip.startMs / 1000) * rate);
    if (to >= out.length || length <= 0) continue;
    const count = Math.min(length, out.length - to, Math.max(0, src.length - from));
    // 统一音量按每个片段自身的响度反推补偿，片段之间不再忽大忽小
    const segGain = proc.uniformVolume ? segmentNormalizeGain(src, from, count) : 1;
    const dst = out.getChannelData(0);
    for (let i = 0; i < count; i += 1) dst[to + i] = src[from + i] * segGain;
    for (let c = 1; c < out.numberOfChannels; c += 1) {
      const dstC = out.getChannelData(c);
      const srcC = source.getChannelData(Math.min(c, source.numberOfChannels - 1));
      for (let i = 0; i < count; i += 1) dstC[to + i] = srcC[from + i] * segGain;
    }
  }
  if (proc.noiseReduction) {
    for (let c = 0; c < out.numberOfChannels; c += 1) {
      applyNoiseReduction(out.getChannelData(c), rate);
    }
  }
  const gain = dbToGain(proc.gainDb);
  if (gain !== 1) {
    for (let c = 0; c < out.numberOfChannels; c += 1) applyGain(out.getChannelData(c), gain);
  }
  return out;
}

/** 把整段音频按时间轴片段拼成一个新 AudioBuffer，供识别与导出使用 */
export function audioToWavBuffer(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const bytes = 44 + length * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * channels * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return view.buffer;
}

/* ---------------------------------------------------------------- 录音 */

export class ChunkRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    // 分块采集，长录音也不会一次性占满内存
    this.recorder.start(1000);
  }

  async stop(): Promise<AudioBuffer | null> {
    if (!this.recorder) return null;
    const recorder = this.recorder;
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    if (!this.chunks.length) return null;
    const blob = new Blob(this.chunks, { type: recorder.mimeType });
    try {
      return await audioContext().decodeAudioData(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }
}

/** 下混成单声道并重采样到目标采样率（线性插值，够用且不依赖异步上下文） */
function toMonoAtRate(buffer: AudioBuffer, rate: number): Float32Array {
  const channels = Math.max(1, buffer.numberOfChannels);
  const out = new Float32Array(Math.max(0, Math.round((buffer.length / buffer.sampleRate) * rate)));
  for (let i = 0; i < out.length; i += 1) {
    const pos = (i / rate) * buffer.sampleRate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      const a = data[i0] ?? 0;
      const b = data[i0 + 1] ?? a;
      sum += a + (b - a) * frac;
    }
    out[i] = sum / channels;
  }
  return out;
}

/**
 * 录音追加：新录音接在音轨末尾。
 * - 已有音源先下混单声道并重采样到录音采样率，再把录音拼在后面（口径照旧版 concat 滤镜：规整成单声道同采样率，时长精确相加）；
 * - 时间轴位置紧贴现有最后一个片段的末尾，两段之间不留空隙；
 * - 源内偏移是「已有音源在合并缓冲里的长度」，所以片段取到的就是刚录的那一段。
 */
export function appendRecording(
  doc: ProjectDocument,
  recorded: AudioBuffer,
  existing: AudioBuffer | null,
): { buffer: AudioBuffer; startMs: number; endMs: number; inMs: number; durationMs: number } | null {
  const ctx = audioContext();
  const rate = recorded.sampleRate || 48000;
  const fresh = toMonoAtRate(recorded, rate);
  let buffer: AudioBuffer;
  let inMs = 0;
  if (existing) {
    const base = toMonoAtRate(existing, rate);
    const merged = ctx.createBuffer(1, base.length + fresh.length, rate);
    merged.getChannelData(0).set(base, 0);
    merged.getChannelData(0).set(fresh, base.length);
    buffer = merged;
    inMs = (base.length / rate) * 1000;
  } else {
    buffer = ctx.createBuffer(1, fresh.length, rate);
    buffer.getChannelData(0).set(fresh, 0);
  }
  const track = doc.tracks.find((t) => t.kind === "audio");
  const startMs = track && track.clips.length
    ? Math.max(...track.clips.map((c) => c.endMs))
    : 0;
  const durationMs = (fresh.length / rate) * 1000;
  const endMs = startMs + durationMs;
  return { buffer, startMs, endMs, inMs, durationMs };
}

/* ---------------------------------------------------------------- 播放 */

let activeSource: AudioBufferSourceNode | null = null;
/** 正在播放的增益节点：静音开关要在播放中实时改它，而不是等下一次起播 */
let activeGain: GainNode | null = null;
/** 音频起播时刻与起点：播放头以声卡时钟为准，掉帧也不会和声音错位 */
let clockStartedAt = 0;
let clockOffsetMs = 0;
let clockRunning = false;

export function playAudio(buffer: AudioBuffer | null, offsetMs: number, gainValue = 1): void {
  stopAudio();
  if (!buffer) return;
  const ctx = audioContext();
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  source.buffer = buffer;
  source.connect(gain).connect(ctx.destination);
  const from = Math.max(0, offsetMs / 1000);
  source.start(0, from);
  activeSource = source;
  activeGain = gain;
  clockStartedAt = ctx.currentTime;
  clockOffsetMs = from * 1000;
  clockRunning = true;
}

/** 播放中实时改音量：喇叭按下去立即静音、拖音量条立即变响，不用等下一次起播 */
export function setPlaybackGain(value: number): void {
  if (!activeGain) return;
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
  activeGain.gain.value = v;
}

/** 当前真正该送进增益节点的音量：播放器静音或音轨静音任一成立就是 0，否则取总音量（0~100%）。
 *  起播、轨道静音切换、播放器静音切换、拖音量条都走这一个口径。 */
export function effectivePlaybackGain(doc: ProjectDocument, playerMuted: boolean): number {
  const trackMuted = doc.tracks.find((t) => t.kind === "audio")?.muted;
  if (playerMuted || trackMuted) return 0;
  const raw = Number(doc.settings.masterGain ?? 1);
  return Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 1));
}

/** 正在播放时返回声音已经走到的时间；没在放声音返回 null，让调用方自己按帧计时 */
export function audioClockMs(): number | null {
  if (!clockRunning) return null;
  return clockOffsetMs + (audioContext().currentTime - clockStartedAt) * 1000;
}

export function stopAudio(): void {
  try {
    activeSource?.stop();
  } catch {
    // 已经自然结束
  }
  activeSource = null;
  activeGain = null;
  clockRunning = false;
}

/* ---------------------------------------------------------------- 视频导出 */

/** 导出格式：MP4 不透明视频、MOV（ProRes 4444）透明视频 */
export type ExportFormat = "mp4" | "mov";

/** 导出四阶段：逐帧离线渲染、上传帧、服务端编码、取回成品 */
export type RenderPhase = "render" | "upload" | "encode" | "mux";

export interface RenderStageInfo {
  phase: RenderPhase;
  /** 当前阶段内部进度 0..1 */
  ratio: number;
  done: number;
  total: number;
  message: string;
}

export interface ExportFramesOptions {
  canvas: HTMLCanvasElement;
  paint: (timeMs: number) => void;
  doc: ProjectDocument;
  audio: AudioBuffer | null;
  format: ExportFormat;
  fps: number;
  renderUrl: string;
  codec?: string;
  quality?: string;
  crf?: number;
  accel?: string;
  concurrency?: number;
  resolution?: string;
  aspect?: string;
  /** MOV 专用：ProRes 规格（4444 / 4444 XQ）与量化强度 qscale（2..31，越小画质越好） */
  movSpec?: string;
  movQscale?: number;
  signal?: AbortSignal;
  /** 分阶段真实进度，界面据此画两条独立进度条 */
  onStage?: (info: RenderStageInfo) => void;
  /** 桌面桥模式：不把成品整包取回渲染进程，只回传 jobId，交给主进程从渲染服务流式落盘（支持数 GB 大文件） */
  skipResult?: boolean;
  /** 成品将保存到的目录：临时帧优先落在这块盘上，避免撑爆系统盘临时目录 */
  workDir?: string;
}

export interface ExportFramesResult {
  /** 浏览器模式下的成品 blob；主进程流式落盘模式（桌面桥）下为 null */
  blob: Blob | null;
  /** 渲染服务的导出任务 ID，主进程流式落盘时用来从服务端取成品 */
  jobId: string;
  hardwareEncoded: boolean;
}

/** MP4 是不透明容器，用 JPEG 帧：编码快、体积小；MOV 要带 alpha，只能用 PNG。
 * 两种格式都跳过浏览器的实时录制，帧率不再被墙钟和 rAF 的 60Hz 锁死。 */
function frameTypeOf(format: ExportFormat): { mime: string; ext: string; quality?: number } {
  return format === "mp4"
    ? { mime: "image/jpeg", ext: "jpg", quality: 0.94 }
    : { mime: "image/png", ext: "png" };
}

/* ---- 帧编码 ----
   canvas.toBlob 的编码回调走浏览器空闲任务：前台时随合成帧正常触发（约 10~15ms），
   但窗口被遮挡或最小化后没有合成帧，只能等 1 秒兜底节拍（实测 1002ms/帧），
   导出看起来就像停摆。Worker 有独立事件循环，不受页面可见性影响。
   策略：先走 toBlob（前台最快），一旦单帧超过 400ms 就整体切到 Worker 编码。 */
let frameWorker: Worker | null = null;
let frameWorkerBroken = false;
let frameWorkerSeq = 0;
const frameWorkerPending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

function ensureFrameWorker(): Worker | null {
  if (frameWorker || frameWorkerBroken) return frameWorker;
  try {
    const code = `self.onmessage = async (e) => {
      const { id, bmp, mime, quality } = e.data;
      try {
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = oc.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const blob = await oc.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
        self.postMessage({ id, blob });
      } catch (err) {
        self.postMessage({ id, error: String(err && err.message ? err.message : err) });
      }
    };`;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const slot = frameWorkerPending.get(e.data.id);
      if (!slot) return;
      frameWorkerPending.delete(e.data.id);
      if (e.data.blob) slot.resolve(e.data.blob);
      else slot.reject(new Error(e.data.error || "帧编码失败"));
    };
    frameWorker = w;
  } catch {
    frameWorkerBroken = true;
    frameWorker = null;
  }
  return frameWorker;
}

function encodeInWorker(canvas: HTMLCanvasElement, type: ReturnType<typeof frameTypeOf>): Promise<Blob> {
  const worker = ensureFrameWorker();
  if (!worker) return blobViaToBlob(canvas, type);
  return createImageBitmap(canvas).then((bmp) => new Promise<Blob>((resolve, reject) => {
    const id = ++frameWorkerSeq;
    frameWorkerPending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, bmp, mime: type.mime, quality: type.quality }, [bmp]);
    } catch (error) {
      frameWorkerPending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }));
}

function blobViaToBlob(canvas: HTMLCanvasElement, type: ReturnType<typeof frameTypeOf>): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("画布导出帧失败"))),
      type.mime,
      type.quality,
    );
  });
}

function canvasToFrameBlob(canvas: HTMLCanvasElement, type: ReturnType<typeof frameTypeOf>): Promise<Blob> {
  return blobViaToBlob(canvas, type);
}

/** 提交帧并拿回 jobId；用 XHR 是为了把「上传」这一段也画出真实进度 */
function submitFrames(
  url: string,
  form: FormData,
  signal: AbortSignal | undefined,
  onUpload: (ratio: number) => void,
): Promise<{ jobId: string; total: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "json";
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onUpload(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      cleanup();
      if (signal?.aborted) return reject(new DOMException("导出已取消", "AbortError"));
      const body = xhr.response as { jobId?: string; total?: number; error?: string } | null;
      if (xhr.status < 200 || xhr.status >= 300 || !body?.jobId) {
        return reject(new Error(body?.error || `提交帧失败 ${xhr.status}`));
      }
      resolve({ jobId: body.jobId, total: Number(body.total) || 0 });
    };
    xhr.onerror = () => { cleanup(); reject(new Error("无法连接渲染服务")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("导出已取消", "AbortError")); };
    xhr.send(form);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
/** 让出主线程保持界面可响应，但不回到 requestAnimationFrame 的 60Hz 节流 */
const yieldUi = () => new Promise<void>((r) => { setTimeout(r, 0); });

/** MP4 / MOV 共用一条离线逐帧管线：
 * ① 按帧号渲染（不看墙钟，速度只取决于画布绘制与帧编码，不受视频时长或刷新率限制）
 * ② 帧 + 音轨一次提交给渲染服务，拿到 jobId
 * ③ 轮询 ffmpeg -progress 的真实编码帧数
 * ④ 取回成品；MP4 优先走 NVENC 显卡编码，MOV 走 ProRes 4444 透明编码 */
export async function exportVideoFrames(options: ExportFramesOptions): Promise<ExportFramesResult> {
  const {
    canvas, paint, doc, audio, format, fps, renderUrl, signal, onStage,
    codec, quality, crf, accel, concurrency, resolution, aspect, movSpec, movQscale,
    /** 桌面桥模式：不把成品整包取回渲染进程，只回传 jobId 交给主进程流式落盘（避免大文件爆内存） */
    skipResult = false,
    workDir = "",
  } = options;
  const totalFrames = Math.max(1, frameCountOf(doc));
  const totalMs = Math.max(1000, durationOf(doc));
  const base = `${renderUrl}/api/v1/media/render`;
  const type = frameTypeOf(format);
  const report = (phase: RenderPhase, ratio: number, done: number, total: number, message: string) =>
    onStage?.({ phase, ratio, done, total, message });

  /* 阶段一：离线逐帧渲染，帧号直接换算时间。
     实测离屏画布做多帧并行编码反而更慢（画布拷贝开销大于并行收益），保持直接编码。 */
  const form = new FormData();
  // 参数先发：服务端边收边写盘，要靠 format 决定帧文件的扩展名（MP4 用 jpg、MOV 用 png）
  form.append("meta", JSON.stringify({
    format, fps, codec, quality, crf, accel, concurrency, resolution, aspect, movSpec, movQscale,
  }));
  let useWorkerEncode = false;
  for (let i = 0; i < totalFrames; i += 1) {
    if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
    const time = Math.min(totalMs, (totalFrames === 1 ? 0 : (i / (totalFrames - 1)) * totalMs));
    paint(time);
    const encodeAt = performance.now();
    let blob: Blob;
    if (useWorkerEncode) {
      blob = await encodeInWorker(canvas, type);
    } else {
      blob = await canvasToFrameBlob(canvas, type);
      // 单帧超过 400ms 说明窗口已不在前台、toBlob 正被按 1 秒节拍处理 ⇒ 后续改走 Worker
      if (performance.now() - encodeAt > 400) useWorkerEncode = true;
    }
    form.append(`frame${String(i).padStart(5, "0")}`, blob, `frame${i}.${type.ext}`);
    report("render", (i + 1) / totalFrames, i + 1, totalFrames, `正在渲染帧 ${i + 1}/${totalFrames}`);
    if (i % 8 === 7) await yieldUi();
  }
  if (audio) {
    form.append("audio", new Blob([audioToWavBuffer(audio)], { type: "audio/wav" }), "audio.wav");
  }

  /* 阶段二 A：上传帧。临时帧由服务端边收边写盘，不整包进内存；
     带上 workDir 让它优先落在成品同盘，长视频不会撑爆系统盘临时目录。 */
  report("upload", 0, 0, totalFrames, "正在上传帧到渲染服务…");
  const uploadUrl = workDir ? `${base}?workDir=${encodeURIComponent(workDir)}` : base;
  const { jobId } = await submitFrames(uploadUrl, form, signal, (r) =>
    report("upload", r, Math.round(r * totalFrames), totalFrames, `正在上传帧 ${Math.round(r * 100)}%`),
  );
  report("upload", 1, totalFrames, totalFrames, "帧已上传，正在启动编码…");

  // 用户中途取消时通知服务端停掉 ffmpeg，避免后台继续空转
  const onAbortCancel = () => {
    void fetch(`${base}/cancel?jobId=${encodeURIComponent(jobId)}`, { method: "POST" }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbortCancel, { once: true });

  /* 阶段二 B：轮询服务端 ffmpeg 的真实编码进度 */
  report("encode", 0, 0, totalFrames, "正在启动视频编码…");
  for (;;) {
    if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
    const pr = await fetch(`${base}/progress?jobId=${encodeURIComponent(jobId)}`, { signal });
    if (!pr.ok) throw new Error(`查询编码进度失败 ${pr.status}`);
    const info = (await pr.json()) as {
      status: string; stage?: string; encoded: number; total: number; error?: string;
    };
    const total = info.total || totalFrames;
    const done = Math.min(total, info.encoded || 0);
    if (info.status === "error") throw new Error(info.error || "视频编码失败");
    if (info.status === "cancelled") throw new DOMException("导出已取消", "AbortError");
    report("encode", total > 0 ? done / total : 0, done, total,
      info.stage || `正在编码 ${done}/${total} 帧`);
    if (info.status === "done") break;
    await sleep(250);
  }
  signal?.removeEventListener("abort", onAbortCancel);

  /* 阶段三：取回成品。
     桌面桥模式（skipResult）：渲染进程不取回整包，只回传 jobId，由主进程直接从渲染服务
     把成品流式落盘 —— 成品可以是数 GB，渲染进程的 ArrayBuffer 上限约 2GB，整包取回必崩。
     浏览器模式：用 XMLHttpRequest 下载，刻意不用 fetch() —— Chromium 的 fetch 在拉取大二进制
     响应体时，收到约 12.5MB 会内部中止（前端抛 Failed to fetch、成品取不回来）；XHR 不受该限制。 */
  report("mux", 0, totalFrames, totalFrames, "正在取回成品…");
  if (skipResult) {
    report("mux", 1, totalFrames, totalFrames, "已就绪，交由桌面壳落盘");
    return { blob: null, jobId, hardwareEncoded: false };
  }
  const { buf, hardwareEncoded } = await new Promise<{ buf: Uint8Array<ArrayBuffer>; hardwareEncoded: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${base}/result?jobId=${encodeURIComponent(jobId)}`);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({
          buf: new Uint8Array(xhr.response as ArrayBuffer),
          hardwareEncoded: xhr.getResponseHeader("X-Jeek-Hardware-Encoded") === "1",
        });
      } else {
        reject(new Error(`取回成品失败 ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("取回成品失败（网络错误）"));
    const ac = signal;
    if (ac) ac.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send();
  });
  if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
  const ctype = format === "mov" ? "video/quicktime" : "video/mp4";
  const blob = new Blob([buf], { type: ctype });
  report("mux", 1, totalFrames, totalFrames, "成品已生成");
  return { blob, jobId, hardwareEncoded };
}

/** 三阶段识别：提取时间轴音轨 → 本地识别 → 分句对齐 */
export interface AsrProgressInfo {
  stage: string;
  percent: number;
  detail: string;
  segDone: number;
  segTotal: number;
  gpuName: string;
  logs: string[];
  done: boolean;
}

export interface AsrResult {
  ok: boolean;
  srt?: string;
  segments?: Array<{ startMs: number; endMs: number; text: string }>;
  stats?: {
    vadSegments: number;
    segments: number;
    backend: string;
    vadMaxSeg: number;
    engineMs: number;
    gpuName: string;
  };
  error?: string;
}

/** 语音转字幕配置预检（照旧版 asrConfig）：显卡 / 识别资源就绪 / 后端可用性 */
export interface AsrBackendOption {
  id: string;
  label: string;
  desc: string;
  available: boolean;
  recommended: boolean;
}
export interface AsrConfig {
  ok: boolean;
  gpu: { name: string; memory: string } | null;
  status: {
    ok: boolean;
    missing: string[];
    defaultBackend: string;
    backends: AsrBackendOption[];
  };
}

/** 拉取识别配置；拿不到（服务没起 / 跨源被拦）时返回 null，界面退化为默认展示 */
export async function fetchAsrConfig(renderUrl: string): Promise<AsrConfig | null> {
  try {
    const response = await fetch(`${renderUrl}/api/v1/asr/config`, { method: "GET" });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      ok: Boolean(data.ok),
      gpu: data.gpu ?? null,
      status: {
        ok: Boolean(data.status?.ok),
        missing: Array.isArray(data.status?.missing) ? data.status.missing : [],
        defaultBackend: String(data.status?.defaultBackend ?? "vulkan"),
        backends: Array.isArray(data.status?.backends) ? data.status.backends : [],
      },
    };
  } catch {
    return null;
  }
}

/** 交识别服务：启动任务后轮询进度，逐段事件回传给界面 */
export async function recognizeOnServer(
  wav: ArrayBuffer,
  renderUrl: string,
  opts: { backend?: string; vadMaxSeg?: number; onProgress?: (p: AsrProgressInfo) => void } = {},
): Promise<AsrResult> {
  const backend = opts.backend === "cpu" ? "cpu" : "vulkan";
  const vadMaxSeg = Math.round(Number(opts.vadMaxSeg ?? 8000)) || 8000;
  try {
    const response = await fetch(`${renderUrl}/api/v1/asr?backend=${backend}&vadMaxSeg=${vadMaxSeg}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    const started = await response.json();
    if (!response.ok || !started.ok) return { ok: false, error: started.error ?? `HTTP ${response.status}` };
    const jobId = String(started.jobId ?? "");
    if (!jobId) return { ok: false, error: "识别服务未返回任务编号" };

    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) return { ok: false, error: "识别超时，换个更短的素材试试" };
      await new Promise((r) => setTimeout(r, 260));
      const poll = await fetch(`${renderUrl}/api/v1/asr/${jobId}/progress`);
      if (!poll.ok) continue;
      const data = await poll.json();
      const job = data.progress;
      if (!job) continue;
      opts.onProgress?.(job as AsrProgressInfo);
      if (!job.done) continue;
      if (job.error) return { ok: false, error: String(job.error) };
      return {
        ok: true,
        srt: job.result?.srt,
        segments: job.result?.segments,
        stats: job.result?.stats,
      };
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
