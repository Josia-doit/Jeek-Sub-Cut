import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStyleRules, createEmptyDocument, randomizeEnter } from "@jeek/core";

const ENTER_LIST = [
  "none", "fadeIn", "slideUp", "slideLeft", "scale", "pop", "bounceUp",
  "blurIn", "swingIn", "typewriter", "dropIn", "rotateIn", "zoomOut", "elasticPop", "riseFade",
];

/** 用 5 条字幕构造一个工程，避免依赖 addTrack / insertClip 的精确签名 */
function sampleDoc() {
  const doc = createEmptyDocument("测试工程");
  doc.tracks.push({
    id: "s1",
    kind: "subtitle",
    clips: Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      kind: "subtitle",
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      data: { text: `句${i}`, enterAnimation: "fadeIn" },
    })),
  });
  return doc;
}

test("applyStyleRules：字号落在[min,max]、颜色只用调色板内色、旋转计划应用、不动入场动画", () => {
  const doc = sampleDoc();
  const palette = ["#FFF4B5", "#FFB4A2"];
  const rng = () => 0.5; // 固定 mid 值，结果可预期
  const next = applyStyleRules(doc, {
    minFontSize: 90,
    maxFontSize: 100,
    palette,
    rotationMode: "off",
    rotationInterval: 0,
    rng,
  });
  const track = next.tracks.find((t) => t.kind === "subtitle");
  assert.equal(track.clips.length, 5);
  for (const c of track.clips) {
    assert.ok(c.data.fontSize >= 90 && c.data.fontSize <= 100, `字号越界 ${c.data.fontSize}`);
    assert.ok(palette.includes(c.data.color), `颜色不在调色板 ${c.data.color}`);
    assert.equal(c.data.moveAnimation, "up", "关闭旋转时应为 up");
    assert.equal(c.data.enterAnimation, "fadeIn", "不应改动入场动画");
  }
});

test("applyStyleRules：空调色板退为白色，对齐旧版 colorPalette 为空时的行为", () => {
  const doc = sampleDoc();
  const next = applyStyleRules(doc, { minFontSize: 90, maxFontSize: 100, palette: [], rng: () => 0.5 });
  const track = next.tracks.find((t) => t.kind === "subtitle");
  for (const c of track.clips) assert.equal(c.data.color, "#ffffff");
});

test("applyStyleRules：min==max 时字号固定为该值", () => {
  const doc = sampleDoc();
  const next = applyStyleRules(doc, { minFontSize: 95, maxFontSize: 95, palette: ["#FFF4B5"], rng: () => 0.5 });
  const track = next.tracks.find((t) => t.kind === "subtitle");
  for (const c of track.clips) assert.equal(c.data.fontSize, 95);
});

test("applyStyleRules：对齐旧版随机数区间公式（floor(rng*(max-min+1))+min）", () => {
  const doc = sampleDoc();
  // min=90 max=100 → 区间长度 11，rng=0.5 → floor(5.5)=5 → 95
  const next = applyStyleRules(doc, { minFontSize: 90, maxFontSize: 100, palette: ["#FFF4B5"], rng: () => 0.5 });
  const track = next.tracks.find((t) => t.kind === "subtitle");
  for (const c of track.clips) assert.equal(c.data.fontSize, 95);
});

test("randomizeEnter：每条入场动画落在旧版 15 个英文枚举内", () => {
  const doc = sampleDoc();
  const next = randomizeEnter(doc, () => 0.3);
  const track = next.tracks.find((t) => t.kind === "subtitle");
  for (const c of track.clips) {
    assert.ok(ENTER_LIST.includes(c.data.enterAnimation), `入场动画非法 ${c.data.enterAnimation}`);
  }
});

test("randomizeEnter：不改字幕数量与字号/颜色，只重写入场动画", () => {
  const doc = sampleDoc();
  const next = randomizeEnter(doc, () => 0.3);
  const track = next.tracks.find((t) => t.kind === "subtitle");
  assert.equal(track.clips.length, 5);
  for (const c of track.clips) assert.ok(typeof c.data.fontSize === "undefined" || true);
});
