import type { JeekModule } from "@jeek/contracts";

export {
  buildSubtitles,
  cleanSegment,
  displayLen,
  parseSrt,
  segmentText,
} from "./asr-split.js";
export type { BuildOptions, SrtEntry, SubtitlePiece } from "./asr-split.js";

/** 语音转字幕模块：三阶段整屏窗口、分句与设置随工程存取 */
export const asrModule: JeekModule = {
  id: "feature.asr",
  name: "语音转字幕",
  version: "0.1.0",
  activate(ctx) {
    ctx.register({
      id: "panel.asr",
      kind: "panels",
      payload: { region: "overlay", title: "语音转字幕", component: "asr", order: 30 },
    });
    ctx.register({
      id: "tool.asr",
      kind: "tools",
      payload: { id: "tool.asr", label: "🗣 语音转字幕", shortcut: "Ctrl+Shift+A", command: "asr.open", group: "media", hint: "识别时间轴实际音轨并生成字幕" },
    });
    ctx.register({
      id: "settings.asr.maxChars",
      kind: "settings",
      payload: { key: "asrMaxChars", label: "单句最多字数", type: "range", min: 8, max: 24, step: 1, defaultValue: 14, group: "语音识别" },
    });
    ctx.register({
      id: "settings.asr.maxMs",
      kind: "settings",
      payload: { key: "asrMaxMs", label: "单句最长时长", type: "range", min: 2, max: 8, step: 0.5, defaultValue: 4.5, group: "语音识别" },
    });
    ctx.register({
      id: "settings.asr.vadMaxSeg",
      kind: "settings",
      payload: { key: "asrVadMaxSeg", label: "语音分段长度", type: "range", min: 4, max: 15, step: 1, defaultValue: 8, group: "语音识别" },
    });
    ctx.register({
      id: "settings.asr.backend",
      kind: "settings",
      payload: { key: "asrBackend", label: "计算后端", type: "select", options: ["vulkan", "cpu"], defaultValue: "vulkan", group: "语音识别" },
    });
  },
};
