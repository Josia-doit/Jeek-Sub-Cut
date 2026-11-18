import type { JeekModule } from "@jeek/contracts";

/** 时间轴模块：注册轨道类型、面板、工具与命令；不认识任何其它功能模块 */
export const timelineModule: JeekModule = {
  id: "feature.timeline",
  name: "时间轴",
  version: "0.1.0",
  activate(ctx) {
    for (const t of [
      { id: "track.subtitle", type: "subtitle", label: "字幕轨", clipKind: "subtitle" },
      { id: "track.audio", type: "audio", label: "音频轨", clipKind: "audio", waveform: true },
    ]) {
      ctx.register({ id: t.id, kind: "trackTypes", payload: t });
    }

    ctx.register({
      id: "panel.timeline",
      kind: "panels",
      payload: { region: "bottom", title: "时间轴", component: "timeline", resizable: true, order: 10 },
    });

    const tools = [
      { id: "tool.split", label: "切分", shortcut: "Ctrl+B", command: "clip.split", group: "edit", hint: "在播放头切开字幕与音频，默认选中后半段" },
      { id: "tool.insert", label: "插入字幕", shortcut: "Ctrl+T", command: "subtitle.insert", group: "edit", hint: "在播放头后插入一条字幕" },
      { id: "tool.delete", label: "删除", shortcut: "Delete", command: "clip.delete", group: "edit", hint: "删除选中的卡片" },
      { id: "tool.merge", label: "并句", shortcut: "Ctrl+M", command: "subtitle.merge", group: "edit", hint: "合并选中的字幕" },
      { id: "tool.fill", label: "自动填充", command: "timeline.fill", group: "edit", hint: "自动填满字幕之间的空隙" },
      { id: "tool.remove-gaps", label: "消除缝隙", command: "timeline.removeGaps", group: "edit", hint: "字幕与音频一起向前贴合" },
      { id: "tool.fit", label: "⇲ 适配", command: "timeline.fit", group: "zoom", hint: "按当前总时长铺满可视区" },
      { id: "tool.zoom-out", label: "－", command: "timeline.zoomOut", group: "zoom" },
      { id: "tool.zoom-in", label: "＋", command: "timeline.zoomIn", group: "zoom" },
    ];
    for (const t of tools) ctx.register({ id: t.id, kind: "tools", payload: t });

    for (const name of [
      "clip.split", "clip.delete", "clip.move", "clip.trim", "subtitle.insert",
      "subtitle.merge", "timeline.fit", "timeline.fill", "timeline.removeGaps",
    ]) {
      ctx.register({ id: `command.${name}`, kind: "commands", payload: { name, label: name } });
    }

    ctx.register({
      id: "settings.snap",
      kind: "settings",
      payload: { key: "snapEnabled", label: "自动吸附", type: "boolean", defaultValue: true, group: "时间轴" },
    });
    ctx.register({
      id: "settings.fps",
      kind: "settings",
      payload: { key: "fps", label: "帧率", type: "select", options: [24, 25, 30, 60], group: "工程" },
    });
  },
  deactivate() {
    // 贡献点由注册表在 drop() 时统一注销
  },
};
