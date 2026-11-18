import { test } from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createEmptyDocument } from "@jeek/core";
import {
  evaluateFrame,
  paintFrame,
  STACK_GAP,
  TEXT_RIGHT_PADDING,
  wrapText,
} from "@jeek/engine";

/** 只记录实际写进 canvas 的指令，用来验证字形与打字机的真实绘制行为 */
function recordingCtx() {
  const calls = { fillText: [], strokes: [] };
  let from = null;
  return {
    calls,
    font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "",
    lineWidth: 1, globalAlpha: 1, filter: "", shadowColor: "", shadowBlur: 0, shadowOffsetY: 0,
    save() {}, restore() {}, clearRect() {}, fillRect() {}, translate() {}, rotate() {}, scale() {},
    drawImage() {},
    measureText(text) {
      const size = Number((String(this.font).match(/([\d.]+)px/)?.[1]) || 60);
      return { width: [...text].length * size };
    },
    fillText(text, x, y) { calls.fillText.push({ text, x, y, align: this.textAlign, font: this.font }); },
    beginPath() {}, moveTo(x, y) { from = { x, y }; },
    lineTo(x, y) { if (from) calls.strokes.push({ from, to: { x, y } }); },
    stroke() {},
  };
}

/** 逻辑短边 1440 的旧版画布（2560×1440），字号固定 60 便于精确断言 */
const makeDoc = (clips, overrides = {}) => {
  let doc = {
    ...createEmptyDocument("视觉基线"),
    video: { width: 2560, height: 1440, fps: 30 },
  };
  doc = addTrack(doc, "subtitle", "字幕轨");
  for (const c of clips) {
    doc = addClip(doc, doc.tracks[0].id, {
      kind: "subtitle",
      startMs: c[0],
      endMs: c[1],
      data: { text: c[2] ?? "字", ...(c[3] ?? {}) },
    });
  }
  return {
    ...doc,
    settings: {
      ...doc.settings,
      fontSize: 60,
      subtitleX: 30,
      subtitleY: 40,
      enterAnimation: "无",
      // 旧版 0.2s 入场窗口是本组基线的固定口径，与界面默认时长无关
      enterDurationMs: 200,
      ...overrides,
    },
  };
};

test("入场动效：15 种旧版关键帧在第 0 帧的端点值逐条一致", () => {
  const expectations = [
    ["none", (l) => l.opacity === 1 && l.scale === 1 && l.dy === 0 && l.blur === 0],
    ["fadeIn", (l) => l.opacity === 0 && l.scale === 1],
    ["slideUp", (l) => l.opacity === 0 && l.dy === 75],
    ["slideLeft", (l) => l.opacity === 0 && l.dx === 110],
    ["scale", (l) => l.scale === 0.15],
    ["pop", (l) => l.scale === 0.4 && l.dy === 28],
    ["bounceUp", (l) => l.scale === 0.85 && l.dy === 150],
    ["blurIn", (l) => l.scale === 1.12 && l.blur === 28],
    ["swingIn", (l) => l.dx === -55 && l.dy === 18 && l.rotation === -26],
    ["typewriter", (l) => l.opacity === 1 && l.visibleChars === 0],
    ["dropIn", (l) => l.dy === -200 && l.scale === 1],
    ["rotateIn", (l) => l.scale === 0.55 && l.dx === -40 && l.rotation === -130],
    ["zoomOut", (l) => l.opacity === 0 && l.scale === 3.4 && l.blur === 10],
    ["elasticPop", (l) => l.scale === 0 && l.dy === 20],
    ["riseFade", (l) => l.dy === 55 && l.blur === 16],
  ];
  for (const [name, check] of expectations) {
    const doc = makeDoc([[0, 1000, "测试"]], { enterAnimation: name });
    const layer = evaluateFrame(doc, 0).layers[0];
    assert.ok(check(layer), `${name} 的第 0 帧关键帧不对：${JSON.stringify(layer)}`);
  }
});

test("入场动效：越过 0.2s 窗口后全部回到稳定态", () => {
  for (const name of ["fadeIn", "slideUp", "scale", "pop", "bounceUp", "blurIn", "swingIn", "dropIn", "rotateIn", "zoomOut", "elasticPop", "riseFade"]) {
    const doc = makeDoc([[0, 1000, "测试"]], { enterAnimation: name });
    const l = evaluateFrame(doc, 500).layers[0];
    assert.equal(l.opacity, 1, name);
    assert.equal(l.scale, 1, name);
    assert.equal(l.dx, 0, name);
    assert.equal(l.dy, 0, name);
    assert.equal(l.rotation, 0, name);
    assert.equal(l.blur, 0, name);
  }
});

test("入场时长：拉长后过渡窗口同步变长，动效在更久之后仍在推进", () => {
  // 单条 3s，保证 1.2s 的动画窗口能完整走完（字幕比动画短时本来就会被切掉）
  const short = makeDoc([[0, 3000, "测试"]], { enterAnimation: "上滑入", enterDurationMs: 200 });
  const long = makeDoc([[0, 3000, "测试"]], { enterAnimation: "上滑入", enterDurationMs: 1200 });
  assert.equal(evaluateFrame(short, 0).layers[0].dy, 75, "起点关键帧不受时长影响");
  assert.equal(evaluateFrame(long, 0).layers[0].dy, 75, "起点关键帧不受时长影响");
  assert.equal(evaluateFrame(short, 300).layers[0].dy, 0, "0.2s 窗口在 300ms 时已稳定");
  assert.ok(evaluateFrame(long, 300).layers[0].dy > 0, "1.2s 窗口在 300ms 时仍有位移");
  assert.equal(evaluateFrame(long, 1500).layers[0].dy, 0, "拉长后最终仍回到稳定态");
});

test("瀑布流：7 条字幕只留 5 条历史层，逐层按行高+16 向上累加", () => {
  const clips = Array.from({ length: 7 }, (_, i) => [i * 1000, (i + 1) * 1000, `第${i + 1}句`]);
  const doc = makeDoc(clips);
  const stable = evaluateFrame(doc, 6500);
  assert.equal(stable.layers.length, 6, "当前句 + 5 条历史层");
  for (let n = 1; n < 6; n += 1) {
    assert.equal(stable.layers[n].bottom, n * (60 + 14 + STACK_GAP), `第 ${n} 层底边偏移`);
    assert.equal(stable.layers[n].opacity, 1, "历史层不淡化");
    assert.equal(stable.layers[n].scale, 1, "历史层不缩小");
    assert.equal(stable.layers[n].rotation, 0, "历史层不自转");
  }

  // 换句瞬间：第一层的位移随 0.25s spring 从 0 长出来，其余层保持满偏移
  const entering = evaluateFrame(doc, 6010);
  assert.ok(entering.layers[1].bottom > 0 && entering.layers[1].bottom < 90);
  assert.equal(entering.layers[2].bottom, entering.layers[1].bottom + 90);
});

test("L 型旋转：整组绕文字端点转 90°，第二个拐角截断", () => {
  const clips = [
    [0, 1000, "一", { moveAnimation: "clockwise90" }],
    [1000, 2000, "二"],
    [2000, 3000, "三", { moveAnimation: "counterclockwise90" }],
    [3000, 4000, "四"],
  ];
  const doc = makeDoc(clips);
  const stable = evaluateFrame(doc, 3500);
  assert.equal(stable.layers.length, 3, "更早的第二次旋转被截断");
  assert.equal(stable.rotationGroups.length, 1);
  const group = stable.rotationGroups[0];
  assert.equal(group.rotation, -90);
  assert.equal(group.layers.length, 2, "旋转点连同它上面那一层整块转");
  assert.ok(stable.layers[0].opacity === 1, "A/B 配对旋转时新句不走自己的入场");
  assert.equal(stable.layers[0].align, "left", "逆时针之后左对齐");

  // 刚换句的过渡帧：拐角角度与配对旋转同步插值，两者之和保持 90° 夹角
  const during = evaluateFrame(doc, 3050);
  const g = during.rotationGroups[0];
  assert.ok(g.rotation < 0 && g.rotation > -90, "拐角还在转");
  assert.ok(during.layers[0].rotation > 0, "新句以相同角速度反向转回来");
  assert.ok(Math.abs(Math.abs(g.rotation) + Math.abs(during.layers[0].rotation) - 90) < 1e-6);
});

test("屏幕适配：只按当前句取景，宽高谁先触到按谁算；其它风格不缩放", () => {
  const fit = evaluateFrame(makeDoc([[0, 1000, "短句"]], { subtitleStyle: "fit" }), 500);
  // 文字宽 2×0.95×60=114，行高 74；高度先触到：1440×0.8/74
  assert.ok(Math.abs(fit.fit.scale - (1440 * 0.8) / 74) < 1e-9);
  assert.equal(fit.layers[0].fontSize, 60, "适配不改变基础字号，只缩放画面");

  const custom = evaluateFrame(makeDoc([[0, 1000, "短句"]], { subtitleStyle: "custom" }), 500);
  assert.deepEqual(custom.fit, { scale: 1, tx: 0, ty: 0 });

  const fill = evaluateFrame(makeDoc([[0, 1000, "短句"]], { subtitleStyle: "fill" }), 500);
  assert.equal(fill.layers[0].fontSize, 600, "铺满模式反推字号后夹在 24..600");
  assert.equal(fill.layers[0].lineHeight, 614, "行高 = 字号 + 14");
});

test("屏幕适配：每句出现时镜头都按该句重新取景，当前句文字占画面 fitRatio", () => {
  const doc = makeDoc([
    [0, 2000, "第一句字幕完整可见测试文字"],
    [2000, 4000, "我是吉客"],
  ], { subtitleStyle: "fit" });
  const first = evaluateFrame(doc, 1000);
  const second = evaluateFrame(doc, 3000);
  // 第一句期间按第一句取景；更短的第二句出现后镜头放大（同一段画面里文字占比回到 80%）
  assert.ok(first.fit.scale > 1 && second.fit.scale > first.fit.scale,
    `短句更窄，镜头应放大：${first.fit.scale} → ${second.fit.scale}`);
  const ratio = (second.layers[0].textWidth * second.fit.scale) / 2560;
  assert.ok(Math.abs(ratio - 0.8) < 0.01, `当前句文字占画面宽应回到 80%，实际 ${ratio}`);
  // 历史句按同一比例变换，出画即被裁掉（既定观感）：第一句此时应是历史层
  assert.equal(second.layers[1].text, "第一句字幕完整可见测试文字");
  assert.equal(second.layers[1].depth, 1);
});

test("锚点与右留白：容器左缘 30%、距底 40%、右侧留 48", () => {
  const f = evaluateFrame(makeDoc([[0, 1000, "字"]]), 500);
  assert.equal(f.anchor.left, 2560 * 0.3);
  assert.equal(f.anchor.bottom, 1440 * 0.4);
  assert.equal(f.anchor.maxTextWidth, 2560 * 0.7 - TEXT_RIGHT_PADDING);
  assert.equal(f.anchor.maxTextWidth, 2560 - 768 - 48);
});

test("打字机：0.4s 逐字露出，不是按整句时长均分", () => {
  const doc = makeDoc([[0, 1000, "一二三四五六七八"]], { enterAnimation: "typewriter" });
  assert.equal(evaluateFrame(doc, 0).layers[0].visibleChars, 0);
  assert.equal(evaluateFrame(doc, 200).layers[0].visibleChars, 4);
  assert.equal(evaluateFrame(doc, 400).layers[0].visibleChars, 8);
  assert.equal(evaluateFrame(doc, 700).layers[0].visibleChars, 8, "越过窗口夹在整句长度");
});

test("折行：中文按字宽、英数按半角折算；画面本身不折行", () => {
  assert.equal(wrapText("一二三四五六七", 4).length, 2);
  assert.equal(wrapText("abcdefghij", 4).length, 2);
  const f = evaluateFrame(makeDoc([[0, 1000, "一二三四五六七八九十"]]), 500);
  assert.equal(f.layers[0].text, "一二三四五六七八九十", "旧版 whiteSpace:nowrap，画面不拆行");
  assert.ok(f.layers[0].textWidth <= f.anchor.maxTextWidth);
});

test("打字机恒从左向右：右对齐字幕逐字露出时首字位置固定、文字逐帧变长", () => {
  // 第一条顺时针旋转让后面变成右对齐；第二条不旋转，保证第三条能走打字机
  const doc = makeDoc([
    [0, 1000, "开场", { moveAnimation: "clockwise90" }],
    [1000, 2000, "承接"],
    [2000, 4000, "一二三四五六七八"],
  ], { enterAnimation: "typewriter", subtitleStyle: "custom" });
  assert.equal(evaluateFrame(doc, 2050).layers[0].align, "right", "本条确实是右对齐");

  const shots = [2050, 2150, 2250, 2350].map((t) => {
    const ctx = recordingCtx();
    paintFrame(ctx, doc, t, 2560, 1440);
    return ctx.calls.fillText.find((c) =>
      c.align === "left" && c.text.length > 0 && c.text.length < 8
      && "一二三四五六七八".startsWith(c.text));
  });
  assert.ok(shots.every(Boolean), "打字机期间按左对齐绘制");
  assert.ok(shots[3].text.length > shots[0].text.length, "字数随时间增加");
  assert.ok(shots.every((s) => Math.abs(s.x - shots[0].x) < 1e-9),
    "首字钉在整句写完后的左端：右对齐也不会从右往左冒字");

  // 整句写完后右端仍落在右对齐锚点上，位置与旧口径一致
  const ctx = recordingCtx();
  paintFrame(ctx, doc, 3000, 2560, 1440);
  const full = ctx.calls.fillText.find((c) => c.text === "一二三四五六七八");
  const rightAnchor = ctx.calls.fillText.find((c) => c.text === "承接").x;
  assert.ok(Math.abs(full.x + 8 * 60 - rightAnchor) < 1e-6, "整句右端与右对齐锚点重合");
});

test("字形效果：默认加粗，关掉加粗并开启倾斜 / 下划线 / 删除线后如实渲染", () => {
  const base = makeDoc([[0, 1000, "测试"]], { enterAnimation: "无", subtitleStyle: "custom" });
  const plain = recordingCtx();
  paintFrame(plain, base, 500, 2560, 1440);
  assert.ok(plain.calls.fillText[0].font.startsWith("bold 60px"), "默认加粗");
  assert.equal(plain.calls.strokes.length, 0, "默认不画线");

  const styled = {
    ...base,
    settings: {
      ...base.settings,
      fontBold: false, fontItalic: true, fontUnderline: true, fontStrike: true,
    },
  };
  const ctx = recordingCtx();
  paintFrame(ctx, styled, 500, 2560, 1440);
  assert.ok(ctx.calls.fillText[0].font.startsWith("italic 60px"), "不加粗 + 倾斜");
  assert.equal(ctx.calls.strokes.length, 2, "下划线与删除线各画一条");
  const ys = ctx.calls.strokes.map((s) => s.from.y).sort((a, b) => a - b);
  assert.ok(ys[0] < ys[1], "删除线在文字中部，下划线在下方");
});

test("帧率无关：30/60fps 的稳定帧，层数、堆叠偏移与取景一致", () => {
  const clips = [[0, 1000, "第一句"], [1000, 2000, "第二句"]];
  const at = (fps) => {
    const doc = makeDoc(clips);
    return evaluateFrame({ ...doc, video: { ...doc.video, fps } }, 1500);
  };
  const a = at(30);
  const b = at(60);
  assert.equal(a.layers.length, b.layers.length);
  assert.equal(a.layers[1].bottom, b.layers[1].bottom);
  assert.equal(a.layers[0].fontSize, b.layers[0].fontSize);
  assert.ok(Math.abs(a.fit.scale - b.fit.scale) < 1e-9);
});
