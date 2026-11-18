import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const pkg = JSON.parse(read("package.json"));

test("依赖清单：结构完整、id 唯一、每个组件都有下载地址", () => {
  const deps = JSON.parse(read("install/deps.json"));
  assert.equal(deps.schema, 2);
  assert.ok(deps.components.length >= 1);
  const ids = deps.components.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "组件 id 不能重复");
  for (const c of deps.components) {
    assert.ok(
      c.target && c.target.startsWith("resources/"),
      `${c.id} 的目标必须落在 resources/`,
    );
    assert.equal(typeof c.required, "boolean");
    if (c.archive === "none") {
      assert.ok(c.files?.length, `${c.id} 必须列出文件`);
      for (const f of c.files) assert.ok(f.urls?.length, `${c.id}/${f.name} 缺少下载地址`);
    } else {
      assert.ok(c.urls?.length, `${c.id} 缺少下载地址`);
      assert.ok(c.verify, `${c.id} 缺少就绪校验文件`);
    }
  }
});

test("字体清单：不随程序分发第三方字体（避免授权问题）", () => {
  const deps = JSON.parse(read("install/deps.json"));
  assert.ok(
    !deps.components.some((c) => c.id === "fonts" || c.target === "fonts"),
    "依赖清单不能再有分发字体组件",
  );
  const catalog = read("packages/core/src/font-catalog.ts");
  assert.ok(!/export const BUNDLED_FONTS/.test(catalog), "内置字体目录不能含随程序分发字体清单");
  const desktop = read("apps/desktop/src/main.mjs");
  assert.ok(!/BUNDLED_FONT_FILES/.test(desktop), "桌面壳不能残留分发字体跳过名单");
});

test("依赖清单：Electron 是启动必需项，桌面窗口路径与启动器一致", () => {
  const deps = JSON.parse(read("install/deps.json"));
  const electron = deps.components.find((c) => c.id === "electron");
  assert.ok(electron && electron.required, "缺少必需的 electron 组件");
  assert.equal(electron.target, "resources/runtime/electron");
  assert.equal(electron.verify, "electron.exe");
  const launcher = read("tools/launch.mjs");
  assert.ok(
    launcher.includes('"resources", "runtime", "electron"'),
    "启动器必须指向清单约定的 Electron 运行时目录",
  );
  assert.ok(launcher.includes("electron.exe"), "启动器必须校验 electron.exe");
});

test("安装与启动入口：脚本、批处理、Shell 全部齐备", () => {
  for (const p of [
    "tools/install-deps.mjs",
    "tools/launch.mjs",
    "tools/smoke.mjs",
    "安装依赖.bat",
    "启动.bat",
    "install/启动.sh",
    "install/bootstrap-node.ps1",
    "apps/desktop/electron.cjs",
    "apps/desktop/src/preload.cjs",
  ]) {
    assert.ok(exists(p), `缺少 ${p}`);
  }
});

test("批处理：纯 ASCII + CRLF + 无 BOM，且指向正确的 Node 脚本", () => {
  const cases = [
    ["安装依赖.bat", "tools\\install-deps.mjs"],
    ["启动.bat", "tools\\launch.mjs"],
  ];
  for (const [name, target] of cases) {
    const buf = fs.readFileSync(path.join(ROOT, name));
    assert.notEqual(buf[0], 0xef, `${name} 不能带 BOM`);
    assert.ok(!/[^\x00-\x7f]/.test(buf.toString("latin1")), `${name} 必须纯 ASCII`);
    const text = buf.toString("latin1");
    assert.ok(text.includes("\r\n"), `${name} 必须是 CRLF`);
    assert.equal((text.match(/\n/g) ?? []).length, (text.match(/\r\n/g) ?? []).length);
    assert.ok(text.includes("chcp 65001"), `${name} 需要切换 UTF-8 代码页`);
    assert.ok(text.includes(target), `${name} 必须调用 ${target}`);
  }
});

test("新增脚本：语法可被 Node 解析", () => {
  for (const p of [
    "tools/install-deps.mjs",
    "tools/launch.mjs",
    "tools/smoke.mjs",
    "apps/desktop/electron.cjs",
    "apps/desktop/src/preload.cjs",
    "apps/desktop/src/main.mjs",
  ]) {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, p)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${p} 语法错误：${r.stderr}`);
  }
});

test("桌面壳：package.json 指向 CJS 入口，preload 路径正确", () => {
  const desktop = JSON.parse(read("apps/desktop/package.json"));
  assert.equal(desktop.main, "electron.cjs");
  const main = read("apps/desktop/src/main.mjs");
  assert.ok(main.includes("preload.cjs"), "主进程必须指向 CJS preload");
  assert.ok(!main.includes("preload.mjs"), "不能残留旧的 ESM preload");
  assert.ok(main.includes("JEEK_RENDER_URL"), "必须支持复用启动器的渲染服务");
  const entry = read("apps/desktop/electron.cjs");
  assert.ok(entry.includes('require("electron")'));
  assert.ok(entry.includes("bootstrap"), "CJS 入口必须调用主进程 bootstrap");
  assert.ok(entry.includes("main.mjs"), "CJS 入口必须加载主进程 ESM 模块");
});

test("npm scripts：一键安装与一键启动都挂在根 package.json", () => {
  for (const key of ["setup", "start", "start:browser", "start:dev", "check:deps", "check:launch", "smoke", "smoke:desktop"]) {
    assert.ok(pkg.scripts[key], `缺少 npm script ${key}`);
  }
  assert.ok(pkg.scripts.start.includes("tools/launch.mjs"));
  assert.ok(pkg.scripts.setup.includes("tools/install-deps.mjs"));
  assert.ok(pkg.scripts.test.includes("tests/bootstrap.test.mjs"));
});
