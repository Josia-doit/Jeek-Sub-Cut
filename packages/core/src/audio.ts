/**
 * 音轨处理：只做数值运算，不碰 Web Audio。
 * 预览播放、成品导出、语音转字幕都从 renderTrackAudio 取同一份处理结果，
 * 所以降噪 / 统一音量 / 分贝增益只需在这里实现一次。
 */

/** 增益档位：0 dB 为原始音量，负向 30 档、正向 30 档，左右对称；1 dB 一档 */
export const GAIN_DB_MIN = -30;
export const GAIN_DB_MAX = 30;
/** 滑块最左额外一档：-∞ 静音，用比下限再小 1 的哨兵值表示，保证与 -30 dB 相邻且互不重叠 */
export const GAIN_DB_SILENT = GAIN_DB_MIN - 1;
/** 0 dB = 原始音量（单位增益） */
export const GAIN_DB_DEFAULT = 0;

export function clampGainDb(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return GAIN_DB_DEFAULT;
  if (n <= GAIN_DB_SILENT) return GAIN_DB_SILENT;
  return Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, Math.round(n)));
}

/** 面板读数：静音档写 -∞，正增益带 + 号，其余按实际增减益分贝显示 */
export function formatGainDb(value: number): string {
  const db = clampGainDb(value);
  if (db <= GAIN_DB_SILENT) return "-∞";
  return `${db > 0 ? "+" : ""}${db} dB`;
}

/** 分贝 → 线性幅度增益；-∞ 档直接返回 0 */
export function dbToGain(value: number): number {
  const db = clampGainDb(value);
  if (db <= GAIN_DB_SILENT) return 0;
  return Math.pow(10, db / 20);
}

export interface AudioProcessing {
  noiseReduction: boolean;
  uniformVolume: boolean;
  gainDb: number;
}

/** 工程设置 → 音轨处理参数；旧工程缺字段时全部退回「不处理」 */
export function readAudioProcessing(settings: Record<string, unknown>): AudioProcessing {
  return {
    noiseReduction: Boolean(settings.audioNoiseReduction ?? false),
    uniformVolume: Boolean(settings.audioUniformVolume ?? false),
    gainDb: clampGainDb(settings.audioGainDb ?? GAIN_DB_DEFAULT),
  };
}

/** 统一音量的目标响度：-20 dBFS 的 RMS，接近人声素材的常用基准 */
const TARGET_RMS = 0.1;
/**
 * 逐片段响度归一：按片段自身的 RMS 反推补偿增益，夹在 ±12 dB 内。
 * 纯静音段直接跳过，免得把底噪抬成一片沙沙声。
 */
export function segmentNormalizeGain(samples: Float32Array, from: number, count: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, from + Math.max(0, count));
  if (end <= start) return 1;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / (end - start));
  if (rms < 1e-4) return 1;
  return Math.max(0.25, Math.min(4, TARGET_RMS / rms));
}

/** 基础降噪：80 Hz 一阶高通去低频隆隆 + 10 ms 窗口噪声门压掉静音段底噪 */
const HP_CUTOFF_HZ = 80;
const GATE_FLOOR = 0.0056;   // 约 -45 dBFS，低于此视作底噪
const GATE_OPEN = 0.0178;    // 约 -35 dBFS，高于此完整放行
const GATE_MIN_GAIN = 0.12;

export function applyNoiseReduction(data: Float32Array, sampleRate: number): void {
  const rate = Math.max(8000, sampleRate);
  const rc = 1 / (2 * Math.PI * HP_CUTOFF_HZ);
  const alpha = rc / (rc + 1 / rate);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < data.length; i += 1) {
    const x = data[i];
    const y = alpha * (prevY + x - prevX);
    data[i] = y;
    prevY = y;
    prevX = x;
  }
  const win = Math.max(64, Math.round(rate * 0.01));
  const blocks = Math.ceil(data.length / win);
  const gains = new Float32Array(blocks);
  for (let b = 0; b < blocks; b += 1) {
    const s = b * win;
    const e = Math.min(data.length, s + win);
    let sum = 0;
    for (let i = s; i < e; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / Math.max(1, e - s));
    gains[b] = rms <= GATE_FLOOR ? GATE_MIN_GAIN
      : rms >= GATE_OPEN ? 1
      : GATE_MIN_GAIN + (1 - GATE_MIN_GAIN) * ((rms - GATE_FLOOR) / (GATE_OPEN - GATE_FLOOR));
  }
  // 窗口之间线性过渡，避免增益跳变产生「咔哒」声
  for (let b = 0; b < blocks; b += 1) {
    const s = b * win;
    const e = Math.min(data.length, s + win);
    const start = b > 0 ? (gains[b - 1] + gains[b]) / 2 : gains[b];
    const span = Math.max(1, e - s);
    for (let i = s; i < e; i += 1) {
      data[i] *= start + (gains[b] - start) * ((i - s) / span);
    }
  }
}

/** 整轨增益：逐样本施加并夹在 [-1, 1]，正增益时防止削波 */
export function applyGain(data: Float32Array, gain: number): void {
  if (gain === 1) return;
  if (gain === 0) { data.fill(0); return; }
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.max(-1, Math.min(1, data[i] * gain));
  }
}
