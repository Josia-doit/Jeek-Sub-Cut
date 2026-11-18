import type { JeekModule } from "@jeek/contracts";

/** 导出模块：导出面板与三种成品（视频、字幕、工程） */
export const exportModule: JeekModule = {
  id: "feature.export",
  name: "导出",
  version: "0.1.0",
  activate(ctx) {
    ctx.register({
      id: "panel.export",
      kind: "panels",
      payload: { region: "overlay", title: "导出", component: "export", order: 40 },
    });
    ctx.register({
      id: "tool.export",
      kind: "tools",
      payload: { id: "tool.export", label: "⬇ 导出", command: "export.open", group: "file", hint: "按当前参数导出成片" },
    });
    for (const e of [
      { id: "exporter.mp4", format: "mp4", label: "导出视频 (MP4)", command: "export.open" },
      { id: "exporter.srt", format: "srt", label: "导出字幕 (SRT)", command: "export.srt" },
      { id: "exporter.project", format: "project", label: "保存工程 (.jeek)", command: "export.project" },
    ]) {
      ctx.register({ id: e.id, kind: "exporters", payload: e });
    }
  },
};
