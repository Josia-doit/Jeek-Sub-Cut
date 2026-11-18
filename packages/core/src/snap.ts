/**
 * 滑块轻吸附：与「字幕位置」滑块同手感 —— 每 10 个刻度一个吸附点，
 * 只有落进 1 个刻度内才吸，既能轻松选中整十值，又不会卡住相邻档位。
 * 纯数值，供 node:test 单测；浏览器侧的 Alt 状态在 apps/editor/lib 里判定。
 */

/** 吸附点间隔 = 10 个 step，容差 = 1 个 step；bypass 为真时原样返回 */
export function snapRangeValue(
  raw: number,
  min: number,
  max: number,
  step = 1,
  bypass = false,
): number {
  if (bypass || !Number.isFinite(raw)) return raw;
  const s = Math.abs(step) > 0 ? Math.abs(step) : 1;
  // 端点保持原值：最左的 -∞ 静音档、满格、最小缩放都不能被吸走
  if (raw <= min || raw >= max) return raw;
  const tick = s * 10;
  const near = Math.round(raw / tick) * tick;
  if (Math.abs(raw - near) > s + 1e-9) return raw;
  return Math.max(min, Math.min(max, Number(near.toFixed(6))));
}
