import { fmtTimecode } from "@jeek/core";

/**
 * 字幕文本的浏览器侧入口。
 *
 * 解析与生成都在 core（纯逻辑、可测），这里只补两件事：
 * 把生成结果落地成下载，以及界面用的帧进制时间码。
 */
export {
  buildSubtitleText,
  cuesFromDocument,
  detectFormat,
  formatStamp,
  parseStamp,
  parseSubtitleText,
  parseSubtitles,
  sortedSubtitles,
  toJson,
  toSrt,
  toTxt,
  toVtt,
  type SubtitleCue as SrtCue,
  type SubtitleFormat,
  type SubtitleParseResult,
} from "@jeek/core";

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, type = "text/plain;charset=utf-8"): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** 帧进制时间码（界面显示用），与 SRT 的毫秒时间戳区分开 */
export function timecodeOf(ms: number, fps: number): string {
  return fmtTimecode(ms, fps);
}
