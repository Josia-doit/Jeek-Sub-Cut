import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createEmptyDocument, addClip, addTrack } from "@jeek/core";
import {
  createFrameRenderProvider,
  validateRenderRequest,
  visibleClipsAt,
} from "@jeek/engine";
import { startRenderService } from "@jeek/render-service";

const makeDoc = () => {
  let doc = addTrack(createEmptyDocument(), "subtitle", "字幕轨");
  doc = addClip(doc, doc.tracks[0].id, {
    kind: "subtitle", startMs: 0, endMs: 1000, data: { text: "第一句" },
  });
  return doc;
};

const makeRequest = (overrides = {}) => ({
  requestId: "req_test",
  document: makeDoc(),
  fromMs: 0,
  toMs: 1000,
  fps: 30,
  width: 2560,
  height: 1440,
  ...overrides,
});

test("渲染契约：非法请求被拦下并给出原因", () => {
  assert.match(validateRenderRequest(makeRequest({ requestId: "" })), /requestId/);
  assert.match(validateRenderRequest(makeRequest({ fps: 0 })), /帧率/);
  assert.match(validateRenderRequest(makeRequest({ toMs: 0 })), /区间/);
  assert.match(validateRenderRequest(makeRequest({ width: 0 })), /尺寸/);
  assert.equal(validateRenderRequest(makeRequest()), null);
});

test("时间轴求值：某一时刻只返回覆盖该时刻的片段", () => {
  const req = makeRequest();
  assert.equal(visibleClipsAt(req, 500).length, 1);
  assert.equal(visibleClipsAt(req, 1500).length, 0);
  assert.equal(visibleClipsAt(req, 0)[0].data.text, "第一句");
});

test("帧求值：同参数结果确定，不同时间产生不同帧", async () => {
  const provider = createFrameRenderProvider();
  const req = makeRequest();
  const a = await provider.renderFrame(req, 0);
  const b = await provider.renderFrame(req, 0);
  const c = await provider.renderFrame(req, 500);
  assert.equal(a.checksum, b.checksum);
  assert.notEqual(a.checksum, c.checksum);
  assert.equal(a.width, 2560);
  assert.equal(a.height, 1440);
});

test("渲染区间：帧数、进度回调与完成标志", async () => {
  const provider = createFrameRenderProvider();
  const progress = [];
  const result = await provider.renderRange(makeRequest(), (p) => progress.push(p));
  assert.equal(result.ok, true);
  assert.equal(result.frames, 30);
  assert.equal(progress.length, 30);
  assert.equal(progress.at(-1).done, true);
  assert.equal(progress.at(-1).renderedFrames, 30);
});

test("取消渲染：立即中止且不报成功", async () => {
  const provider = createFrameRenderProvider();
  provider.cancel("req_test");
  const result = await provider.renderRange(makeRequest());
  assert.equal(result.ok, false);
  assert.equal(result.frames, 0);
  assert.match(result.error, /取消/);
});

/* 最小闭环：编辑器 → HTTP 契约 → 渲染服务 → 内核数据文档 */
let service;
after(async () => {
  if (service) await service.close();
});

test("端到端最小闭环：健康检查 + 一次真实渲染请求", async () => {
  service = await startRenderService({ port: 0 });
  assert.ok(service.port > 0);

  const health = await fetch(`${service.url}/api/v1/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.provider, "frame-programmatic");

  const response = await fetch(`${service.url}/api/v1/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeRequest({ toMs: 500 })),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.frames, 15);

  const bad = await fetch(`${service.url}/api/v1/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "不是 JSON",
  });
  assert.equal(bad.status, 400);
});
