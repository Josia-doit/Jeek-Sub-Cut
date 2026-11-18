import { test } from "node:test";
import assert from "node:assert/strict";
import { snapRangeValue } from "@jeek/core";

test("每 10 档轻吸附：容差 1 内吸到整十，容差外原样保留", () => {
  assert.equal(snapRangeValue(9, 0, 100, 1), 10);
  assert.equal(snapRangeValue(11, 0, 100, 1), 10);
  assert.equal(snapRangeValue(12, 0, 100, 1), 12);
  assert.equal(snapRangeValue(49, 0, 100, 1), 50);
  assert.equal(snapRangeValue(53, 0, 100, 1), 53);
  assert.equal(snapRangeValue(0, 0, 100, 1), 0);
  assert.equal(snapRangeValue(100, 0, 100, 1), 100);
});

test("增益滑块：左右各 30 档，每 10 档吸附，最左 -∞ 静音哨兵不被吸走", () => {
  assert.equal(snapRangeValue(-9, -31, 30, 1), -10);
  assert.equal(snapRangeValue(9, -31, 30, 1), 10);
  assert.equal(snapRangeValue(-19, -31, 30, 1), -20);
  assert.equal(snapRangeValue(21, -31, 30, 1), 20);
  assert.equal(snapRangeValue(3, -31, 30, 1), 3);
  assert.equal(snapRangeValue(-31, -31, 30, 1), -31, "-∞ 静音端点必须可达");
  assert.equal(snapRangeValue(30, -31, 30, 1), 30);
});

test("按住 Alt（bypass）时完全不吸附", () => {
  assert.equal(snapRangeValue(9, 0, 100, 1, true), 9);
  assert.equal(snapRangeValue(-9, -31, 30, 1, true), -9);
});

test("细步长滑块按自身 step 缩放吸附间隔与容差", () => {
  // 单句最长时长：2~8 秒、0.5 秒一档 → 每 5 秒一个吸附点
  assert.equal(snapRangeValue(5.5, 2, 8, 0.5), 5);
  assert.equal(snapRangeValue(6, 2, 8, 0.5), 6);
  // 时间轴缩放：0.05 一档 → 每 0.5 一个吸附点
  assert.equal(snapRangeValue(1.49, 1, 20, 0.05), 1.5);
  assert.equal(snapRangeValue(1.4, 1, 20, 0.05), 1.4);
  // 入场时长：50ms 一档 → 每 500ms 一个吸附点
  assert.equal(snapRangeValue(480, 200, 1500, 50), 500);
  assert.equal(snapRangeValue(350, 200, 1500, 50), 350);
});

test("端点与非数值兜底", () => {
  assert.equal(snapRangeValue(200, 200, 1500, 50), 200);
  assert.equal(snapRangeValue(1500, 200, 1500, 50), 1500);
  assert.ok(Number.isNaN(snapRangeValue(NaN, 0, 100, 1)));
  assert.equal(snapRangeValue(9, 0, 100, 0), 10, "step 非法时退回 1");
});
