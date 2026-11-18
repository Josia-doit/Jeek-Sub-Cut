/**
 * 字幕旋转计划：在生成一批字幕时决定哪几条带 ↺/↻，之后写进每条字幕的
 * moveAnimation 固定下来，逐帧求值不再随机 —— 预览与导出才能拿到同一画面。
 *
 * 规则：不足 3 条或关闭时不插旋转；首条之后 3~5 条来第一次，之后每 3~5 条
 * 一次（=「旋转间隔：随机 3~5 条」，同时适用于随机旋转与交替旋转）；
 * 「交替」按顺逆交替，其余（随机旋转）方向不固定。
 */
export type MoveAnimation = "up" | "clockwise90" | "counterclockwise90";

export function buildMovePlan(
  count: number,
  mode: string,
  every = 0,
  random: () => number = Math.random,
): MoveAnimation[] {
  const out: MoveAnimation[] = new Array(Math.max(0, Math.floor(count))).fill("up");
  if (mode === "off" || count < 3) return out;
  const fixed = every > 0 ? Math.max(2, Math.round(every)) : 0;
  // 随机间隔（every=0）时为 3~5 条；固定间隔时直接用 fixed
  const gap = (): number => fixed || 3 + Math.floor(3 * random());
  let i = fixed || 3 + Math.floor(3 * random());
  let flip = 0;
  while (i < count - 1) {
    out[i] =
      mode === "alternate"
        ? flip++ % 2 === 0
          ? "clockwise90"
          : "counterclockwise90"
        : random() < 0.5
          ? "clockwise90"
          : "counterclockwise90";
    i += gap();
  }
  return out;
}
