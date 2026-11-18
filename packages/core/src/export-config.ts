import { LOGICAL_SHORT_EDGE } from "@jeek/contracts";

/**
 * 导出参数归一。
 *
 * 界面只给出「档位」，真正的编码参数在这里换算成确定值：
 * 质量档决定 CPU 预设与显卡预设，CRF 落在 1..51，显卡编码用 CQ = CRF + 1，
 * 并行帧数落在 1..32。所有入口都走同一套换算，避免面板、服务端各算一遍。
 */

export type ExportCodec = "h264" | "h265";
export type ExportQuality = "fast" | "balanced" | "high";
export type ExportAccel = "auto" | "gpu" | "cpu";

interface QualityPreset {
  crf: number;
  cq: number;
  cpuPreset: string;
  gpuPreset: string;
}

export const EXPORT_QUALITY: Record<ExportQuality, QualityPreset> = {
  fast: { crf: 24, cq: 25, cpuPreset: "veryfast", gpuPreset: "p3" },
  balanced: { crf: 20, cq: 21, cpuPreset: "medium", gpuPreset: "p5" },
  high: { crf: 16, cq: 17, cpuPreset: "slow", gpuPreset: "p7" },
};

export const EXPORT_CRF_MIN = 1;
export const EXPORT_CRF_MAX = 51;
/** 面板滑杆的范围，比合法区间窄，避免一上手就调到极端 */
export const EXPORT_CRF_SLIDER_MIN = 14;
export const EXPORT_CRF_SLIDER_MAX = 30;

const isQuality = (value: unknown): value is ExportQuality =>
  value === "fast" || value === "balanced" || value === "high";

const isCodec = (value: unknown): value is ExportCodec => value === "h264" || value === "h265";

const isAccel = (value: unknown): value is ExportAccel =>
  value === "auto" || value === "gpu" || value === "cpu";

const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value));

/** 默认并行帧数：不超过 4，也不吃满机器（CPU 核数一半、每路按 8 GB 内存估） */
export function defaultConcurrency(cpuCount = 8, totalMemGb = 32): number {
  const byCpu = Math.floor(cpuCount / 2);
  const byMem = Math.floor(totalMemGb / 8);
  return Math.max(1, Math.min(4, byCpu, byMem));
}

export interface ExportConfigInput {
  codec?: unknown;
  quality?: unknown;
  crf?: unknown;
  accel?: unknown;
  concurrency?: unknown;
  resolution?: unknown;
  aspect?: unknown;
  /** 比例值（宽/高）；给了就直接用，不给再按 aspect 查 */
  ratio?: unknown;
}

export interface ExportConfig {
  codec: ExportCodec;
  quality: ExportQuality;
  crf: number;
  /** 显卡编码用的 CQ，恒为 CRF + 1 */
  cq: number;
  cpuPreset: string;
  gpuPreset: string;
  accel: ExportAccel;
  /** 0 表示自动 */
  concurrency: number;
  /** 输出像素，两边都是偶数 */
  width: number;
  height: number;
  /** 成片短边像素 */
  shortEdge: number;
  /** 容器格式：透明工程用 mov，其余 mp4 */
  container: "mp4" | "mov";
}

const ASPECT_RATIO: Record<string, number> = {
  landscape: 16 / 9,
  portrait: 9 / 16,
  square: 1,
  standard: 4 / 3,
  story: 4 / 5,
  wide: 21 / 9,
};

const RESOLUTION_EDGE: Record<string, number> = {
  "1080P": 1080,
  "1440P": 1440,
  "2160P": 2160,
};

const even = (value: number): number => 2 * Math.round(value / 2);

const evenEdge = (value: number): number => (Number.isFinite(value) && value > 0 ? even(value) : 1080);

/** 短边固定、长边按比例推出来，两边都取偶数，避免编码器要求偶数宽高 */
export function outputSize(shortEdge: number, ratio: number): { width: number; height: number } {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  const edge = evenEdge(shortEdge);
  if (r >= 1) return { width: even(edge * r), height: edge };
  return { width: edge, height: even(edge / r) };
}

export function normalizeExportConfig(input: ExportConfigInput = {}): ExportConfig {
  const quality: ExportQuality = isQuality(input.quality) ? input.quality : "balanced";
  const preset = EXPORT_QUALITY[quality];

  // 有明确 CRF 就按它算，否则跟随档位；显卡那边永远比 CRF 高 1，保持同档画质
  const hasCrf = typeof input.crf === "number" && Number.isFinite(input.crf);
  const crf = hasCrf
    ? clamp(Math.round(input.crf as number), EXPORT_CRF_MIN, EXPORT_CRF_MAX)
    : preset.crf;
  const cq = hasCrf ? crf + 1 : preset.cq;

  const concurrency =
    typeof input.concurrency === "number" && Number.isFinite(input.concurrency) && input.concurrency > 0
      ? clamp(Math.round(input.concurrency), 1, 32)
      : 0;

  const shortEdge = RESOLUTION_EDGE[String(input.resolution ?? "1080P")] ?? 1080;
  const ratio =
    typeof input.ratio === "number" && Number.isFinite(input.ratio) && input.ratio > 0
      ? input.ratio
      : ASPECT_RATIO[String(input.aspect ?? "landscape")] ?? 16 / 9;
  const size = outputSize(shortEdge, ratio);

  return {
    codec: isCodec(input.codec) ? input.codec : "h264",
    quality,
    crf,
    cq,
    cpuPreset: preset.cpuPreset,
    gpuPreset: preset.gpuPreset,
    accel: isAccel(input.accel) ? input.accel : "auto",
    concurrency,
    width: size.width,
    height: size.height,
    shortEdge: evenEdge(shortEdge),
    container: "mp4",
  };
}

/** 逻辑画布尺寸：短边固定 1440，长边按比例推出来 */
export function logicalSize(ratio: number): { width: number; height: number } {
  return outputSize(LOGICAL_SHORT_EDGE, ratio);
}

/** 显卡编码器名：H.264 / H.265 各一支 */
export function gpuEncoderOf(codec: ExportCodec): string {
  return codec === "h265" ? "hevc_nvenc" : "h264_nvenc";
}

/** CPU 编码器名：libx264 / libx265 */
export function cpuEncoderOf(codec: ExportCodec): string {
  return codec === "h265" ? "libx265" : "libx264";
}

/** 编码器口径不支持的提示，与旧版同一句话 */
export function gpuUnsupportedMessage(codec: ExportCodec): string {
  return `当前 FFmpeg 不支持 ${gpuEncoderOf(codec)} 硬件编码，请改用「自动」或「CPU 编码」。`;
}
