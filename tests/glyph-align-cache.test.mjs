import { test } from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createEmptyDocument } from "@jeek/core";
import { paintFrame, clearMeasureTextCache } from "@jeek/engine";

/**
 * 字形位图缓存的 key 必须含对齐方向：外观相同、一左一右两条 settled 层
 * 若共用一张位图，右对齐那条会按别人的左缘锚点贴回，整句右移一个文字宽度。
 * 本测试 mock 出 document/canvas 让位图缓存真正生效（node 默认无 document 会走全矢量路径）。
 */

function fakeCtx(canvas, record) {
  return {
    font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "",
    lineWidth: 1, globalAlpha: 1, filter: "", shadowColor: "", shadowBlur: 0, shadowOffsetY: 0,
    lineJoin: "", miterLimit: 0,
    save() {}, restore() {}, clearRect() {}, fillRect() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeText() {},
    measureText(text) {
      const size = Number((String(this.font).match(/([\d.]+)px/)?.[1]) || 60);
      return { width: [...text].length * size * 0.9 };
    },
    fillText(text) { canvas.__txt = text; },
    drawImage(img, dx, dy, dw, dh) { if (record) record.push({ text: img.__txt, dx }); },
  };
}
function fakeCanvas(record) {
  const c = { width: 0, height: 0, __txt: "" };
  c.getContext = () => fakeCtx(c, record);
  return c;
}

function makeDoc() {
  let doc = { ...createEmptyDocument("对齐缓存"), video: { width: 1920, height: 1080, fps: 30 } };
  doc = addTrack(doc, "subtitle", "字幕轨");
  // 旋转句夹在中间，使前后两条外观完全相同的字幕落在不同对齐：
  // index1 在 clockwise90 之后 => right；index3 在 counterclockwise90 之后 => left
  const lines = [
    ["转甲", 0, 900, "clockwise90"],
    ["同样的话", 900, 1700, "up"],
    ["转乙", 1700, 2500, "counterclockwise90"],
    ["同样的话", 2500, 3300, "up"],
    ["当前句", 3300, 4300, "up"],
  ];
  for (const [text, s, e, mv] of lines) {
    doc = addClip(doc, doc.tracks[0].id, {
      kind: "subtitle", startMs: s, endMs: e,
      data: { text, fontSize: 60, color: "#FF0000", moveAnimation: mv },
    });
  }
  return { ...doc, settings: { ...doc.settings, subtitleStyle: "custom", subtitleX: 30, subtitleY: 40, enterAnimation: "无", enterDurationMs: 200 } };
}

test("字形位图缓存 key 含对齐：外观相同、一左一右两条层不共用位图", () => {
  // 先清缓存，再装 document，确保位图缓存在本测试里首次生效
  clearMeasureTextCache();
  const probe = fakeCanvas(null);
  let first = true;
  globalThis.document = {
    createElement() { if (first) { first = false; return probe; } return fakeCanvas(null); },
  };
  try {
    const doc = makeDoc();
    const drawn = [];
    const ctx = fakeCtx({ width: 1920, height: 1080 }, drawn);
    const before = globalThis.__JEEK_GLYPH_STATS__?.misses ?? 0;
    paintFrame(ctx, doc, 3600, 1920, 1080);
    const after = globalThis.__JEEK_GLYPH_STATS__?.misses ?? 0;

    // 4 条走位图的 settled 层：同样的话(右)、同样的话(左)、当前句、转乙。
    // 对齐入 key 后「同样的话」两条各建一张 => 共 4 次 miss；
    // 若没入 key，两条共用一张 => 只有 3 次 miss。
    assert.equal(after - before, 4, "一左一右两条同外观层必须各建一张位图");

    const same = drawn.filter((d) => d.text === "同样的话");
    assert.equal(same.length, 2, "两条「同样的话」都应绘制");
    const leftDx = Math.min(...same.map((d) => d.dx));
    const rightDx = Math.max(...same.map((d) => d.dx));
    // 右对齐那条不能被左对齐位图带偏：两条 dx 应恰好相差一个锚点跨度（textWidth），
    // 而不是 0（0 意味着两条贴到了同一个左缘锚点 = 串位）。
    assert.ok(Math.abs(rightDx - leftDx) > 100, "右对齐层不应贴到左对齐锚点");
  } finally {
    delete globalThis.document;
  }
});
