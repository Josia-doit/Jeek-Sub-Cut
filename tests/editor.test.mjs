import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTrack,
  createEmptyDocument,
  deleteClips,
  fillGaps,
  fmtMs,
  fmtTimecode,
  insertClip,
  mergeClips,
  moveClips,
  quantizeMs,
  removeGaps,
  splitAllAt,
  splitClip,
  splitTextIntoClips,
  trimClip,
  wordWeight,
} from "@jeek/core";
import { evaluateFrame, fingerprintFrame, wrapText } from "@jeek/engine";
import { buildSubtitles, displayLen, parseSrt, segmentText } from "@jeek/feature-asr";

const subtitleDoc = () => {
  let doc = createEmptyDocument("行为基线");
  doc = addTrack(doc, "subtitle", "字幕轨");
  doc = addTrack(doc, "audio", "音频轨");
  const sub = doc.tracks[0].id;
  for (const [text, start, end] of [
    ["第一句", 0, 1000],
    ["第二句", 1000, 2000],
    ["第三句", 2000, 3000],
  ]) {
    doc = insertClip(doc, sub, { kind: "subtitle", startMs: start, endMs: end, data: { text } });
  }
  // 旧版 0.2s 入场窗口是本组基线的固定口径，与界面默认时长无关
  return { ...doc, settings: { ...doc.settings, enterDurationMs: 200 } };
};

test("时间码：末位按帧率进制，不是固定两位小数", () => {
  assert.equal(fmtTimecode(0, 30), "00:00:00.00");
  assert.equal(fmtTimecode(1000, 30), "00:00:01.00");
  assert.equal(fmtTimecode(1033.333, 30), "00:00:01.01");
  assert.equal(fmtTimecode(1000, 24), "00:00:01.00");
  assert.equal(fmtTimecode(3661000, 30), "01:01:01.00");
  assert.equal(fmtMs(1000.0000000001), "1000");
});

test("帧量化与字数权重：中英混排不被 ASCII 长度带偏", () => {
  assert.equal(quantizeMs(1001, 30), 1000);
  assert.equal(Math.round((quantizeMs(1017, 30) * 30) / 1000), 31);
  assert.equal(wordWeight("中文四字"), 4);
  assert.ok(wordWeight("abcd") < wordWeight("中文四字"));
  assert.equal(wrapText("一二三四五六七八九十", 4).length, 3);
});

test("切分：默认选中后半段，音频片段同步推进源内偏移", () => {
  const doc = subtitleDoc();
  const first = doc.tracks[0].clips[0];
  const r = splitClip(doc, first.id, 400);
  assert.equal(r.doc.tracks[0].clips.length, 4);
  assert.ok(r.secondId);
  assert.deepEqual(r.doc.selection.clips, [r.secondId]);
  const second = r.doc.tracks[0].clips.find((c) => c.id === r.secondId);
  assert.equal(second.startMs, 400);
  assert.equal(first.endMs, 1000, "切分返回新文档，原文档不被就地修改");

  let withAudio = insertClip(doc, doc.tracks[1].id, {
    kind: "audio", startMs: 0, endMs: 1000, inMs: 200,
  });
  const audio = withAudio.tracks[1].clips[0];
  const cut = splitClip(withAudio, audio.id, 400);
  const tail = cut.doc.tracks[1].clips.find((c) => c.id === cut.secondId);
  assert.equal(tail.inMs, 600);
  assert.equal(tail.startMs, 400);
});

test("播放头切分同时作用字幕与音频两条轨道", () => {
  let doc = subtitleDoc();
  doc = insertClip(doc, doc.tracks[1].id, { kind: "audio", startMs: 0, endMs: 3000, inMs: 0 });
  const next = splitAllAt(doc, 1500);
  assert.equal(next.tracks[0].clips.length, 4);
  assert.equal(next.tracks[1].clips.length, 2);
  assert.equal(next.selection.clips.length, 2);
});

test("裁剪：移动不改 inMs，裁剪左端才同步推进源内偏移", () => {
  const base = subtitleDoc();
  let doc = insertClip(base, base.tracks[1].id, {
    kind: "audio", startMs: 500, endMs: 1500, inMs: 300,
  });
  const clip = doc.tracks[1].clips[0];
  const trimmed = trimClip(doc, clip.id, "start", 200);
  const after = trimmed.tracks[1].clips[0];
  assert.equal(after.startMs, 700);
  assert.equal(after.inMs, 500);
  assert.equal(after.endMs, 1500);
});

test("整体平移：任一卡片会压到未移动卡片时整组拦住", () => {
  const doc = subtitleDoc();
  const r = moveClips(doc, [doc.tracks[0].clips[1].id], -3000);
  assert.equal(r.applied, 0, "越过前一张卡片时不应移动");
  assert.equal(r.doc, doc);
  const withGap = deleteClips(doc, [doc.tracks[0].clips[1].id]);
  const ok = moveClips(withGap, [withGap.tracks[0].clips[1].id], -100);
  assert.ok(ok.applied < 0, "前一张被删出空隙后可以向前挪");
});

test("自动填充与消除缝隙：字幕头尾衔接，不留空隙", () => {
  let doc = subtitleDoc();
  doc = deleteClips(doc, [doc.tracks[0].clips[1].id]);
  const filled = fillGaps(doc, doc.tracks[0].id);
  assert.equal(filled.filled, 1);
  const clips = filled.doc.tracks[0].clips.sort((a, b) => a.startMs - b.startMs);
  assert.equal(clips[0].endMs, clips[1].startMs);
  const removed = removeGaps(doc);
  assert.equal(removed.moved, 1);
});

test("并句与拆句：合并文本、按字数分配时长且总长不变", () => {
  const doc = subtitleDoc();
  const merged = mergeClips(doc, [doc.tracks[0].clips[0].id, doc.tracks[0].clips[1].id]);
  assert.equal(merged.tracks[0].clips.length, 2);
  assert.equal(merged.tracks[0].clips.find((c) => c.startMs === 0).data.text, "第一句第二句");

  const pieces = ["中文一句", "English words", "混排句子"];
  const split = splitTextIntoClips(doc, doc.tracks[0].id, doc.tracks[0].clips[0].id, pieces);
  const created = split.tracks[0].clips
    .filter((c) => c.startMs < 1000)
    .sort((a, b) => a.startMs - b.startMs);
  assert.equal(created.length, 3);
  assert.equal(created[0].startMs, 0);
  assert.ok(Math.abs(created.at(-1).endMs - 1000) < 1000 / 30 + 1, "拆句总时长与原卡片一致");
});

test("帧求值：起点入场未触发、入场完成后可见，历史层按行高+16 向上堆叠", () => {
  const doc = subtitleDoc();
  const first = evaluateFrame(doc, 0);
  assert.equal(first.layers.length, 1);
  assert.equal(first.layers[0].text, "第一句");
  // 旧版语义：第 0 帧入场进度为 0（getSpringProgress(0)=0）
  assert.equal(first.layers[0].enter, 0);
  assert.equal(first.layers[0].opacity, 0);

  const shown = evaluateFrame(doc, 500); // 超过 0.2s 入场窗口
  assert.equal(shown.layers[0].opacity, 1, "入场完成后可见首句");

  const mid = evaluateFrame(doc, 1500);
  assert.equal(mid.currentIndex, 1);
  assert.equal(mid.layers.length, 2);
  assert.equal(mid.layers[0].text, "第二句");
  // 旧版历史层只写 bottom 偏移：不淡化、不缩小、不斜移、不旋转
  assert.equal(mid.layers[1].opacity, 1);
  assert.equal(mid.layers[1].scale, 1);
  assert.equal(mid.layers[1].dx, 0);
  assert.equal(mid.layers[1].dy, 0);
  assert.equal(mid.layers[1].rotation, 0);
  assert.equal(mid.layers[1].fontSize, mid.layers[0].fontSize);
  // 字号 60 → 行高 74；堆叠间距 16 → 第一层上移 90（过渡早已结束）
  assert.equal(mid.layers[1].bottom, 60 + 14 + 16);
});

test("帧求值：L 型旋转组由每条字幕的 moveAnimation 决定，帧指纹可复现", () => {
  const doc = subtitleDoc();
  const track = doc.tracks[0];
  const rotated = {
    ...doc,
    tracks: doc.tracks.map((t, i) =>
      i === 0
        ? {
            ...t,
            clips: t.clips.map((c, n) =>
              n === 1 ? { ...c, data: { ...c.data, moveAnimation: "clockwise90" } } : c,
            ),
          }
        : t,
    ),
  };
  assert.equal(track.clips.length, 3);
  const third = evaluateFrame(rotated, 2300);
  assert.equal(third.rotationGroups.length, 1, "前一条设了顺时针 → 形成一个 L 型拐角");
  assert.equal(third.rotationGroups[0].rotation, 90);
  assert.ok(third.rotationGroups[0].pivotX > 0);
  assert.equal(third.layers[0].align, "right", "顺时针之后右对齐");
  assert.ok(third.layers.some((l) => l.inRotationGroup), "旋转点及更旧的层整块进组");

  const a = fingerprintFrame(evaluateFrame(rotated, 2300));
  const b = fingerprintFrame(evaluateFrame(rotated, 2300));
  const c = fingerprintFrame(evaluateFrame(rotated, 2010));
  assert.equal(a, b);
  assert.notEqual(a, c, "换句过渡中取景与堆叠位置都不同");
});

test("语音分句：长句按标点与最大字数切开，标点不落进字幕", () => {
  const entries = parseSrt(
    "1\n00:00:00,000 --> 00:00:08,000\n你好世界。今天天气不错，我们出去玩吧！这是一段很长很长很长没有任何标点的文字需要被切开\n",
  );
  const pieces = buildSubtitles(entries, { maxChars: 8, fps: 30 });
  assert.ok(pieces.length >= 3, `拆成 ${pieces.length} 条`);
  assert.ok(pieces.every((p) => displayLen(p.text) <= 12));
  assert.ok(pieces.every((p) => !/[。！？，]/.test(p.text)));
  assert.deepEqual(segmentText("   ", 8, 2), []);
});
