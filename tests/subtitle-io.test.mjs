import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubtitleText,
  createEmptyDocument,
  deserializeProject,
  detectFormat,
  migrate,
  parseStamp,
  parseSubtitles,
  serializeProject,
  sliceDocument,
  toSrt,
} from "@jeek/core";

/* ---------------------------------------------------------------- 字幕格式 */

test("SRT：编号错乱、多个空行、CRLF 与 BOM 都能吃下", () => {
  const raw = "\uFEFF7\r\n00:00:01,000 --> 00:00:03,500\r\n第一句\r\n\r\n\r\n3\r\n00:00:04,000 --> 00:00:06,000\r\n第二句\r\n第三行\r\n";
  const result = parseSubtitles(raw, "srt");
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[0], { startMs: 1000, endMs: 3500, text: "第一句" });
  assert.equal(result.cues[1].text, "第二句\n第三行");
});

test("SRT：结束早于开始、负起点都会被修正", () => {
  const result = parseSubtitles("1\n00:00:05,000 --> 00:00:02,000\n倒挂\n\n2\n00:00:00,000 --> 00:00:01,000\n正常", "srt");
  assert.equal(result.cues.length, 2);
  assert.ok(result.cues[0].endMs > result.cues[0].startMs);
  assert.ok(result.cues[1].startMs >= 0);
});

test("VTT：跳过 WEBVTT 头、NOTE 块与 cue 设置", () => {
  const raw = [
    "WEBVTT",
    "",
    "NOTE 这是一段备注",
    "",
    "cue-1",
    "00:00:01.000 --> 00:00:02.500 align:start position:10%",
    "竖屏字幕",
    "",
    "00:00:03.000 --> 00:00:04.000",
    "第二句",
  ].join("\n");
  const result = parseSubtitles(raw, "vtt");
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[0], { startMs: 1000, endMs: 2500, text: "竖屏字幕" });
  assert.equal(result.cues[1].startMs, 3000);
});

test("VTT：MM:SS.mmm 这种省略小时的写法也认", () => {
  assert.equal(parseStamp("01:02.500"), 62500);
  const result = parseSubtitles("WEBVTT\n\n01:00.000 --> 01:05.000\n短写法", "vtt");
  assert.equal(result.cues[0].startMs, 60000);
});

test("JSON：字段白名单与下划线命名都认，缺时间的跳过", () => {
  const raw = JSON.stringify([
    { text: "甲", startMs: 0, endMs: 1000 },
    { text: "乙", start_ms: 2000, end_ms: 3000 },
    { text: "" , startMs: 4000, endMs: 5000 },
    { text: "丁" },
    "不是对象",
  ]);
  const result = parseSubtitles(raw, "json");
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[1], { startMs: 2000, endMs: 3000, text: "乙" });
});

test("纯文本：没有时间码就按行拆句，空行与纯数字编号不进字幕", () => {
  const result = parseSubtitles("第一行\n\n2\n第二行\n   \n第三行\n", "txt");
  assert.deepEqual(result.plain, ["第一行", "第二行", "第三行"]);
  assert.equal(result.cues.length, 0);
});

test("格式识别：看扩展名，没扩展名就看内容", () => {
  assert.equal(detectFormat("a.srt", ""), "srt");
  assert.equal(detectFormat("a.vtt", ""), "vtt");
  assert.equal(detectFormat("a.json", ""), "json");
  assert.equal(detectFormat("a.txt", ""), "txt");
  assert.equal(detectFormat("clip", "WEBVTT\n\n"), "vtt");
  assert.equal(detectFormat("clip", '[{"text":"甲"}]'), "json");
  assert.equal(detectFormat("clip", "1\n00:00:01,000 --> 00:00:02,000\n甲"), "srt");
  assert.equal(detectFormat("clip", "随便一行字"), "txt");
});

test("生成：四种格式各按各的口径输出", () => {
  const cues = [{ startMs: 1000, endMs: 2500, text: "甲" }, { startMs: 3000, endMs: 4000, text: "乙" }];
  assert.match(toSrt(cues), /^1\n00:00:01,000 --> 00:00:02,500\n甲/);
  const vtt = buildSubtitleText(cues, "vtt");
  assert.ok(vtt.startsWith("WEBVTT\n"));
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500/);
  assert.equal(buildSubtitleText(cues, "txt"), "甲\n乙");
  assert.deepEqual(JSON.parse(buildSubtitleText(cues, "json"))[1], { text: "乙", startMs: 3000, endMs: 4000 });
});

test("往返一致：生成的 SRT / VTT / JSON 再解析回来时间不变", () => {
  const cues = [{ startMs: 0, endMs: 1500, text: "起" }, { startMs: 1500, endMs: 4200, text: "承" }];
  for (const format of ["srt", "vtt", "json"]) {
    const back = parseSubtitles(buildSubtitleText(cues, format), format);
    assert.deepEqual(
      back.cues.map((c) => [c.startMs, c.endMs, c.text]),
      cues.map((c) => [c.startMs, c.endMs, c.text]),
      format,
    );
  }
});

/* ---------------------------------------------------------------- 旧版工程 */

function legacyProject() {
  return {
    app: "JeekSubCut",
    version: 1,
    subtitles: [
      {
        id: 1,
        text: "旧版字幕一",
        startMs: 0,
        endMs: 1200,
        fontSize: 96,
        fontFamily: "SimHei",
        color: "#FFB4A2",
        enterAnimation: "scale",
        moveAnimation: "clockwise90",
      },
      { id: 2, text: "旧版字幕二", startMs: 1200, endMs: 2600 },
      { id: 3, text: "   ", startMs: 2600, endMs: 2700 },
      { id: 4, text: "坏动画", startMs: 2700, endMs: 3000, enterAnimation: "不存在的效果", moveAnimation: "斜着" },
    ],
    settings: {
      background: { type: "image" },
      anchor: { x: 0.5, y: 0.25 },
      style: { minFontSize: 80, maxFontSize: 120, fontFamily: "KaiTi", colorPalette: ["#FFF4B5", "#FFB4A2"] },
      fontStyle: "large",
      randomStyle: true,
      globalEnter: "fadeIn",
      randomMove: true,
      rotateEvery: 3,
      asrMaxChars: 12,
      asrBackend: "cpu",
      asrMaxMs: 5000,
      asrVadSeg: 6000,
    },
    audio: "C:\\Music\\旁白.mp3",
    audioSegments: [{ startMs: 0, endMs: 2600, inMs: 500 }],
    exportRange: { start: 200, end: 2400 },
  };
}

test("旧版工程：字幕条数、时间与样式完整还原，空句丢弃", () => {
  const doc = deserializeProject(JSON.stringify(legacyProject()));
  const track = doc.tracks.find((t) => t.kind === "subtitle");
  assert.ok(track);
  assert.equal(track.clips.length, 3);
  const [first, second, third] = [...track.clips].sort((a, b) => a.startMs - b.startMs);
  assert.equal(first.data.text, "旧版字幕一");
  assert.equal(first.data.fontSize, 96);
  assert.equal(first.data.fontFamily, "SimHei");
  assert.equal(first.data.color, "#FFB4A2");
  assert.equal(first.data.enterAnimation, "scale");
  assert.equal(first.data.motion, "clockwise90");
  assert.equal(second.startMs, 1200);
  assert.equal(second.endMs, 2600);
  // 不认识的动效与方向退回安全值
  assert.equal(third.data.enterAnimation, "fadeIn");
  assert.equal(third.data.motion, "up");
});

test("旧版工程：比例、位置、调色板、ASR 与导出范围都搬到新版字段", () => {
  const doc = deserializeProject(JSON.stringify(legacyProject()));
  assert.equal(doc.settings.aspect, "landscape");
  assert.equal(doc.settings.resolution, "1080P");
  assert.equal(doc.settings.subtitleX, 50);
  assert.equal(doc.settings.subtitleY, 25);
  assert.equal(doc.settings.fontFamily, "KaiTi");
  assert.deepEqual(doc.settings.palette, ["#FFF4B5", "#FFB4A2"]);
  assert.equal(doc.settings.randomStyle, true);
  assert.equal(doc.settings.rotationMode, "auto");
  assert.equal(doc.settings.rotationInterval, 3);
  assert.equal(doc.settings.asrMaxChars, 12);
  assert.equal(doc.settings.asrBackend, "cpu");
  assert.equal(doc.settings.asrVadMaxSeg, 6000);
  assert.deepEqual(doc.settings.exportRange, { startMs: 200, endMs: 2400 });
  assert.equal(doc.settings.legacyAudioPath, "C:\\Music\\旁白.mp3");
});

test("旧版工程：载入后能直接再存成新版工程并重新读回", () => {
  const doc = deserializeProject(JSON.stringify(legacyProject()));
  const text = serializeProject(doc);
  const again = deserializeProject(text);
  assert.equal(again.schemaVersion, doc.schemaVersion);
  assert.deepEqual(
    again.tracks.find((t) => t.kind === "subtitle").clips.map((c) => c.data.text),
    doc.tracks.find((t) => t.kind === "subtitle").clips.map((c) => c.data.text),
  );
});

test("新版工程缺字段：tracks / settings / video 缺失也能补齐", () => {
  const doc = migrate({ name: "半截工程", tracks: [{ id: "t1", kind: "subtitle", clips: [] }] });
  assert.equal(doc.tracks.length, 1);
  assert.equal(doc.tracks[0].name, "字幕轨");
  assert.ok(doc.video.fps > 0);
  assert.equal(doc.schemaVersion, 1);
});

/* ---------------------------------------------------------------- 导出范围 */

function rangeDoc() {
  const doc = createEmptyDocument("范围");
  doc.tracks.push({
    id: "s1",
    kind: "subtitle",
    name: "字幕轨",
    clips: [
      { id: "c1", trackId: "s1", kind: "subtitle", startMs: 0, endMs: 2000, inMs: 0, data: { text: "早" }, effects: [] },
      { id: "c2", trackId: "s1", kind: "subtitle", startMs: 2000, endMs: 6000, inMs: 0, data: { text: "中" }, effects: [] },
      { id: "c3", trackId: "s1", kind: "subtitle", startMs: 6000, endMs: 8000, inMs: 0, data: { text: "晚" }, effects: [] },
    ],
    muted: false,
    locked: false,
  });
  return doc;
}

test("导出范围：按起点平移、跨界的夹到区间内、完全在外的丢掉", () => {
  const sliced = sliceDocument(rangeDoc(), 1500, 4000);
  const clips = sliced.tracks[0].clips;
  assert.deepEqual(clips.map((c) => c.data.text), ["早", "中"]);
  assert.deepEqual([clips[0].startMs, clips[0].endMs], [0, 500]);
  assert.deepEqual([clips[1].startMs, clips[1].endMs], [500, 4000]);
});

test("导出范围：左边界被切掉多长，源内偏移就推进多少", () => {
  const doc = rangeDoc();
  const audioTrack = {
    id: "a1",
    kind: "audio",
    name: "音频轨",
    clips: [{ id: "a", trackId: "a1", kind: "audio", startMs: 1000, endMs: 7000, inMs: 500, data: {}, effects: [] }],
    muted: false,
    locked: false,
  };
  doc.tracks.push(audioTrack);
  const sliced = sliceDocument(doc, 3000, 2000);
  const audio = sliced.tracks.find((t) => t.kind === "audio").clips[0];
  assert.deepEqual([audio.startMs, audio.endMs], [0, 2000]);
  // 起点切掉 2000ms，源内从 500 推到 2500
  assert.equal(audio.inMs, 2500);
});
