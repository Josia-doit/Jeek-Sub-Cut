import type { Command, JeekModule, ProjectDocument } from "@jeek/contracts";
import { makeCommand } from "@jeek/core";
import { applyRotationPlan, insertClip, quantizeMs, wordWeight } from "@jeek/core";

export interface AddSubtitleOptions {
  trackId: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** 一条可撤销命令：时间量化到帧，写操作返回新文档 */
export function addSubtitleCommand(
  doc: ProjectDocument,
  options: AddSubtitleOptions,
): Command {
  const after = insertClip(doc, options.trackId, {
    kind: "subtitle",
    startMs: options.startMs,
    endMs: options.endMs,
    data: {
      text: options.text,
      fontSize: Number(doc.settings.fontSize ?? 96),
      color: String(doc.settings.fontColor ?? "#ffffff"),
      motion: String(doc.settings.motion ?? "up"),
      durationLocked: false,
    },
  });
  return makeCommand("添加字幕", doc, applyRotationPlan(after));
}

/** 按字数给一条字幕算默认时长：中英混排不会被 ASCII 长度带偏 */
export function durationForText(text: string, baseMs = 1600): number {
  return Math.max(600, Math.min(6000, (wordWeight(text) / 8) * baseMs));
}

/** 批量导入：逐条按字数分配时长，头尾衔接 */
export function importSubtitlesCommand(
  doc: ProjectDocument,
  trackId: string,
  lines: string[],
  startMs = 0,
): Command {
  let after = doc;
  let cursor = quantizeMs(startMs, doc.video.fps);
  for (const text of lines.filter((t) => t.trim())) {
    const span = durationForText(text);
    after = insertClip(after, trackId, {
      kind: "subtitle",
      startMs: cursor,
      endMs: cursor + span,
      data: { text: text.trim(), fontSize: Number(doc.settings.fontSize ?? 96), color: String(doc.settings.fontColor ?? "#ffffff") },
    });
    cursor += span;
  }
  return makeCommand("导入字幕", doc, applyRotationPlan(after));
}

/** 字幕模块：注册面板、检查器、工具、设置与导出格式 */
export const subtitlesModule: JeekModule = {
  id: "feature.subtitles",
  name: "字幕",
  version: "0.1.0",
  activate(ctx) {
    ctx.register({
      id: "panel.subtitle-list",
      kind: "panels",
      payload: { region: "right", title: "字幕列表", component: "subtitleList", order: 10 },
    });
    ctx.register({
      id: "panel.inspector",
      kind: "panels",
      payload: { region: "right", title: "属性", component: "inspector", order: 30 },
    });
    ctx.register({
      id: "inspector.subtitle",
      kind: "inspectors",
      payload: { clipKind: "subtitle", fields: ["text", "startMs", "endMs", "fontSize", "color", "motion"] },
    });
    ctx.register({
      id: "command.add-subtitle",
      kind: "commands",
      payload: { name: "subtitle.add", label: "添加字幕", shortcut: "Ctrl+T" },
    });
    ctx.register({
      id: "settings.fontSize",
      kind: "settings",
      payload: { key: "fontSize", label: "字号", type: "range", min: 40, max: 220, step: 2, defaultValue: 96, group: "字幕" },
    });
    ctx.register({
      id: "settings.maxChars",
      kind: "settings",
      payload: { key: "maxChars", label: "每行显示字数", type: "range", min: 4, max: 30, step: 1, defaultValue: 14, group: "字幕" },
    });
  },
};
