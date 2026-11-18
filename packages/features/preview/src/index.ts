import type { JeekModule } from "@jeek/contracts";

/** 预览模块：画面、动效、堆叠与旋转的贡献点 */
export const previewModule: JeekModule = {
  id: "feature.preview",
  name: "画面预览",
  version: "0.1.0",
  activate(ctx) {
    ctx.register({
      id: "panel.preview",
      kind: "panels",
      payload: { region: "center", title: "预览", component: "preview", order: 10 },
    });
    for (const t of [
      { id: "tool.play", label: "▶ 播放", shortcut: "Space", command: "preview.toggle", group: "playback" },
      { id: "tool.prev", label: "｜◀ 上一句", shortcut: "↑", command: "preview.prev", group: "playback" },
      { id: "tool.next", label: "▶｜ 下一句", shortcut: "↓", command: "preview.next", group: "playback" },
      { id: "tool.head", label: "⏮ 回到开头", shortcut: "Home", command: "preview.home", group: "playback" },
    ]) {
      ctx.register({ id: t.id, kind: "tools", payload: t });
    }
    for (const [key, label, type, options] of [
      ["motion", "入场动效", "select", ["fade", "up", "left", "zoom", "pop", "bounceUp", "blur", "swing", "typewriter", "fall", "rotateIn", "none"]],
      ["rotationMode", "旋转方式", "select", ["off", "clockwise", "counter", "alternate", "random", "interval"]],
      ["stackLimit", "堆叠层数", "range", null],
      ["background", "背景", "select", ["solid", "image", "transparent"]],
      ["aspect", "画布比例", "select", ["landscape", "portrait", "square", "wide"]],
    ] as const) {
      ctx.register({
        id: `settings.${key}`,
        kind: "settings",
        payload: { key, label, type, options, group: "画面与动效" },
      });
    }
    ctx.register({
      id: "settings.rotationInterval",
      kind: "settings",
      payload: { key: "rotationInterval", label: "旋转间隔（条）", type: "range", min: 1, max: 8, step: 1, defaultValue: 2, group: "画面与动效" },
    });
    ctx.register({
      id: "settings.rotationSkipLast",
      kind: "settings",
      payload: { key: "rotationSkipLast", label: "最后一条不插旋转", type: "boolean", defaultValue: true, group: "画面与动效" },
    });
    ctx.register({
      id: "effects.motions",
      kind: "effects",
      payload: { group: "motion", values: ["fade", "up", "left", "zoom", "pop", "bounceUp", "blur", "swing", "typewriter", "fall", "rotateIn", "none"] },
    });
  },
};
