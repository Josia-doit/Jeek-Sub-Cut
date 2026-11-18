import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMovePlan } from "@jeek/core";

test("旋转计划：关闭或不足 3 条时不插旋转", () => {
  assert.deepEqual(buildMovePlan(9, "off", 0, () => 0), new Array(9).fill("up"));
  assert.deepEqual(buildMovePlan(2, "auto", 0, () => 0), ["up", "up"]);
  assert.equal(buildMovePlan(9, "auto", 0, () => 0).length, 9);
});

test("旋转计划：交替模式按顺逆交替，间隔滑块固定步长", () => {
  const plan = buildMovePlan(9, "alternate", 2, () => 0);
  assert.deepEqual(plan, [
    "up", "up", "clockwise90", "up", "counterclockwise90",
    "up", "clockwise90", "up", "up",
  ]);
});

test("旋转计划：自动模式首条之后 3~5 条来第一次，之后每 3~5 条一次", () => {
  const plan = buildMovePlan(8, "auto", 0, () => 0);
  assert.deepEqual(plan, [
    "up", "up", "up", "clockwise90",
    "up", "up", "clockwise90", "up",
  ]);
  const valid = new Set(["up", "clockwise90", "counterclockwise90"]);
  for (const p of buildMovePlan(30, "auto", 0)) assert.ok(valid.has(p));
});
