import { test } from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createEmptyDocument } from "@jeek/core";
import { evaluateFrame, getSpringProgress } from "@jeek/engine";

/** 构建字幕文档：可指定帧率、字幕区间、动效（默认入场与移动都关掉，隔离换算逻辑） */
const makeDoc = (fps, clips, overrides = {}) => {
  let doc = { ...createEmptyDocument("帧求值基线"), video: { width: 2560, height: 1440, fps } };
  doc = addTrack(doc, "subtitle", "字幕轨");
  for (const c of clips) {
    doc = addClip(doc, doc.tracks[0].id, {
      kind: "subtitle", startMs: c[0], endMs: c[1], data: { text: c[2] ?? "字" },
    });
  }
  doc = {
    ...doc,
    settings: { ...doc.settings, motion: "none", enterAnimation: "无", ...overrides },
  };
  return doc;
};

/** 取一条字幕的「位移」字段（不含 enter 进度本身） */
const displacement = (layer) => ({
  depth: layer.depth,
  opacity: layer.opacity,
  scale: layer.scale,
  dx: layer.dx,
  dy: layer.dy,
  rotation: layer.rotation,
  blur: layer.blur,
});

test("帧求值：30fps 与 60fps 下同一全局帧的层数与位移一致（隔离换算）", () => {
  // 两条短字幕，保证第 6 帧（30fps=200ms、60fps=100ms）时两条都已开始；
  // 入场与移动关闭，使位移不依赖 enter 进度，纯粹验证「时间→帧 + 堆叠几何」的帧率无关性。
  const clips = [[0, 80, "第一句"], [80, 160, "第二句"]];
  const f30 = evaluateFrame(makeDoc(30, clips), (6 * 1000) / 30);
  const f60 = evaluateFrame(makeDoc(60, clips), (6 * 1000) / 60);

  assert.equal(f30.layers.length, f60.layers.length, "层数一致");
  assert.equal(f30.layers.length, 2, "两条都可见（第二句当前 + 第一句历史）");
  for (let i = 0; i < f30.layers.length; i += 1) {
    assert.deepEqual(
      displacement(f30.layers[i]),
      displacement(f60.layers[i]),
      `第 ${i} 层位移一致`,
    );
  }
});

test("帧求值：入场完成后（两帧率都越过 0.2s 窗口）位移一致", () => {
  // 2000ms：30fps 第 60 帧、60fps 第 120 帧，第二条字幕入场早已完成
  const clips = [[0, 1000, "第一句"], [1000, 2000, "第二句"]];
  const f30 = evaluateFrame(makeDoc(30, clips, { enterAnimation: "淡入" }), 2000);
  const f60 = evaluateFrame(makeDoc(60, clips, { enterAnimation: "淡入" }), 2000);
  assert.equal(f30.layers[0].opacity, 1, "30fps 入场完成");
  assert.equal(f60.layers[0].opacity, 1, "60fps 入场完成");
  assert.deepEqual(displacement(f30.layers[0]), displacement(f60.layers[0]));
  assert.equal(f30.layers.length, f60.layers.length);
});

test("帧求值：播放头落在两条字幕之间，按旧版『最后开始的即当前句』显示", () => {
  // 真正留间隙：[0,1000] 与 [2000,3000]，1500ms 落在间隙里
  const clips = [[0, 1000, "第一句"], [2000, 3000, "第二句"]];
  const gap = evaluateFrame(makeDoc(30, clips), 1500);
  assert.equal(gap.currentIndex, 0, "间隙里仍显示第一句（旧版语义，不回退、不熄火）");
  assert.equal(gap.layers.length, 1, "旧版规定层数：仅当前句本身");
  assert.equal(gap.layers[0].text, "第一句");
  assert.equal(gap.layers[0].opacity, 1, "早已入场完成，满显");

  // 所有字幕都结束之后：最后一句仍是当前句，前面都变成历史层
  const tail = evaluateFrame(makeDoc(30, clips), 5000);
  assert.equal(tail.currentIndex, 1, "最后一句为当前句");
  assert.equal(tail.layers.length, 2, "两条都可见（当前 + 历史）");
});

test("帧求值：播放头在首句之前，画面干净无层", () => {
  const doc = makeDoc(30, [[0, 1000, "第一句"]]);
  const before = evaluateFrame(doc, -10);
  assert.equal(before.currentIndex, -1);
  assert.equal(before.layers.length, 0);
});

test("spring：第 0 帧进度为 0、单调上升、越过窗口后归 1", () => {
  assert.equal(getSpringProgress(0, 30, 0.2), 0);
  assert.equal(getSpringProgress(0, 60, 0.2), 0);

  let prev = -1;
  for (let f = 1; f <= 12; f += 1) {
    const v = getSpringProgress(f, 30, 0.2);
    assert.ok(v >= prev - 1e-9, `第 ${f} 帧进度应单调不减`);
    prev = v;
  }
  // 越过 0.2s 窗口（30fps → 6 帧）后归 1；窗口边界帧（第 6 帧）为 ~0.996
  assert.ok(getSpringProgress(6, 30, 0.2) > 0.99, "边界帧接近 1");
  assert.equal(getSpringProgress(7, 30, 0.2), 1);
  assert.equal(getSpringProgress(20, 30, 0.2), 1);
  assert.equal(getSpringProgress(20, 60, 0.2), 1);
});
