/**
 * Electron 命令行入口。
 *
 * 启动器把 apps/desktop 这个目录交给 electron.exe，Electron 会按 package.json
 * 的 main 字段加载本文件。这里用 CommonJS 是刻意的：Electron 内建模块用
 * require('electron') 最稳，主进程业务逻辑再以 ESM 动态导入。
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const electron = require("electron");

// 主进程 ESM 代码从这里取 Electron 对象，绕开 ESM/CJS 互操作的版本差异
globalThis.__JEEK_ELECTRON__ = electron;

import(pathToFileURL(path.join(__dirname, "src", "main.mjs")).href)
  .then(({ bootstrap }) => bootstrap())
  .catch((error) => {
    console.error("[desktop] 启动失败：", error);
    electron.app.quit();
  });
