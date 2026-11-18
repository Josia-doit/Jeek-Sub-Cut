#!/usr/bin/env node
/**
 * 架构边界检查：零依赖，扫描 packages/ 与 apps/ 的所有源码 import，
 * 强制「依赖只朝下、功能包彼此不认识、跨包只用公共出口、依赖必须声明」。
 *
 * 规则随仓库走，用户机器上不需要安装任何 lint 工具。
 *   node tools/check-boundaries.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_EXT = /\.(ts|tsx|js|mjs)$/;
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

/* 层级：数字越小越底层。依赖只允许从大数字指向小数字 */
const levelOfPath = (rel) => {
  if (rel.startsWith("packages/contracts/")) return 0;
  if (rel.startsWith("packages/core/")) return 1;
  if (rel.startsWith("packages/engine/")) return 2;
  if (rel.startsWith("packages/features/")) return 3;
  if (rel.startsWith("apps/")) return 4;
  return -1;
};

const PACKAGE_LEVELS = {
  "@jeek/contracts": 0,
  "@jeek/core": 1,
  "@jeek/engine": 2,
  "@jeek/editor": 4,
  "@jeek/render-service": 4,
  "@jeek/desktop": 4,
};

const levelOfPackage = (name) => {
  if (Object.prototype.hasOwnProperty.call(PACKAGE_LEVELS, name)) return PACKAGE_LEVELS[name];
  if (name.startsWith("@jeek/feature-")) return 3;
  return null;
};

const packageDirOf = (rel) => {
  const parts = rel.split(/[\\/]/);
  if (parts[0] === "packages" && parts[1] === "features") return parts.slice(0, 3).join("/");
  if (parts[0] === "packages" || parts[0] === "apps") return parts.slice(0, 2).join("/");
  return null;
};

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "dist" || name === "node_modules") continue;
      walk(full, out);
    } else if (SRC_EXT.test(name)) {
      out.push(full);
    }
  }
  return out;
};

const declaredCache = new Map();
const declaredOf = (pkgDir) => {
  if (declaredCache.has(pkgDir)) return declaredCache.get(pkgDir);
  const manifest = join(ROOT, pkgDir, "package.json");
  const set = new Set();
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(pkg[key] ?? {})) set.add(dep);
    }
  }
  declaredCache.set(pkgDir, set);
  return set;
};

const files = [...walk(join(ROOT, "packages")), ...walk(join(ROOT, "apps"))];
const violations = [];
let crossPackageImports = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const sourceLevel = levelOfPath(rel);
  if (sourceLevel < 0) continue;
  const pkgDir = packageDirOf(rel);
  if (!pkgDir) continue;
  const declared = declaredOf(pkgDir);
  const source = readFileSync(file, "utf8");

  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec.startsWith("@jeek/")) continue;
    crossPackageImports += 1;

    if (/^@jeek\/[^/]+\/(?:src|dist)\//.test(spec)) {
      violations.push(`${rel}: 禁止深路径导入 ${spec}（只能用包公共出口）`);
      continue;
    }

    const pkgName = spec.split("/").slice(0, 2).join("/");
    const targetLevel = levelOfPackage(pkgName);
    if (targetLevel === null) {
      violations.push(`${rel}: 未知包 ${pkgName}`);
      continue;
    }
    if (targetLevel > sourceLevel) {
      violations.push(`${rel}: 反向依赖 ${pkgName}（L${sourceLevel} → L${targetLevel}）`);
    }
    if (targetLevel === 3 && sourceLevel === 3) {
      violations.push(`${rel}: 功能包之间禁止互引 ${pkgName}`);
    }
    if (!declared.has(pkgName)) {
      violations.push(`${rel}: import 了 ${pkgName}，但 ${pkgDir}/package.json 未声明`);
    }
  }
}

const checks = [
  ["依赖方向单向", violations.filter((v) => v.includes("反向依赖")).length],
  ["功能包无互引", violations.filter((v) => v.includes("禁止互引")).length],
  ["无深路径导入", violations.filter((v) => v.includes("深路径")).length],
  ["依赖均已声明", violations.filter((v) => v.includes("未声明") || v.includes("未知包")).length],
];

console.log(`边界检查：扫描 ${files.length} 个源文件，${crossPackageImports} 条跨包引用`);
for (const [name, count] of checks) {
  console.log(`  ${count === 0 ? "✔" : "✘"} ${name}：${count === 0 ? "通过" : `${count} 条违规`}`);
}
if (violations.length) {
  for (const v of violations) console.log(`    - ${v}`);
  console.error(`\n共 ${violations.length} 条违规，架构边界被破坏`);
  process.exit(1);
}
console.log("共 0 条违规 ✔");
