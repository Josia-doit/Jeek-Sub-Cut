import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "@jeek/contracts";
import {
  addClip,
  addTrack,
  createEmptyDocument,
  durationOf,
  findClip,
  frameCountOf,
  playbackEndMs,
  playheadEndMs,
  removeClip,
  updateClip,
  validateDocument,
} from "@jeek/core";

const withClip = (startMs, endMs) => {
  let doc = addTrack(createEmptyDocument(), "subtitle", "字幕轨");
  doc = addClip(doc, doc.tracks[0].id, { kind: "subtitle", startMs, endMs, data: { text: "你好" } });
  return doc;
};

test("空工程：schema 版本有效、没有任何内容就是 0 帧", () => {
  const doc = createEmptyDocument();
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.tracks.length, 0);
  assert.equal(doc.video.fps, 30);
  assert.equal(frameCountOf(doc), 0);
  assert.equal(validateDocument(doc), null);
});

test("轨道与片段：按起点排序、时长取最后一张末尾、帧数停在末帧不加空帧", () => {
  let doc = withClip(2000, 3000);
  doc = addClip(doc, doc.tracks[0].id, { kind: "subtitle", startMs: 0, endMs: 1000, data: {} });
  assert.equal(doc.tracks[0].clips[0].startMs, 0);
  assert.equal(durationOf(doc), 3000);
  assert.equal(frameCountOf(doc), Math.ceil((3000 * 30) / 1000 - 1e-6));
  assert.equal(frameCountOf(doc), 90);
});

test("播放头与播放长度都停在卡片末端（内容真正结束处），不再少一帧/多一帧", () => {
  const doc = withClip(0, 3000);
  assert.equal(playbackEndMs(doc), 3000, "播放/进度条长度 = 卡片末端 3 秒");
  assert.equal(playheadEndMs(doc), 3000, "播放头能精确停在卡片末端，不再停在末帧起点少一帧");
  assert.equal(playheadEndMs(createEmptyDocument()), 0, "空工程没有可停留的位置");
});

test("非整帧对齐时仍有唯一末端：播放头与播放长度都等于卡片末端，不冒不缩", () => {
  // 3022ms @30fps 落在末帧内部（末帧 [3000,3033.33)），旧实现会：
  //   playheadEndMs=(91-1)/30*1000=3000（少一帧）、playbackEndMs=91/30*1000=3033.33（多冒 11ms 空白）。
  // 这正是「选不中最后一帧 / 尾部多一帧」的真实场景，现在两者都必须等于 durationOf=3022。
  const doc = withClip(0, 3022);
  assert.equal(durationOf(doc), 3022);
  assert.equal(playbackEndMs(doc), 3022, "播放长度 = 卡片末端，不多冒空白帧");
  assert.equal(playheadEndMs(doc), 3022, "播放头 = 卡片末端，不再少一帧停在末帧起点");
});

test("裁剪左端：startMs 与 inMs 一起推进，源内内容不错位", () => {
  const doc = withClip(0, 1000);
  const id = doc.tracks[0].clips[0].id;
  const trimmed = updateClip(doc, id, { startMs: 300, inMs: 300 });
  assert.equal(trimmed.tracks[0].clips[0].startMs, 300);
  assert.equal(trimmed.tracks[0].clips[0].inMs, 300);
  assert.equal(trimmed.tracks[0].clips[0].endMs, 1000);
  assert.equal(doc.tracks[0].clips[0].startMs, 0, "原文档不可变");
});

test("移动片段：只改起止，inMs 不变", () => {
  const doc = withClip(0, 1000);
  const id = doc.tracks[0].clips[0].id;
  const moved = updateClip(doc, id, { startMs: 500, endMs: 1500 });
  assert.equal(moved.tracks[0].clips[0].inMs, 0);
  assert.equal(durationOf(moved), 1500);
});

test("不可变写操作：原文档始终不受影响", () => {
  const doc = withClip(0, 1000);
  const id = doc.tracks[0].clips[0].id;
  const next = updateClip(doc, id, { data: { text: "改过" } });
  assert.equal(doc.tracks[0].clips[0].data.text, "你好");
  assert.equal(next.tracks[0].clips[0].data.text, "改过");
  assert.equal(findClip(doc, id)?.clip.id, id);
  assert.equal(findClip(doc, "不存在"), null);
});

test("校验：重复轨道 id / 负 inMs / 非正时长都能拦住", () => {
  const dup = createEmptyDocument();
  dup.tracks = [
    { id: "same", kind: "subtitle", name: "A", clips: [], muted: false, locked: false },
    { id: "same", kind: "subtitle", name: "B", clips: [], muted: false, locked: false },
  ];
  assert.match(validateDocument(dup), /重复/);

  const badIn = withClip(0, 1000);
  badIn.tracks[0].clips[0].inMs = -1;
  assert.match(validateDocument(badIn), /源内偏移/);

  const badDuration = withClip(0, 1000);
  badDuration.tracks[0].clips[0].endMs = 0;
  assert.match(validateDocument(badDuration), /非正/);
});

test("删除片段：同时从选中集移除", () => {
  let doc = withClip(0, 1000);
  const id = doc.tracks[0].clips[0].id;
  doc.selection.clips = [id];
  const next = removeClip(doc, id);
  assert.equal(next.tracks[0].clips.length, 0);
  assert.deepEqual(next.selection.clips, []);
  assert.equal(doc.tracks[0].clips.length, 1);
});

test("非法写操作直接抛错，不产生半成品文档", () => {
  const doc = withClip(0, 1000);
  assert.throws(() => addClip(doc, "不存在的轨道", { kind: "subtitle", startMs: 0, endMs: 100 }), /轨道不存在/);
  assert.throws(() => addClip(doc, doc.tracks[0].id, { kind: "subtitle", startMs: 100, endMs: 100 }), /必须为正/);
});
