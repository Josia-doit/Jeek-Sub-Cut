import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyDocument,
  addTrack,
  insertClip,
  applyGlobalEnter,
  patchClip,
} from "../packages/core/dist/index.js";
import { migrate } from "../packages/core/dist/index.js";
import { evaluateFrame } from "../packages/engine/dist/index.js";

/** 造一个带 N 条字幕的工程，返回 { doc, ids } */
function makeDocWithSubtitles(texts) {
  let doc = createEmptyDocument("t");
  doc = addTrack(doc, "subtitle", "字幕轨");
  const trackId = doc.tracks.find((t) => t.kind === "subtitle").id;
  let at = 0;
  const ids = [];
  for (const text of texts) {
    doc = insertClip(doc, trackId, {
      kind: "subtitle",
      startMs: at,
      endMs: at + 1000,
      data: { text, fontSize: 60 },
    });
    ids.push(doc.tracks[0].clips[doc.tracks[0].clips.length - 1].id);
    at += 1000;
  }
  return { doc, ids };
}

test("全局动画：applyGlobalEnter 把设置与每条字幕统一成同一个值", () => {
  const { doc, ids } = makeDocWithSubtitles(["一", "二", "三"]);
  // 预置各条不同的入场动画，模拟列表里单条改过的状态
  let next = patchClip(doc, ids[0], { enterAnimation: "淡入" });
  next = patchClip(next, ids[2], { enterAnimation: "落下" });

  const unified = applyGlobalEnter(next, "弹跳上浮");
  assert.equal(unified.settings.enterAnimation, "弹跳上浮");
  for (const clip of unified.tracks[0].clips) {
    assert.equal(clip.data.enterAnimation, "弹跳上浮");
  }
  // 原文档不被修改（不可变更新）
  assert.equal(next.tracks[0].clips[0].data.enterAnimation, "淡入");
});

test("单条动画：字幕自己的 enterAnimation 优先于全局值（列表单条修改立即生效）", () => {
  let { doc, ids } = makeDocWithSubtitles(["一", "二"]);
  doc = applyGlobalEnter(doc, "打字机");
  // 单独把第二条改成「淡入」
  doc = patchClip(doc, ids[1], { enterAnimation: "淡入" });

  // 播放头落在第二条：求值出的 fx 应该是淡入而不是全局打字机
  const frame = evaluateFrame(doc, 1500, 1920, 1080);
  assert.equal(frame.settings.enterFx, "typewriter"); // 全局值保持打字机
  const current = frame.layers.find((l) => l.isCurrent);
  assert.ok(current, "当前帧有当前句图层");
  // 淡入在入场窗口内表现为透明度渐变，打字机是逐字露出；用 visibleChars 区分两种动效
  assert.ok(
    current.visibleChars === Infinity,
    "第二条按「淡入」渲染（不逐字露出），而不是全局的打字机",
  );
});

test("载入工程：重复 / 空的片段 id 会被重新分配，不再互相串改", () => {
  const raw = {
    schemaVersion: 1,
    name: "脏数据工程",
    video: { width: 2560, height: 1440, fps: 30 },
    tracks: [
      {
        id: "track_a",
        kind: "subtitle",
        name: "字幕轨",
        clips: [
          { id: "dup", trackId: "track_a", kind: "subtitle", startMs: 0, endMs: 1000, data: { text: "第一条" } },
          { id: "dup", trackId: "track_a", kind: "subtitle", startMs: 1000, endMs: 2000, data: { text: "第二条" } },
          { id: "", trackId: "track_a", kind: "subtitle", startMs: 2000, endMs: 3000, data: { text: "第三条" } },
        ],
      },
    ],
    selection: { clips: [], tracks: [] },
    settings: {},
  };
  const doc = migrate(raw);
  const clips = doc.tracks[0].clips;
  const ids = new Set(clips.map((c) => c.id));
  assert.equal(ids.size, 3, `三条字幕 id 应互不相同，实际：${clips.map((c) => c.id).join(", ")}`);
  for (const clip of clips) assert.ok(clip.id, "id 非空");

  // 对「第二条」做 patch 只影响第二条
  const target = clips[1].id;
  const patched = patchClip(doc, target, { fontSize: 88 });
  const after = patched.tracks[0].clips;
  assert.equal(after[1].data.fontSize, 88, "第二条字号被更新");
  assert.equal(after[0].data.fontSize, undefined, "第一条字号不受影响");
  assert.equal(after[2].data.fontSize, undefined, "第三条字号不受影响");
});

test("载入工程：重复的轨道 id 会去重，片段 trackId 引用同步修正", () => {
  const raw = {
    schemaVersion: 1,
    name: "脏轨道",
    video: { width: 2560, height: 1440, fps: 30 },
    tracks: [
      { id: "same", kind: "subtitle", name: "字幕轨", clips: [] },
      { id: "same", kind: "audio", name: "音频轨", clips: [] },
    ],
    selection: { clips: [], tracks: [] },
    settings: {},
  };
  const doc = migrate(raw);
  const trackIds = new Set(doc.tracks.map((t) => t.id));
  assert.equal(trackIds.size, 2, `轨道 id 应互不相同，实际：${doc.tracks.map((t) => t.id).join(", ")}`);
  for (const track of doc.tracks) {
    for (const clip of track.clips) assert.equal(clip.trackId, track.id);
  }
});

test("水平位置对称：左对齐字幕的左边距 = 右对齐字幕的右边距", () => {
  const { doc, ids } = makeDocWithSubtitles(["第一条", "第二条"]);
  // 第一条设为右旋（clockwise90）：按对齐规则，第二条及其之后全部右对齐
  const rotated = patchClip(doc, ids[0], { moveAnimation: "clockwise90" });

  const W = 2560;
  const H = 1440;
  // 播放头落在第一条（左对齐）：文字左缘 = W * subtitleX%
  const leftFrame = evaluateFrame(rotated, 500, W, H);
  const leftLayer = leftFrame.layers.find((l) => l.isCurrent);
  assert.equal(leftLayer.align, "left");
  assert.equal(leftFrame.anchor.left, W * 0.3, "默认水平位置 30%");

  // 播放头落在第二条（右对齐）：文字右缘 = W - W * subtitleX%（与左边距对称）
  const rightFrame = evaluateFrame(rotated, 1500, W, H);
  const rightLayer = rightFrame.layers.find((l) => l.isCurrent);
  assert.equal(rightLayer.align, "right");
  // layer.x 是右缘在容器内的坐标：anchor.left + x 应等于 W - anchor.left
  const rightEdge = leftFrame.anchor.left + rightLayer.x;
  assert.equal(
    Math.round(rightEdge),
    W - W * 0.3,
    `右对齐文字右缘应落在 ${W - W * 0.3}（与左边距对称），实际 ${rightEdge}`,
  );
});
