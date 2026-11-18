#!/usr/bin/env node
/** 清理各包构建产物，零依赖。用于「干净环境重跑构建」验证。 */
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "packages/contracts",
  "packages/core",
  "packages/engine",
  "packages/features/timeline",
  "packages/features/subtitles",
  "apps/editor",
];

let removed = 0;
const drop = (p) => {
  if (!existsSync(p)) return;
  rmSync(p, { recursive: true, force: true });
  removed += 1;
};

for (const dir of targets) {
  const full = join(ROOT, dir);
  drop(join(full, "dist"));
  if (!existsSync(full)) continue;
  for (const f of readdirSync(full)) {
    if (f.endsWith(".tsbuildinfo")) drop(join(full, f));
  }
}
console.log(`已清理 ${removed} 项构建产物`);
