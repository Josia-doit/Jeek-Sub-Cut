import type { JeekModule } from "@jeek/contracts";

/**
 * 唯一模块清单：启用 / 停用 / 新增功能只改这个文件。
 * 其余源码、内核、其它功能模块都不需要改动 —— 模块之间本来就不互相引用。
 */
export const MODULE_LOADERS: Array<() => Promise<Record<string, unknown>>> = [
  () => import("@jeek/feature-timeline"),
  () => import("@jeek/feature-subtitles"),
  () => import("@jeek/feature-preview"),
  () => import("@jeek/feature-audio"),
  () => import("@jeek/feature-asr"),
  () => import("@jeek/feature-export"),
];

export const isModule = (value: unknown): value is JeekModule =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as JeekModule).id === "string" &&
  typeof (value as JeekModule).activate === "function";

export const pickModules = (namespace: Record<string, unknown>): JeekModule[] =>
  Object.values(namespace).filter(isModule);

/** 命令工厂同样走清单：模块停用时界面自动降级 */
export const loadAddSubtitleCommand = () =>
  import("@jeek/feature-subtitles").then((module) => module.addSubtitleCommand);

export const loadImportSubtitlesCommand = () =>
  import("@jeek/feature-subtitles").then((module) => module.importSubtitlesCommand);

export const loadAsrSplit = () => import("@jeek/feature-asr");
