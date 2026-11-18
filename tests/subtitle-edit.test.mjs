import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeSubtitleId,
  applyRotationPlan,
  countMatches,
  createEmptyDocument,
  mergeSubtitleWithNext,
  mergeSubtitleWithPrev,
  replaceSubtitleText,
  splitSubtitleAt,
} from "@jeek/core";

/** 三条字幕，首尾相接，第二条与第三条之间留 400ms 真空 */
function sampleDoc() {
  const doc = createEmptyDocument("测试工程");
  doc.tracks.push({
    id: "s1",
    kind: "subtitle",
    clips: [
      { id: "a", kind: "subtitle", startMs: 0, endMs: 1200, data: { text: "第一句话" } },
      { id: "b", kind: "subtitle", startMs: 1200, endMs: 2400, data: { text: "第二句话" } },
      { id: "c", kind: "subtitle", startMs: 2800, endMs: 4000, data: { text: "第三句话" } },
    ],
  });
  return doc;
}
const subs = (doc) => doc.tracks.find((t) => t.kind === "subtitle").clips;
const textAt = (doc, id) => String(subs(doc).find((c) => c.id === id).data.text);

test("光标中间回车：拆成两条端点相接的字幕，时长按字数权重分并量化到帧", () => {
  const doc = sampleDoc();
  const r = splitSubtitleAt(doc, "a", 2);
  assert.ok(r);
  const clips = subs(r.doc).sort((x, y) => x.startMs - y.startMs);
  assert.equal(clips.length, 4);
  assert.equal(clips[0].data.text, "第一");
  assert.equal(clips[1].data.text, "句话");
  assert.equal(clips[0].endMs, clips[1].startMs);
  assert.equal(clips[1].endMs, 1200);
  // 2 字 / 4 字 → 600ms；30fps 下 600ms 正好是整帧
  assert.equal(clips[0].endMs, 600);
  assert.equal(r.focusId, clips[1].id);
  assert.equal(r.caret, 0);
});

test("光标两侧没有字时不拆；太短的卡片不拆", () => {
  const doc = sampleDoc();
  assert.equal(splitSubtitleAt(doc, "a", 0), null);
  assert.equal(splitSubtitleAt(doc, "a", 4), null);
  const short = sampleDoc();
  subs(short)[0].endMs = 10; // 不足两帧
  assert.equal(splitSubtitleAt(short, "a", 2), null);
});

test("开头 Backspace：与上一条合并，文字相接、时间横跨两条、焦点落在拼接处", () => {
  const doc = sampleDoc();
  const r = mergeSubtitleWithPrev(doc, "b");
  assert.ok(r);
  assert.equal(subs(r.doc).length, 2);
  const merged = subs(r.doc).find((c) => c.id === "a");
  assert.equal(merged.data.text, "第一句话第二句话");
  assert.equal(merged.startMs, 0);
  assert.equal(merged.endMs, 2400);
  assert.equal(r.focusId, "a");
  assert.equal(r.caret, 4);
});

test("末尾 Delete：与下一条合并，中间的真空被吸收，焦点留在拼接处", () => {
  const doc = sampleDoc();
  const r = mergeSubtitleWithNext(doc, "b");
  assert.ok(r);
  assert.equal(subs(r.doc).length, 2);
  const merged = subs(r.doc).find((c) => c.id === "b");
  assert.equal(merged.data.text, "第二句话第三句话");
  assert.equal(merged.startMs, 1200);
  assert.equal(merged.endMs, 4000);
  assert.equal(r.caret, 4);
});

test("第一条没有上一条、最后一条没有下一条时返回 null", () => {
  const doc = sampleDoc();
  assert.equal(mergeSubtitleWithPrev(doc, "a"), null);
  assert.equal(mergeSubtitleWithNext(doc, "c"), null);
  assert.equal(mergeSubtitleWithPrev(doc, "不存在"), null);
});

test("查找替换：大小写、正则元字符、多处计数与替换全部", () => {
  const doc = sampleDoc();
  subs(doc)[0].data.text = "A.B a.b A.B";
  assert.equal(countMatches(doc, "A.B", true), 2);
  assert.equal(countMatches(doc, "a.b", false), 3);
  assert.equal(countMatches(doc, "", false), 0);

  const r = replaceSubtitleText(doc, "A.B", "X", true);
  assert.equal(r.count, 2);
  assert.equal(textAt(r.doc, "a"), "X a.b X");
  // 原文档不被改动
  assert.equal(textAt(doc, "a"), "A.B a.b A.B");

  const loose = replaceSubtitleText(doc, "a.b", "Y", false);
  assert.equal(loose.count, 3);
  assert.equal(textAt(loose.doc, "a"), "Y Y Y");
});

test("查找替换：没有匹配时不产生新文档，也不占撤销栈", () => {
  const doc = sampleDoc();
  const r = replaceSubtitleText(doc, "没有这个词", "X", false);
  assert.equal(r.count, 0);
  assert.equal(r.doc, doc);
});

test("播放高亮：只高亮播放头所在区间的那一条，间隙与末尾不高亮", () => {
  const doc = sampleDoc();
  assert.equal(activeSubtitleId(doc, 0), "a");
  assert.equal(activeSubtitleId(doc, 1199), "a");
  assert.equal(activeSubtitleId(doc, 1200), "b");
  assert.equal(activeSubtitleId(doc, 2500), null);
  assert.equal(activeSubtitleId(doc, 4000), null);
});

/** 八条字幕、自动旋转（随机间隔），用固定 rng 让计划可预测 */
function eightDoc(mode = "auto", interval = 0) {
  const doc = createEmptyDocument("旋转测试");
  doc.settings.rotationMode = mode;
  doc.settings.rotationInterval = interval;
  const clips = [];
  for (let i = 0; i < 8; i++) {
    clips.push({ id: `s${i}`, kind: "subtitle", startMs: i * 1000, endMs: (i + 1) * 1000, data: { text: `句${i}` } });
  }
  doc.tracks.push({ id: "t", kind: "subtitle", clips });
  return doc;
}

test("applyRotationPlan：按当前旋转设置把 moveAnimation 写回每条字幕（固定 rng 可预测）", () => {
  // rng=()=>0 ⇒ 间隔恒 3，首条之后第 3、6 条插入旋转，末条不旋转
  const doc = eightDoc("auto", 0);
  const r = applyRotationPlan(doc, () => 0);
  const got = subs(r).sort((a, b) => a.startMs - b.startMs).map((c) => c.data.moveAnimation);
  assert.deepEqual(got, ["up", "up", "up", "clockwise90", "up", "up", "clockwise90", "up"]);
  // 只改 moveAnimation，不动文本
  assert.equal(subs(r).find((c) => c.id === "s0").data.text, "句0");
  // 原文档不被改动
  assert.equal(subs(doc).find((c) => c.id === "s0").data.moveAnimation, undefined);
});

test("applyRotationPlan：旋转关闭时全部归位为 up", () => {
  const doc = eightDoc("off", 0);
  const r = applyRotationPlan(doc, () => 0);
  const got = subs(r).map((c) => c.data.moveAnimation);
  assert.ok(got.every((m) => m === "up"));
});

test("applyRotationPlan：固定间隔（interval>0）忽略随机数，间隔确定", () => {
  const doc = eightDoc("auto", 2);
  const r = applyRotationPlan(doc, Math.random); // 即便用真随机也应确定
  const got = subs(r).sort((a, b) => a.startMs - b.startMs).map((c) => c.data.moveAnimation);
  // 间隔 2：索引 0,1 up；2 旋转；3 是末条不旋转 → up
  assert.equal(got[0], "up");
  assert.equal(got[1], "up");
  assert.notEqual(got[2], "up");
  assert.equal(got[3], "up");
});

test("拆分字幕后旋转计划被重新套用：识别 2 条拆成 5 条也会自动插旋转", () => {
  // 模拟「识别生成 2 条 → 手动拆成 5 条」：左条拆两次（链式取 focusId）、右条拆一次
  const doc = createEmptyDocument("拆分旋转");
  doc.settings.rotationMode = "auto";
  doc.settings.rotationInterval = 2; // 固定间隔，结果确定
  doc.tracks.push({
    id: "t",
    kind: "subtitle",
    clips: [
      { id: "a", kind: "subtitle", startMs: 0, endMs: 2000, data: { text: "第一句很长" } },
      { id: "b", kind: "subtitle", startMs: 2000, endMs: 4000, data: { text: "第二句也很长" } },
    ],
  });
  const r1 = splitSubtitleAt(doc, "a", 2);
  assert.ok(r1, "拆 a 应成功");
  const r2 = splitSubtitleAt(r1.doc, r1.focusId, 2); // 拆 a 的右段
  assert.ok(r2, "拆 a 右段应成功");
  const r3 = splitSubtitleAt(r2.doc, "b", 2); // 拆 b
  assert.ok(r3, "拆 b 应成功");

  const clips = subs(r3.doc).sort((a, b) => a.startMs - b.startMs);
  assert.equal(clips.length, 5, "应拆成 5 条");
  // 若拆分没套用旋转，所有 moveAnimation 都是 "up"；套用后固定间隔 2 ⇒ 仅索引 2 落在旋转位
  // （循环 i=2 后 i+=2→4，4<count-1 不成立，索引 3、4 均不旋转）
  const anims = clips.map((c) => c.data.moveAnimation);
  assert.equal(anims[0], "up");
  assert.equal(anims[1], "up");
  assert.notEqual(anims[2], "up", "索引 2 应被旋转（证明拆分后重排了旋转计划）");
  assert.equal(anims[3], "up");
  assert.equal(anims[4], "up", "末条不旋转（L 组锚点）");
});
