import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyDocument,
  estimateSubtitleDurationMs,
  insertSubtitleAt,
  playheadEndMs,
  quantizeMs,
} from "@jeek/core";

function docWith(list) {
  const doc = createEmptyDocument("插入测试");
  doc.tracks.push({ id: "s1", kind: "subtitle", clips: list });
  return doc;
}
const subs = (doc) => [...doc.tracks.find((t) => t.kind === "subtitle").clips]
  .sort((a, b) => a.startMs - b.startMs);

test("预估时长：按去空白字数给，短句至少 1.2 秒", () => {
  assert.equal(estimateSubtitleDurationMs(""), 1000);
  assert.equal(estimateSubtitleDurationMs("  "), 1000);
  assert.equal(estimateSubtitleDurationMs("你好"), 800);
  assert.equal(estimateSubtitleDurationMs("一二三四五六"), 1320);
});

test("空隙处插入：按字数预估时长，从播放头起算并清空选中", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "旧的" } },
  ]);
  doc.selection.clips = ["a"];
  const r = insertSubtitleAt(doc, 2000, "一二三四五六", { fontSize: 88 });
  const list = subs(r.doc);
  assert.equal(list.length, 2);
  assert.equal(list[1].startMs, 2000);
  // 预估 1320ms，写进工程时对齐到帧
  assert.equal(list[1].endMs, quantizeMs(3320, 30));
  assert.equal(list[1].data.text, "一二三四五六");
  assert.equal(list[1].data.fontSize, 88);
  assert.deepEqual(r.doc.selection.clips, []);
  assert.equal(r.startMs, list[1].startMs);
  assert.equal(r.endMs, list[1].endMs);
});

test("短文本也不短于 1.2 秒", () => {
  const doc = docWith([]);
  const r = insertSubtitleAt(doc, 0, "好");
  assert.equal(r.endMs - r.startMs, 1200);
});

test("落在字幕内部：截断原卡，新卡接管到原卡尾部的时间段", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 1000, endMs: 5000, data: { text: "原来这一整句" } },
    { id: "b", kind: "subtitle", startMs: 5000, endMs: 7000, data: { text: "下一条" } },
  ]);
  const r = insertSubtitleAt(doc, 2000, "新字幕", { color: "#ff0000" });
  const list = subs(r.doc);
  assert.equal(list.length, 3);
  // 原卡被截到播放头
  assert.equal(list[0].id, "a");
  assert.equal(list[0].endMs, 2000);
  assert.equal(list[0].data.text, "原来这一整句");
  // 新卡长度等于「截断位置 → 原卡结束」，不挤到下一条
  assert.equal(list[1].startMs, 2000);
  assert.equal(list[1].endMs, 5000);
  assert.equal(list[1].data.text, "新字幕");
  assert.equal(list[1].data.color, "#ff0000");
  assert.equal(list[2].startMs, 5000);
  assert.equal(list[2].endMs, 7000);
  assert.equal(r.endMs, 5000);
});

test("播放头恰好压在卡片尾端：算空隙，从尾端向右新建", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "旧的" } },
  ]);
  const r = insertSubtitleAt(doc, 1200, "新的一条");
  const list = subs(r.doc);
  assert.equal(list.length, 2);
  assert.equal(list[0].endMs, 1200);
  assert.equal(list[1].startMs, 1200);
});

test("非帧边界的播放头先量化再判内外，返回的端点就是卡片的端点", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1000, data: { text: "旧的" } },
  ]);
  // 30fps 下 990ms 落在第 30 帧，正好是卡片尾端 → 走空隙插入而不是截断
  const r = insertSubtitleAt(doc, 990, "新字幕");
  const list = subs(r.doc);
  assert.equal(list.length, 2);
  assert.equal(list[0].endMs, 1000);
  assert.equal(list[1].startMs, 1000);
  assert.equal(r.startMs, list[1].startMs);
  assert.equal(r.endMs, list[1].endMs);
});

test("内部插入时返回的尾端与原卡尾端一致，播放头不会落回新卡里", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 1000, endMs: 5000, data: { text: "旧的" } },
  ]);
  const r = insertSubtitleAt(doc, 2000, "新字幕");
  const made = subs(r.doc).find((c) => c.data.text === "新字幕");
  assert.equal(r.endMs, made.endMs);
  assert.equal(r.startMs, made.startMs);
  assert.equal(r.endMs, 5000);
});

test("播放头停在卡片最后一帧：接在它后面追加，不把原卡压成碎片", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
  ]);
  // 添加完播放头就停在这个位置：最后一帧的起点（播放头不会落到卡片外面）
  const r = insertSubtitleAt(doc, 1200 - 1000 / 30, "第二句");
  const list = subs(r.doc);
  assert.equal(list.length, 2);
  assert.equal(list[0].endMs, 1200);
  assert.equal(list[1].startMs, 1200);
  assert.ok(list[1].endMs - list[1].startMs >= 1200);
});

test("连续添加三条字幕：首尾相接、互不重叠、每条都不被截成碎片", () => {
  let doc = docWith([]);
  let playhead = 0;
  for (const text of ["第一句台词", "第二句台词", "第三句台词"]) {
    const r = insertSubtitleAt(doc, playhead, text);
    doc = r.doc;
    // 界面加完一条就把播放头放到尾端，再由定位夹到最后一帧起点
    playhead = Math.min(r.endMs, playheadEndMs(doc));
  }
  const list = subs(doc);
  assert.equal(list.length, 3);
  for (let i = 1; i < list.length; i += 1) assert.equal(list[i].startMs, list[i - 1].endMs);
  for (const clip of list) {
    assert.ok(clip.endMs - clip.startMs >= 1200, `${clip.data.text} 只有 ${clip.endMs - clip.startMs}ms`);
  }
});

const noOverlap = (doc) => {
  for (const track of doc.tracks) {
    const list = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(list[i - 1].endMs <= list[i].startMs + 1e-6,
        `${track.kind} 轨第 ${i} 张与前一张重叠：${list[i - 1].endMs} > ${list[i].startMs}`);
    }
  }
};

test("两卡间空隙很短：新字幕只填满空隙，后卡起点和时长都不动", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
    { id: "b", kind: "subtitle", startMs: 2000, endMs: 4000, data: { text: "第二句" } },
  ]);
  // 空隙 1200~2000，播放头在 1600，剩余 400ms 放不下一条按字数预估的字幕（至少 1200ms）
  const r = insertSubtitleAt(doc, 1600, "新字幕");
  const list = subs(r.doc);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, "a");
  assert.equal(list[0].endMs, 1200, "前卡不动");
  assert.equal(list[1].startMs, 1600);
  assert.equal(list[1].endMs, 2000, "新字幕只填满到后卡起点");
  assert.equal(list[1].data.text, "新字幕");
  assert.equal(list[2].id, "b");
  assert.equal(list[2].startMs, 2000, "后卡起点不被推后");
  assert.equal(list[2].endMs, 4000, "后卡时长不被剪短");
  assert.equal(r.endMs, 2000);
  noOverlap(r.doc);
});

test("空隙恰好等于预估时长：仍按正常规则从后卡左端切一半", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
    { id: "b", kind: "subtitle", startMs: 2800, endMs: 4800, data: { text: "第二句" } },
  ]);
  // 剩余空隙 1200ms，正好等于短句最小预估时长 → 不算「很短」
  const r = insertSubtitleAt(doc, 1600, "新字幕");
  const list = subs(r.doc);
  assert.equal(list[1].startMs, 1600);
  assert.equal(list[1].endMs, 3800);
  assert.equal(list[2].startMs, 3800);
  assert.equal(list[2].endMs, 4800);
  noOverlap(r.doc);
});

test("两卡间空隙足够放下一整条：后卡剪短一半，新字幕占空隙与前半段，绝不重叠", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
    { id: "b", kind: "subtitle", startMs: 5000, endMs: 7000, data: { text: "第二句" } },
  ]);
  const r = insertSubtitleAt(doc, 1600, "新字幕");
  const list = subs(r.doc);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, "a");
  assert.equal(list[0].endMs, 1200, "前卡不动");
  assert.equal(list[1].startMs, 1600);
  assert.equal(list[1].data.text, "新字幕");
  assert.equal(list[2].id, "b");
  assert.equal(list[2].startMs, 6000, "后卡从 5000~7000 剪成 6000~7000");
  assert.equal(list[1].endMs, 6000, "新字幕正好接在被剪短的后卡前面");
  assert.equal(list[2].endMs - list[2].startMs, 1000, "后卡只剩一半时长");
  assert.equal(r.endMs, 6000);
  noOverlap(r.doc);
});

test("播放头恰好压在后卡起点：仍从后卡左端切一半，两张卡首尾相接", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
    { id: "b", kind: "subtitle", startMs: 2000, endMs: 4000, data: { text: "第二句" } },
  ]);
  const r = insertSubtitleAt(doc, 2000, "新字幕");
  const list = subs(r.doc);
  assert.equal(list.length, 3);
  assert.equal(list[1].startMs, 2000);
  assert.equal(list[1].endMs, 3000);
  assert.equal(list[2].startMs, 3000);
  noOverlap(r.doc);
});

test("卡内插入：以播放头为界分割旧卡，后半段是新字幕", () => {
  const doc = docWith([
    { id: "a", kind: "subtitle", startMs: 1000, endMs: 5000, data: { text: "原来这一整句" } },
    { id: "b", kind: "subtitle", startMs: 5000, endMs: 7000, data: { text: "下一条" } },
  ]);
  const r = insertSubtitleAt(doc, 2000, "新字幕");
  const list = subs(r.doc);
  assert.equal(list[0].endMs, 2000);
  assert.equal(list[1].startMs, 2000);
  assert.equal(list[1].endMs, 5000);
  assert.equal(list[1].data.text, "新字幕");
  assert.equal(list[2].startMs, 5000);
  noOverlap(r.doc);
});

test("反复在不同位置插入：任意轨道都不出现重叠卡片", () => {
  let doc = docWith([
    { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句" } },
    { id: "b", kind: "subtitle", startMs: 2000, endMs: 4000, data: { text: "第二句" } },
  ]);
  // 附带一条原本就有重叠的音轨，收口函数要把它一并理顺
  doc.tracks.push({
    id: "a1", kind: "audio", clips: [
      { id: "au1", kind: "audio", startMs: 0, endMs: 2000, data: {} },
      { id: "au2", kind: "audio", startMs: 1500, endMs: 3500, data: {} },
    ],
  });
  for (const at of [1600, 800, 2400, 3100, 4000, 0, 5200]) {
    const r = insertSubtitleAt(doc, at, `插${at}`);
    doc = r.doc;
    noOverlap(doc);
  }
  assert.ok(subs(doc).length >= 9);
});
