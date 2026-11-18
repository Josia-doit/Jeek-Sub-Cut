import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTrack,
  createEmptyDocument,
  dragBounds,
  fillGaps,
  insertClip,
  moveClips,
  quantizeMs,
  splitClip,
  splitAllAt,
  snapShift,
  snapTime,
  sortTrack,
  TIMELINE_FLOOR_MS,
  timelineTotal,
  trimClip,
} from "@jeek/core";

/** 时间轴行为基线：字幕轨 + 音频轨，时间都能被 30/60fps 帧长整除 */
const makeDoc = (subs = [], audios = [], fps = 30) => {
  let doc = createEmptyDocument("时间轴基线");
  doc = { ...doc, video: { ...doc.video, fps } };
  doc = addTrack(doc, "subtitle", "字幕轨");
  doc = addTrack(doc, "audio", "音频轨");
  const subId = doc.tracks[0].id;
  const audioId = doc.tracks[1].id;
  subs.forEach(([startMs, endMs], i) => {
    doc = insertClip(doc, subId, { kind: "subtitle", startMs, endMs, data: { text: `句${i + 1}` } });
  });
  audios.forEach(([startMs, endMs]) => {
    doc = insertClip(doc, audioId, { kind: "audio", startMs, endMs, data: {} });
  });
  return doc;
};

const pairs = (doc, kind) => doc.tracks
  .find((t) => t.kind === kind).clips
  .slice().sort((a, b) => a.startMs - b.startMs)
  .map((c) => [c.startMs, c.endMs]);

test("时间轴总长：空轨 5 秒，无音频末尾 +2 秒，有音频按末尾 8% 留 3~15 秒", () => {
  assert.equal(TIMELINE_FLOOR_MS, 5000);
  assert.equal(timelineTotal(makeDoc()), 5000);
  assert.equal(timelineTotal(makeDoc([[0, 10000]])), 12000);
  assert.equal(timelineTotal(makeDoc([[0, 10000]], [[0, 10000]])), 13000);
  assert.equal(timelineTotal(makeDoc([[0, 200000]], [[0, 200000]])), 215000);
});

test("整体平移边界：不许推出 0 点，也不许压到未移动卡片", () => {
  const doc = makeDoc([[0, 1000], [2000, 3000], [4000, 5000]]);
  const ids = doc.tracks[0].clips.map((c) => c.id);
  assert.equal(dragBounds(doc, [ids[0]]).lo, 0, "首条不能向左越过 0 点");
  assert.equal(moveClips(doc, [ids[0]], -3000).applied, 0);

  const group = [ids[1], ids[2]];
  assert.equal(dragBounds(doc, group).lo, -1000, "整组前移量受最靠前的未移动卡片限制");
  const moved = moveClips(doc, group, -5000);
  assert.equal(moved.applied, -1000);
  const result = pairs(moved.doc, "subtitle");
  assert.deepEqual(result, [[0, 1000], [1000, 2000], [3000, 4000]]);
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i][0] >= result[i - 1][1], "相邻卡片不重叠");
  }
});

test("自动填充：只延长右端到下一条起点，不移动卡片、不动音频", () => {
  const doc = makeDoc([[0, 800], [1500, 2200], [3000, 3600]], [[0, 500]]);
  const before = pairs(doc, "audio");
  const filled = fillGaps(doc, doc.tracks[0].id);
  assert.equal(filled.filled, 2);
  assert.deepEqual(pairs(filled.doc, "subtitle"), [[0, 1500], [1500, 3000], [3000, 3600]]);
  assert.deepEqual(pairs(filled.doc, "audio"), before, "音频轨不受影响");
});

test("调整时长：右端不越过下一张卡片，撤销前的相邻边界保持完好", () => {
  const doc = makeDoc([[0, 1000], [1500, 2500]]);
  const [first, second] = doc.tracks[0].clips;
  const trimmed = trimClip(doc, first.id, "end", 3000);
  const result = pairs(trimmed, "subtitle");
  assert.equal(result[0][1], second.startMs, "拉到下一张卡片起点就被拦住");
  assert.equal(result[1][0], 1500, "相邻卡片没被覆盖");
});

test("音频右端只在「本卡片的源区间」里伸缩：没裁过拉不长，裁过才能拖回来", () => {
  const doc = makeDoc([], [[0, 3000]]);
  const clip = doc.tracks[1].clips[0];
  const longer = trimClip(doc, clip.id, "end", 1500);
  assert.equal(pairs(longer, "audio")[0][1], 3000, "整段没裁过的卡片，右端拉不出新内容");
  const shrink = trimClip(doc, clip.id, "end", -1000);
  assert.equal(pairs(shrink, "audio")[0][1], 2000, "缩短不受源限制");
  const back = trimClip(shrink, clip.id, "end", 1500);
  assert.equal(pairs(back, "audio")[0][1], 3000, "裁掉的那 1 秒能拖回来，但最多回到原来的 3 秒");
});

test("音频左端裁剪后，右端可用时长跟着缩短（inMs 已占掉源开头）", () => {
  const doc = makeDoc([], [[0, 3000]]);
  const clip = doc.tracks[1].clips[0];
  const leftTrimmed = trimClip(doc, clip.id, "start", 1000);
  const after = leftTrimmed.tracks[1].clips[0];
  assert.equal(after.startMs, 1000, "左端裁掉 1 秒");
  assert.equal(after.inMs, 1000, "源内偏移同步推进");
  const again = trimClip(leftTrimmed, clip.id, "end", 2000);
  assert.equal(pairs(again, "audio")[0][1], 3000, "源已用满，右端没有余量");
});

test("相邻音频分界：两张都没裁过时一动不动", () => {
  const doc = makeDoc([], [[0, 3000], [3000, 6000]]);
  const [left, right] = doc.tracks[1].clips;
  assert.deepEqual(
    pairs(trimClip(doc, left.id, "junction", 800, right.id), "audio"),
    [[0, 3000], [3000, 6000]],
    "往右：左卡没有可恢复的源结尾，不许推",
  );
  assert.deepEqual(
    pairs(trimClip(doc, left.id, "junction", -800, right.id), "audio"),
    [[0, 3000], [3000, 6000]],
    "往左：右卡没有可恢复的源开头，也不许推",
  );
});

test("相邻音频分界：各自裁过才能往对应方向恢复，超量拖动被夹住", () => {
  // 一段 6 秒音频从中间切开：左卡源 [0,3000)、右卡源 [3000,6000)
  const doc = makeDoc([], [[0, 6000]]);
  const cut = splitAllAt(doc, 3000);
  const [leftCut, rightCut] = cut.tracks[1].clips;
  // 左卡右端缩 0.5 秒、右卡左端缩 0.5 秒，再把右卡贴回左卡末尾
  const leftShort = trimClip(cut, leftCut.id, "end", -500);
  const rightShort = trimClip(leftShort, rightCut.id, "start", 500);
  const back = moveClips(rightShort, [rightCut.id], -1000).doc;
  const [left, right] = back.tracks[1].clips;
  assert.deepEqual([left.startMs, left.endMs], [0, 2500]);
  assert.deepEqual([right.startMs, right.endMs, right.inMs], [2500, 5000, 3500]);

  // 往右：左卡能恢复 0.5 秒，右卡同步缩短
  const rightward = trimClip(back, left.id, "junction", 5000, right.id);
  const [l1, r1] = rightward.tracks[1].clips;
  assert.deepEqual([l1.endMs, r1.startMs, r1.inMs], [3000, 3000, 4000], "往右最多把左卡被裁掉的 0.5 秒要回来");

  // 往左：右卡能恢复 0.5 秒，左卡同步缩短
  const leftward = trimClip(back, left.id, "junction", -5000, right.id);
  const [l2, r2] = leftward.tracks[1].clips;
  assert.deepEqual([l2.endMs, r2.startMs, r2.inMs], [2000, 2000, 3000], "往左最多把右卡被裁掉的 0.5 秒要回来");
});

test("字幕分界不受音频源长度影响", () => {
  const doc = makeDoc([[0, 1000], [1000, 2000]]);
  const [left, right] = doc.tracks[0].clips;
  const moved = trimClip(doc, left.id, "junction", 400, right.id, 0);
  assert.deepEqual(pairs(moved, "subtitle"), [[0, 1400], [1400, 2000]]);
});

test("自动排序：第一张贴到 0 帧、空隙由后面整段补上，已贴合时返回原文档", () => {
  const doc = makeDoc([], [[500, 1500], [2500, 3500]]);
  const audioId = doc.tracks[1].id;
  const sorted = sortTrack(doc, audioId);
  assert.deepEqual(pairs(sorted, "audio"), [[0, 1000], [1000, 2000]]);
  assert.equal(sortTrack(sorted, audioId), sorted, "无可贴合空隙时不产生新文档");
});

test("自动排序：不强行拉开本来重叠的音频片段", () => {
  const doc = makeDoc([], [[0, 1000], [800, 1800]]);
  assert.equal(sortTrack(doc, doc.tracks[1].id), doc);
});

test("自动排序 + 同步：重叠字幕随音频一起前移", () => {
  const doc = makeDoc([[500, 1500]], [[500, 1500], [2500, 3500]]);
  const sorted = sortTrack(doc, doc.tracks[1].id, true);
  assert.deepEqual(pairs(sorted, "subtitle"), [[0, 1000]]);
  assert.deepEqual(pairs(sorted, "audio"), [[0, 1000], [1000, 2000]]);
});

test("吸附：起点/终点/卡片边缘/播放头，容差至少一帧，skip 排除自身边缘", () => {
  const doc = makeDoc([[1000, 2000]], [], 60);
  assert.equal(snapTime(doc, 10, 500, 9, 1, { totalMs: 5000 }), 0, "靠近 0 点吸到起点");
  assert.equal(snapTime(doc, 4995, 500, 9, 1, { totalMs: 5000 }), 5000, "靠近末尾吸到终点");
  assert.equal(snapTime(doc, 1010, 500, 9, 1, { totalMs: 5000 }), 1000, "吸到卡片边缘");
  assert.equal(
    snapTime(doc, 1010, 500, 9, 1, { totalMs: 5000, skip: [1000] }),
    quantizeMs(1010, 60),
    "裁剪端点不吸回自己原来的位置",
  );
  assert.equal(
    snapTime(doc, 612, 600, 9, 1, { totalMs: 5000, includePlayhead: true }),
    600,
    "拖卡片时把播放头定位帧纳入吸附目标",
  );
  assert.equal(
    snapTime(doc, 612, 600, 9, 1, { totalMs: 5000 }),
    quantizeMs(612, 60),
    "拖标尺时不吸播放头，避免粘滞",
  );
});

test("位移吸附：候选取最近，越界不吸，Alt 临时关闭时只做帧量化", () => {
  const doc = makeDoc([], [], 60);
  assert.equal(snapShift(doc, 105, [100, 500], 9, 1), 100);
  assert.equal(snapShift(doc, 300, [100, 500], 9, 1), quantizeMs(300, 60));
  assert.equal(snapShift(doc, 110, [100], 9, 1, false), quantizeMs(110, 60));
});

/* —— 音频片段模型 {startMs,endMs,inMs}：源内偏移不变量 —— */

test("移动音频块：平移只改 start/end，inMs 保持不变（源内偏移不随拖动漂移）", () => {
  const doc = makeDoc([], [[0, 5000]], 30);
  const clip = doc.tracks[1].clips[0];
  const before = clip.inMs;
  const moved = moveClips(doc, [clip.id], 2000);
  const after = moved.doc.tracks[1].clips[0];
  assert.equal(after.inMs, before, "inMs 不变");
  assert.equal(after.startMs, clip.startMs + 2000, "start 平移");
  assert.equal(after.endMs, clip.endMs + 2000, "end 平移");
});

test("裁剪音频左端：start 右移多少，inMs 同步推进多少（源内偏移跟着裁）", () => {
  const doc = makeDoc([], [[0, 5000]], 30);
  const clip = doc.tracks[1].clips[0];
  const trimmed = trimClip(doc, clip.id, "start", 1000);
  const after = trimmed.tracks[1].clips[0];
  assert.equal(after.startMs, 1000);
  assert.equal(after.inMs, 1000, "inMs 同步推进 1000");
});

test("切分音频：后半段 inMs = 原 inMs + (切点 - 原 start)，源内偏移连续", () => {
  const doc = makeDoc([], [[1000, 5000]], 30);
  const clip = doc.tracks[1].clips[0];
  const { doc: split, secondId } = splitClip(doc, clip.id, 3000);
  const clips = split.tracks[1].clips;
  const second = clips.find((c) => c.id === secondId);
  const first = clips.find((c) => c.id !== secondId);
  assert.equal(second.inMs, 0 + (3000 - 1000), "后半段 inMs = 2000");
  assert.equal(first.endMs, 3000, "前半段右端收到切点");
  assert.equal(second.startMs, 3000);
});

test("整轨切分：播放头落在音频内时，后半段 inMs 同步推进", () => {
  const doc = makeDoc([], [[0, 6000]], 30);
  const before = doc.tracks[1].clips[0];
  const split = splitAllAt(doc, 2000);
  const clips = split.tracks[1].clips.slice().sort((a, b) => a.startMs - b.startMs);
  assert.equal(clips.length, 2);
  assert.equal(clips[1].inMs, before.inMs + (2000 - before.startMs), "后半段 inMs = 2000");
});

test("插入音频片段：inMs 原样保留", () => {
  const doc = makeDoc([], [], 30);
  const audioId = doc.tracks[1].id;
  const next = insertClip(doc, audioId, { kind: "audio", startMs: 500, endMs: 3000, inMs: 1200, data: {} });
  assert.equal(next.tracks[1].clips[0].inMs, 1200);
});
