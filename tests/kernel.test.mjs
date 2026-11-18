import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "@jeek/contracts";
import {
  createCommandStack,
  createEmptyDocument,
  createEventBus,
  createModuleRegistry,
  deserializeProject,
  makeCommand,
  migrate,
  serializeProject,
} from "@jeek/core";
import { timelineModule } from "@jeek/feature-timeline";
import { subtitlesModule } from "@jeek/feature-subtitles";

const makeRegistry = () => {
  const doc = createEmptyDocument();
  const commands = createCommandStack();
  const events = createEventBus();
  const registry = createModuleRegistry({ document: () => doc, commands, events });
  return { registry, commands, events };
};

test("命令栈：撤销 / 重做 / 新操作清空重做栈", () => {
  const stack = createCommandStack();
  const a = createEmptyDocument("A");
  const b = createEmptyDocument("B");
  const c = createEmptyDocument("C");
  stack.push(makeCommand("甲", a, b));
  stack.push(makeCommand("乙", b, c));
  assert.equal(stack.size, 2);
  assert.equal(stack.undo()?.before.name, "B");
  assert.equal(stack.canRedo(), true);
  assert.equal(stack.redo()?.after.name, "C");
  stack.push(makeCommand("丙", c, a));
  assert.equal(stack.canRedo(), false);
});

test("命令栈：同类操作 350ms 内合并、栈深上限 60", () => {
  const stack = createCommandStack({ limit: 60, mergeWindowMs: 350 });
  const now = Date.now();
  const base = createEmptyDocument();
  for (let i = 0; i < 2; i++) {
    stack.push({ id: `c${i}`, label: "拖动", timestamp: now + i * 100, before: base, after: base });
  }
  assert.equal(stack.size, 1, "同类连续操作应合并");

  for (let i = 0; i < 100; i++) {
    stack.push({ id: `x${i}`, label: `操作${i}`, timestamp: now + 10000 + i * 1000, before: base, after: base });
  }
  assert.equal(stack.size, 60);
});

test("事件总线：订阅 / 退订 / 单个订阅者出错不阻断其他", () => {
  const bus = createEventBus();
  const seen = [];
  const off = bus.on("doc", (p) => seen.push(p));
  bus.on("doc", () => { throw new Error("故意抛错"); });
  bus.on("doc", (p) => seen.push(String(p) + "!"));
  bus.emit("doc", "changed");
  assert.deepEqual(seen, ["changed", "changed!"]);
  off();
  seen.length = 0;
  bus.emit("doc", "again");
  assert.deepEqual(seen, ["again!"]);
});

test("模块注册表：注册贡献点、按类型查询、整块卸载不留痕迹", async () => {
  const { registry, events } = makeRegistry();
  const activated = [];
  events.on("module:activated", (p) => activated.push(p.id));

  await registry.use(timelineModule);
  await registry.use(subtitlesModule);
  assert.equal(registry.list().length, 2);
  // 时间轴 23 个贡献点（轨道 2 / 面板 1 / 工具 9 / 命令 9 / 设置 2），字幕 6 个
  assert.equal(registry.contributions().length, 29);
  assert.equal(registry.contributions("tools").length, 9);
  assert.equal(registry.contributions()[0].moduleId, "feature.timeline");
  assert.deepEqual(activated, ["feature.timeline", "feature.subtitles"]);

  await assert.rejects(() => registry.use(timelineModule), /已注册/);

  await registry.drop("feature.timeline");
  assert.equal(registry.has("feature.timeline"), false);
  assert.equal(registry.contributions().length, 6, "卸载后该模块贡献点全部消失");
  assert.equal(registry.contributions("trackTypes").length, 0);
  assert.equal(registry.list().length, 1);
});

test("工程持久化：序列化往返、缺字段迁移、schema 升版", () => {
  const doc = createEmptyDocument("往返测试");
  const text = serializeProject(doc);
  const restored = deserializeProject(text);
  assert.equal(restored.name, "往返测试");
  assert.deepEqual(restored, doc);

  const legacy = migrate({ name: "旧工程", schemaVersion: 0, tracks: [] });
  assert.equal(legacy.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(legacy.selection, { clips: [], tracks: [] });
  assert.equal(legacy.video.fps, 30);
  assert.equal(validateOk(legacy), true);

  assert.throws(() => deserializeProject("{不是 json"), /合法 JSON/);
});

const validateOk = (doc) => {
  // 迁移后的文档必须能通过校验（间接验证补齐字段没有漏项）
  return deserializeProject(serializeProject(doc)) !== null;
};
