import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_FONT_FAMILIES,
  DEFAULT_FONT_FAMILY,
  FONT_FILE_EXTENSIONS,
  MAX_FONT_BYTES,
  addTrack,
  createEmptyDocument,
  fontCatalogBytes,
  fontFamilyOfFile,
  insertClip,
  isFontFile,
  mergeFontEntries,
  playbackEndMs,
  sanitizeFontEntries,
  timelineTotal,
} from "@jeek/core";

/** 内置字体只有系统字体：不随程序分发第三方字体，避免授权问题 */
test("内置字体清单只含系统字体", () => {
  assert.equal(BUILTIN_FONT_FAMILIES.length, 5);
  assert.equal(BUILTIN_FONT_FAMILIES[0], "Microsoft YaHei");
  assert.deepEqual(BUILTIN_FONT_FAMILIES, [
    "Microsoft YaHei", "SimHei", "SimSun", "KaiTi", "FangSong",
  ]);
  assert.equal(DEFAULT_FONT_FAMILY, "Microsoft YaHei");
});

test("字体文件后缀白名单与旧版一致", () => {
  assert.deepEqual(FONT_FILE_EXTENSIONS, [".ttf", ".otf", ".woff", ".woff2"]);
  assert.equal(isFontFile("Aa.ttf"), true);
  assert.equal(isFontFile("Aa.OTF"), true);
  assert.equal(isFontFile("Aa.woff2"), true);
  assert.equal(isFontFile("Aa.txt"), false);
  assert.equal(isFontFile("Aa"), false);
  assert.equal(MAX_FONT_BYTES, 200 * 1024 * 1024, "上限放宽到 200MB：完整中文字体可到几十 MB");
});

test("字体名取文件名去后缀（口径照旧版）", () => {
  assert.equal(fontFamilyOfFile("Aa.ttf"), "Aa");
  assert.equal(fontFamilyOfFile("C:\\Fonts\\Aa.Bold.woff2"), "Aa.Bold");
  assert.equal(fontFamilyOfFile(".ttf"), "自定义字体");
  assert.equal(fontFamilyOfFile(""), "自定义字体");
});

test("字体目录合并：导入的排前面，内置的跟在后面，同名只留一条", () => {
  const merged = mergeFontEntries([
    { family: "Aa", source: "data:font/ttf;base64,AAA" },
    { family: "Microsoft YaHei", source: "data:font/ttf;base64,BBB" },
  ]);
  assert.equal(merged.length, 6, "内置五款系统字体 + 一款新字体，重复的微软雅黑顶掉内置那条");
  assert.equal(merged[0].family, "Aa", "导入的字体排最前");
  assert.equal(merged[0].source, "data:font/ttf;base64,AAA");
  assert.equal(merged[1].family, "Microsoft YaHei");
  assert.equal(merged[1].source, "data:font/ttf;base64,BBB", "同名时用导入的那份（带字体文件）");
  assert.equal(merged[5].family, "FangSong");
});

test("字体目录清洗：脏数据丢掉，字段类型归一", () => {
  const list = sanitizeFontEntries([
    { family: "  Aa  ", source: "data:font/ttf;base64,AAA", sizeBytes: 12 },
    { family: "", source: "x" },
    { family: 123 },
    null,
    "字符串",
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].family, "Aa");
  assert.equal(list[0].sizeBytes, 12);
  assert.equal(fontCatalogBytes(list), 12);
});

/** 播放长度跟随轨道末尾（末帧，不额外加空帧），不跟刻度尺的留白 */
function docWithAudio(endMs) {
  const doc = addTrack(createEmptyDocument("测试"), "audio", "音频轨");
  return insertClip(doc, doc.tracks[0].id, {
    kind: "audio",
    startMs: 0,
    endMs,
    inMs: 0,
    data: {},
  });
}

test("播放长度跟随轨道末尾：录 4 秒就播 4 秒，不多给 3 秒", () => {
  const doc = docWithAudio(4000);
  const fps = doc.video.fps;
  const end = playbackEndMs(doc);
  assert.ok(end >= 4000 && end < 4000 + 1000 / fps + 1, `播放长度应贴近 4000ms，实际 ${end}`);
  assert.ok(end < timelineTotal(doc), "刻度尺留白不等于播放长度");
  assert.ok(timelineTotal(doc) >= 7000, "刻度尺仍留出拖动余量");
});

test("空工程没有内容，播放长度就是 0（不预设默认时长）", () => {
  const doc = createEmptyDocument("空工程");
  assert.equal(playbackEndMs(doc), 0);
});

test("30fps 下播放长度跟随轨道末尾的末帧（不加空帧）", () => {
  const doc = docWithAudio(5800);
  assert.equal(doc.video.fps, 30);
  assert.equal(Math.round(playbackEndMs(doc)), 5800);
});
