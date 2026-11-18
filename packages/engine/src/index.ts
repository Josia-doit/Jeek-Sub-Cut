import type {
  FrameData,
  Id,
  RenderProgress,
  RenderProvider,
  RenderRequest,
  RenderResult,
} from "@jeek/contracts";
import { durationOf } from "@jeek/core";
import { evaluateFrame, fingerprintFrame } from "./evaluate.js";

export * from "./evaluate.js";

/** FNV-1a：给一帧算出确定性指纹，用于回归比对（首阶段不产出真实像素） */
const checksumOf = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** 时间轴求值：某一时刻有哪些片段可见。所有渲染实现共用这份纯计算 */
export const visibleClipsAt = (request: RenderRequest, timeMs: number) =>
  request.document.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.startMs <= timeMs && timeMs < clip.endMs);

export function validateRenderRequest(request: RenderRequest): string | null {
  if (!request || typeof request !== "object") return "渲染请求不是对象";
  if (!request.requestId) return "缺少 requestId";
  if (!request.document || !Array.isArray(request.document.tracks)) return "缺少工程文档";
  if (!(request.fps > 0)) return "帧率必须为正";
  if (!(request.width > 0) || !(request.height > 0)) return "画面尺寸必须为正";
  if (!(request.toMs > request.fromMs)) return "渲染区间必须为正";
  if (request.fromMs < 0) return "起点不能为负";
  return null;
}

class FrameRenderProvider implements RenderProvider {
  readonly id = "frame-programmatic";
  readonly capabilities = ["subtitles", "vector", "frame-by-frame"] as const;
  private readonly cancelled = new Set<Id>();

  validate = validateRenderRequest;

  async renderFrame(request: RenderRequest, timeMs: number): Promise<FrameData> {
    const visible = visibleClipsAt(request, timeMs);
    const summary = visible
      .map((clip) => `${clip.id}@${clip.startMs}-${clip.endMs}:${String(clip.data.text ?? "")}`)
      .sort()
      .join("|");
    const frame = evaluateFrame(request.document, timeMs, request.width, request.height);
    return {
      timeMs,
      width: request.width,
      height: request.height,
      checksum: checksumOf(
        `${request.requestId}|${timeMs}|${durationOf(request.document)}|${summary}|${fingerprintFrame(frame)}`,
      ),
    };
  }

  async renderRange(
    request: RenderRequest,
    onProgress?: (progress: RenderProgress) => void,
  ): Promise<RenderResult> {
    const started = Date.now();
    const error = this.validate(request);
    if (error) {
      return { requestId: request.requestId, ok: false, frames: 0, elapsedMs: Date.now() - started, error };
    }

    const totalFrames = Math.max(
      1,
      Math.round(((request.toMs - request.fromMs) * request.fps) / 1000),
    );
    let rendered = 0;
    for (let i = 0; i < totalFrames; i += 1) {
      if (this.cancelled.has(request.requestId)) {
        this.cancelled.delete(request.requestId);
        return {
          requestId: request.requestId,
          ok: false,
          frames: rendered,
          elapsedMs: Date.now() - started,
          error: "已取消",
        };
      }
      await this.renderFrame(request, request.fromMs + (i * 1000) / request.fps);
      rendered += 1;
      onProgress?.({
        requestId: request.requestId,
        stage: "rendering",
        renderedFrames: rendered,
        totalFrames,
        done: rendered === totalFrames,
      });
    }
    return {
      requestId: request.requestId,
      ok: true,
      frames: rendered,
      elapsedMs: Date.now() - started,
      output: request.output,
    };
  }

  cancel(requestId: Id): void {
    this.cancelled.add(requestId);
  }
}

/** 首阶段实现：程序化帧求值。将来视频轨 / 调色 / 美颜各挂自己的 RenderProvider，上层零改动 */
export function createFrameRenderProvider(): RenderProvider {
  return new FrameRenderProvider();
}

export const frameRenderProvider = createFrameRenderProvider();
