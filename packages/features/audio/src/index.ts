import type { JeekModule } from "@jeek/contracts";

/** 音频模块：音频轨、波形、录音与混音的贡献点 */
export const audioModule: JeekModule = {
  id: "feature.audio",
  name: "音频与录音",
  version: "0.1.0",
  activate(ctx) {
    ctx.register({
      id: "panel.audio",
      kind: "panels",
      payload: { region: "right", title: "音频", component: "audio", order: 20 },
    });
    const tools = [
      { id: "tool.import-audio", label: "♪ 导入音频", shortcut: "Ctrl+O", command: "audio.import", group: "media", hint: "选择本地音频文件并铺到音频轨" },
      { id: "tool.record", label: "● 录音", shortcut: "R", command: "audio.record", group: "media", hint: "开始/结束录音，自动追加到音轨末尾" },
      { id: "tool.close-audio", label: "✕ 关闭音频", command: "audio.close", group: "media", hint: "移除音频并清空音轨，之后的录音不会拼接旧音频" },
      { id: "tool.sort-audio", label: "自动排序", command: "audio.sort", group: "edit", hint: "音频片段按时间首尾相接" },
    ];
    for (const t of tools) ctx.register({ id: t.id, kind: "tools", payload: t });
    ctx.register({
      id: "inspector.audio",
      kind: "inspectors",
      payload: { clipKind: "audio", fields: ["inMs", "startMs", "endMs", "gain"] },
    });
    ctx.register({
      id: "settings.audio",
      kind: "settings",
      payload: { key: "masterGain", label: "总音量", type: "range", min: 0, max: 2, step: 0.05, defaultValue: 1, group: "音频" },
    });
  },
};
