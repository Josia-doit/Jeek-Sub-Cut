import { snapRangeValue } from "@jeek/core";

/**
 * 全局 Alt 状态：拖动任意滑块时按住 Alt，可临时关掉吸附做细调。
 * 用捕获监听，避免输入框把按键吞掉；窗口失焦 / 页面隐藏时清零，防止粘住。
 */
let altHeld = false;
if (typeof window !== "undefined") {
  const reset = () => { altHeld = false; };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" || e.altKey) altHeld = true;
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" || !e.altKey) reset();
  }, true);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) reset();
  });
}

export function isAltHeld(): boolean {
  return altHeld;
}

/** range 的 onChange 里直接替换 Number(e.target.value)，自动读出 min/max/step 并吸附 */
export function snappedRangeValue(e: { currentTarget: HTMLInputElement }): number {
  const el = e.currentTarget;
  const raw = Number(el.value);
  const min = el.min === "" ? -Infinity : Number(el.min);
  const max = el.max === "" ? Infinity : Number(el.max);
  const step = el.step === "" || el.step === "any" ? 1 : Number(el.step);
  return snapRangeValue(raw, min, max, step, isAltHeld());
}
