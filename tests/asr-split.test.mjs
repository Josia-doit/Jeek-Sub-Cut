import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubtitles, cleanSegment, displayLen, parseSrt, segmentText } from "@jeek/feature-asr";

const PUNCT = /[.,;:!?，。、；：！？…—～~"'“”‘’（）()《》【】[\]{}]/u;
const srt = (text, a = "00:00:00,000", b = "00:00:06,000") => `1\n${a} --> ${b}\n${text}\n`;
const build = (text, opts = {}) => buildSubtitles(parseSrt(srt(text)), { maxChars: 14, fps: 30, ...opts });

test("SRT 解析：标准时间戳、无时间码内容被忽略", () => {
  const parsed = parseSrt(
    "1\n00:00:01,500 --> 00:00:03,250\n第一句\n\n2\n00:00:03,250 --> 00:00:05,000\n第二句\n",
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].startMs, 1500);
  assert.equal(parsed[0].endMs, 3250);
  assert.deepEqual(parseSrt("没有时间码的一行文字"), []);
});

test("短句：一句话很短就正常一条字幕，两个短句各自成条不硬凑", () => {
  const short = build("哈喽，大家好。");
  assert.equal(short.length, 1);
  assert.equal(short[0].text, "哈喽大家好");

  const two = build("你好。再见。");
  assert.equal(two.length, 2);
});

test("长句：拆成多条、不超字数上限、字幕里没有标点", () => {
  const long = build("这期的视频录制呢又是多灾多难的一期，这已经是我第三次录制了，并且这次又发现了一个新的问题。");
  assert.ok(long.length >= 3, `拆成 ${long.length} 条`);
  assert.ok(long.every((s) => displayLen(s.text) <= 18), `最长 ${Math.max(...long.map((s) => displayLen(s.text)))} 字`);
  assert.ok(long.every((s) => !PUNCT.test(s.text)), long.map((s) => s.text).join(" | "));
});

test("语义断点：不在词中间硬切出单字碎句，连词附近可断行", () => {
  const noPunct = build("只要我使用截图就会导致录屏中断");
  assert.ok(!noPunct.some((s) => displayLen(s.text) < 3), JSON.stringify(noPunct.map((s) => s.text)));

  const conn = build("我本来想讲一下但是突然发现录屏已经中断了于是只好重新录了一遍");
  assert.ok(conn.length >= 2);
  assert.ok(conn.every((s) => !PUNCT.test(s.text)));
});

test("中英混排：中英交界补空格、标点删除", () => {
  const mixed = build("hello,大家好，我是吉客。");
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].text, "hello 大家好我是吉客");
  assert.ok(!PUNCT.test(mixed[0].text));
});

test("字数标准可调：8 字切得更细，24 字也不会超长", () => {
  const TEXT = "有些英文的节点呢你鼠标挪上去它会有一个注释你用截图就会导致录屏中断所以一定要小心";
  const tight = build(TEXT, { maxChars: 8 });
  const loose = build(TEXT, { maxChars: 24 });
  assert.ok(tight.length > loose.length, `8 字 ${tight.length} 条 / 24 字 ${loose.length} 条`);
  assert.ok(loose.every((s) => displayLen(s.text) <= 28), `最长 ${Math.max(...loose.map((s) => displayLen(s.text)))} 字`);
});

test("时间轴：端点相接不重叠、至少一帧、起点量化到帧、单条不超时长上限", () => {
  const timed = build("你好。今天天气很好我们出去走走吧。到了公园以后发现人特别多于是就换了个地方。", { fps: 30 });
  timed.forEach((s, i) => {
    if (i > 0) assert.ok(s.startMs >= timed[i - 1].endMs, "端点相接不重叠");
    assert.ok(s.endMs > s.startMs, "每条至少 1 帧");
  });
  const frameMs = 1000 / 30;
  assert.ok(timed.every((s) => Math.abs(s.startMs / frameMs - Math.round(s.startMs / frameMs)) < 0.05), "起点量化到帧");
  assert.ok(timed.every((s) => s.endMs - s.startMs <= 4501), `最长 ${Math.max(...timed.map((s) => s.endMs - s.startMs))}ms`);
  assert.ok(timed.every((s) => s.text.trim() && !PUNCT.test(s.text)), "无空气泡、无标点");
});

test("去标点与显示字数：空格不计入字数", () => {
  assert.equal(cleanSegment(Array.from("你好，世界！")), "你好世界");
  assert.equal(displayLen("hello 大家好"), 8);
  assert.deepEqual(segmentText("   ", 14, 4), []);
});
