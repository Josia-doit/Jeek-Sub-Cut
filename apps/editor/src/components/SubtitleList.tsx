import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeSubtitleId,
  durationOf,
  mergeFontEntries,
  mergeSubtitleWithNext,
  mergeSubtitleWithPrev,
  patchClip,
  randomizeEnter,
  setSelection,
  splitSubtitleAt,
  type SubtitleEditResult,
} from "@jeek/core";
import { useEditor } from "../store";
import { sortedSubtitles } from "../lib/srt";
import { fontCnName } from "../lib/fonts";

const ENTER_OPTIONS: Array<{ value: string; icon: string }> = [
  { value: "无", icon: "—" },
  { value: "淡入", icon: "🌫" },
  { value: "上滑入", icon: "⇧" },
  { value: "左滑入", icon: "⇦" },
  { value: "缩放", icon: "⤢" },
  { value: "弹出", icon: "✧" },
  { value: "弹跳上浮", icon: "⤒" },
  { value: "模糊入", icon: "◌" },
  { value: "摆动入", icon: "↝" },
  { value: "打字机", icon: "⌨" },
  { value: "落下", icon: "⇩" },
  { value: "旋转入", icon: "↻" },
  { value: "缩小退场", icon: "⊖" },
  { value: "弹性弹出", icon: "⚡" },
  { value: "上浮淡入", icon: "↑" },
];

/** 旧工程 / 随机样式写进字幕里的英文入场枚举，列表下拉统一按中文名显示 */
const LEGACY_ENTER_CN: Record<string, string> = {
  none: "无",
  fadeIn: "淡入",
  slideUp: "上滑入",
  slideLeft: "左滑入",
  scale: "缩放",
  pop: "弹出",
  bounceUp: "弹跳上浮",
  blurIn: "模糊入",
  swingIn: "摆动入",
  typewriter: "打字机",
  dropIn: "落下",
  rotateIn: "旋转入",
  zoomOut: "缩小退场",
  elasticPop: "弹性弹出",
  riseFade: "上浮淡入",
};

/**
 * 每条字幕真正生效的移动方式：普通上移，或整句顺时针 / 逆时针转 90°。
 * 数据存 clip.data.moveAnimation，逐帧求值靠它决定旋转方向；旧的 clip.data.motion
 * 只是存进图层、渲染时并不消费，不能拿它当显示来源。
 */
const MOVE_OPTIONS: Array<{ value: string; icon: string; title: string }> = [
  { value: "up", icon: "⬆", title: "上移" },
  { value: "counterclockwise90", icon: "↺", title: "左旋（逆时针 90°）" },
  { value: "clockwise90", icon: "↻", title: "右旋（顺时针 90°）" },
];

const iconOf = (list: Array<{ value: string; icon: string }>, value: string, fallback: string): string =>
  list.find((x) => x.value === value)?.icon ?? fallback;

type IconOption = { value: string; icon: string; title?: string };

/** 单选浮层：收起只显图标，展开是「图标 + 中文」；点外面或按 Esc 收起 */
function IconSelect({
  value,
  options,
  title,
  onChange,
}: {
  value: string;
  options: IconOption[];
  title: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const labelOf = (o: IconOption) => o.title ?? o.value;
  const current = options.find((o) => o.value === value) ?? options[0];
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    const menuH = Math.min(320, options.length * 27 + 10);
    const below = (r?.bottom ?? 0) + 4;
    setPos({
      left: Math.max(4, Math.min(window.innerWidth - 190, r?.left ?? 0)),
      top: below + menuH > window.innerHeight - 8
        ? Math.max(8, (r?.top ?? 0) - menuH - 4)
        : below,
    });
    setOpen(true);
  };

  return (
    <div className="jeek-isel" ref={boxRef}>
      <button
        ref={btnRef}
        className={`jeek-isel-btn ${open ? "is-on" : ""}`}
        title={`${title}：${current ? labelOf(current) : value}`}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      >
        {current?.icon ?? "—"}
      </button>
      {open && (
        <div className="jeek-isel-menu" style={{ left: pos.left, top: pos.top }}>
          {options.map((o) => (
            <div
              key={o.value}
              className={`jeek-isel-opt ${o.value === value ? "is-on" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="jeek-isel-opt-ico">{o.icon}</span>
              <span>{labelOf(o)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 数值输入框：窄数字框，输入即时生效；↑/↓ 步进（按住连续调节）；
 * Enter 结束编辑并保留选中、Esc 结束编辑并取消选中；
 * 点击与滚轮都拦在框内，不触发字幕条播放、也不让列表翻页。
 * 普通风格改 px 字号；双层文字复用同一套交互，改的是占画面高度的百分比。
 */
function ScaleInput({
  value,
  onChange,
  disabled,
  id,
  min = 12,
  max = 200,
  step = 2,
  shiftStep = 10,
  dataKey = "fontSize",
  label = "字号",
  badge,
  unit,
  tip,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  id: string;
  min?: number;
  max?: number;
  step?: number;
  shiftStep?: number;
  dataKey?: string;
  label?: string;
  badge?: string;
  unit?: string;
  tip?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
  // null = 未编辑，显示文档里的字号；字符串 = 正在输入，避免实时提交时把中间态覆盖掉
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const cfgRef = useRef({ dataKey, step, shiftStep });
  cfgRef.current = { dataKey, step, shiftStep };
  /** 按住 ↑/↓ 时键盘会连续触发 keydown，用 ref 累加避免 React 异步 state 读到旧值 */
  const stepRef = useRef<number | null>(null);

  const applyRaw = (raw: string) => {
    if (raw.trim() === "") return;
    const n = Number(raw);
    if (Number.isFinite(n)) changeRef.current(clamp(n));
  };

  // 滚轮挂在输入框自己的非被动监听上：拦下默认滚动，只改字号并同步框内显示。
  // 基准值从 store 实时读，连续滚动时不会因为 React 还没重渲染而重复算同一个值。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (disabledRef.current) return;
      const state = useEditor.getState();
      if (state.doc.tracks.find((t) => t.kind === "subtitle")?.locked) return;
      const clip = state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      const cur = Number(clip?.data[cfgRef.current.dataKey] ?? valueRef.current);
      const cfg = cfgRef.current;
      const delta = ev.deltaY < 0 ? 1 : -1;
      const next = clamp(cur + delta * (ev.shiftKey ? cfg.shiftStep : cfg.step));
      changeRef.current(next);
      setDraft(String(next));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [id, min, max]);

  const stepBy = (dir: 1 | -1) => {
    if (disabled) return;
    const typed = draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft))
      ? Number(draft)
      : null;
    // 连续 keydown 期间以上一次步进结果为基准；手动输入过则以输入值为基准重新起算
    const base = stepRef.current ?? typed ?? value;
    const next = clamp(base + dir * step);
    stepRef.current = next;
    setDraft(String(next));
    changeRef.current(next);
  };

  return (
    <span className="jeek-sub-num-wrap">
      {badge && <span className="jeek-sub-num-badge">{badge}</span>}
      <input
        ref={inputRef}
        className="jeek-sub-num"
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        disabled={disabled}
        aria-label={label}
        data-jeek-size=""
        data-jeek-key={dataKey}
        data-jeek-id={id}
        data-tip={tip ?? "字号：直接输入数字即时生效；↑ / ↓ 每次 ±2，按住可连续调节；在框内滚轮也 ±2（按住 Shift 变 ±10），不会翻动字幕列表。输入时按 Enter 结束编辑并保留选中，按 Esc 结束编辑并取消选中。"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { stepRef.current = null; setDraft(e.target.value); applyRaw(e.target.value); }}
        onBlur={() => { stepRef.current = null; setDraft(null); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            stepBy(e.key === "ArrowUp" ? 1 : -1);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            stepRef.current = null;
            setDraft(null);
            e.currentTarget.blur();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            stepRef.current = null;
            setDraft(null);
            e.currentTarget.blur();
            const state = useEditor.getState();
            if (state.doc.selection.clips.length || state.doc.selection.tracks.length) {
              state.commit("取消选中", setSelection(state.doc, []));
            }
          }
        }}
      />
      {unit && <span className="jeek-sub-num-unit">{unit}</span>}
    </span>
  );
}

/**
 * 单条字幕行：memo 化。播放时只有「当前句」的 active 状态变化，
 * 换句时旧句 / 新句两行重渲染，其余几百行完全静止 —— 长工程播放不再越播越卡。
 */
const SubtitleRow = memo(function SubtitleRow({
  clip,
  index,
  isSelected,
  isActive,
  globalFontSize,
  globalEnter,
  subtitleStyle,
  globalDuoBackdrop,
  globalDuoFront,
  customFont,
  fontOptions,
  subLocked,
  listEdit,
  rowRefs,
  onPatch,
  onEdit,
  onSelect,
}: {
  clip: { id: string; startMs: number; endMs: number; data: Record<string, unknown> };
  index: number;
  isSelected: boolean;
  isActive: boolean;
  globalFontSize: number;
  globalEnter: string;
  subtitleStyle: string;
  globalDuoBackdrop: number;
  globalDuoFront: number;
  customFont: boolean;
  fontOptions: Array<{ family: string; source?: string; fileName?: string }>;
  subLocked: boolean;
  listEdit: boolean;
  rowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onPatch: (clipId: string, data: Record<string, unknown>, label: string) => void;
  onEdit: (result: SubtitleEditResult | null, label: string, emptyNote: string) => void;
  onSelect: (clipId: string, startMs: number, endMs: number) => void;
}) {
  const fontSize = Number(clip.data.fontSize ?? globalFontSize);
  const color = String(clip.data.color ?? "#ffffff");
  const rawEnter = String(clip.data.enterAnimation ?? globalEnter ?? "打字机");
  const enter = LEGACY_ENTER_CN[rawEnter] ?? rawEnter;
  // 旧工程只把旋转值写在 motion 上，这里一并兼容；其它无效值按普通上移处理
  const rawMove = String(clip.data.moveAnimation ?? clip.data.motion ?? "up");
  const move = MOVE_OPTIONS.some((o) => o.value === rawMove) ? rawMove : "up";
  // 双层文字：没有单条覆盖时显示全局值（全片默认同字号）；写过的值才是这一条专属
  const duoMode = subtitleStyle === "duo";
  const duoBackdrop = Number(clip.data.duoBackdropScale ?? globalDuoBackdrop);
  const duoFront = Number(clip.data.duoFrontScale ?? globalDuoFront);
  const duoCustom = clip.data.duoBackdropScale !== undefined || clip.data.duoFrontScale !== undefined;

  return (
    <div
      key={clip.id}
      ref={(node) => { rowRefs.current[clip.id] = node; }}
      className={`jeek-sub-card ${isSelected ? "is-selected" : ""} ${isActive ? "jeek-sub-active" : ""}`}
      onMouseDown={(e) => {
        // 第二行是编辑控件：点字号 / 颜色 / 入场 / 移动 / 字体只操作控件，
        // 不能冒泡成「点卡片」，否则会误播这条字幕并把播放头跳到开头。
        // 这里只拦截判定、不 stopPropagation，浮层的「点外面收起」仍能收到事件。
        const hit = e.target as Element | null;
        if (hit?.closest(".jeek-sub-line2, .jeek-isel, input, button, select")) return;
        onSelect(clip.id, clip.startMs, clip.endMs);
      }}
    >
      <div className="jeek-sub-line1">
        <span className="jeek-sub-idx">{index + 1}</span>
        <input
          className="jeek-sub-text"
          placeholder="输入字幕文本…"
          value={String(clip.data.text ?? "")}
          readOnly={subLocked}
          onChange={(e) => onPatch(clip.id, { text: e.target.value }, "修改字幕")}
          onKeyDown={(e) => {
            const state = useEditor.getState();
            const input = e.currentTarget;
            const len = input.value.length;
            // 拆句与并句都算「一次编辑结束」：提交后主动失焦，
            // 否则光标会跟着重渲染出来的下一条继续，用户还得再点一下才能脱身
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              const pos = input.selectionStart ?? 0;
              if (pos > 0 && pos < len) {
                e.preventDefault();
                onEdit(
                  splitSubtitleAt(state.doc, clip.id, pos),
                  "拆分字幕",
                  "光标两侧都要有文字才能拆成两条",
                );
                input.blur();
              }
              return;
            }
            if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey
              && input.selectionStart === 0 && input.selectionEnd === 0) {
              e.preventDefault();
              onEdit(
                mergeSubtitleWithPrev(state.doc, clip.id),
                "合并字幕",
                "已经是第一条字幕，没有可合并的上一条",
              );
              input.blur();
              return;
            }
            if (e.key === "Delete" && !e.ctrlKey && !e.metaKey
              && input.selectionStart === len && input.selectionEnd === len) {
              e.preventDefault();
              onEdit(
                mergeSubtitleWithNext(state.doc, clip.id),
                "合并字幕",
                "已经是最后一条字幕，没有可合并的下一条",
              );
              input.blur();
            }
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className={`jeek-sub-line2 ${listEdit ? "" : "is-hidden"}`}>
        {duoMode ? (
          <div className="jeek-sub-field" data-duo-size="" onMouseDown={(e) => e.stopPropagation()}>
            <span>字号</span>
            <ScaleInput
              id={clip.id}
              value={duoBackdrop}
              disabled={subLocked}
              min={2}
              max={60}
              step={1}
              shiftStep={5}
              dataKey="duoBackdropScale"
              label="衬底字号（占画面高度百分比）"
              badge="衬"
              unit="%"
              tip="这一句双层文字的衬底大字：默认与其他句子一样跟随全局字号；直接输入数字即只覆盖这一句，↑ / ↓ 每次 ±1（Shift ±5），框内滚轮同样生效。改了全局想重新跟随，点右侧 ↺。"
              onChange={(v) => onPatch(clip.id, { duoBackdropScale: v }, "修改单条衬底字号")}
            />
            <ScaleInput
              id={clip.id}
              value={duoFront}
              disabled={subLocked}
              min={1}
              max={40}
              step={1}
              shiftStep={5}
              dataKey="duoFrontScale"
              label="顶层字号（占画面高度百分比）"
              badge="顶"
              unit="%"
              tip="这一句双层文字的顶层小字：默认与其他句子一样跟随全局字号；直接输入数字即只覆盖这一句，↑ / ↓ 每次 ±1（Shift ±5），框内滚轮同样生效。改了全局想重新跟随，点右侧 ↺。"
              onChange={(v) => onPatch(clip.id, { duoFrontScale: v }, "修改单条顶层字号")}
            />
            {duoCustom && (
              <button
                type="button"
                className="jeek-sub-size-reset"
                title="恢复全局字号（让这一句重新跟随其他字幕）"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onPatch(clip.id, { duoBackdropScale: undefined, duoFrontScale: undefined }, "恢复全局字号");
                }}
              >↺</button>
            )}
          </div>
        ) : (
          <div className="jeek-sub-field" onMouseDown={(e) => e.stopPropagation()}>
            <span>字号</span>
            <ScaleInput
              id={clip.id}
              value={fontSize}
              disabled={subLocked}
              onChange={(v) => onPatch(clip.id, { fontSize: v }, "修改字号")}
            />
          </div>
        )}
        <label className="jeek-sub-field">
          <span>颜色</span>
          <input
            className="jeek-sub-color"
            type="color"
            value={color}
            onChange={(e) => onPatch(clip.id, { color: e.target.value }, "修改颜色")}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </label>
        <div className="jeek-sub-field">
          <span>入场</span>
          <IconSelect
            value={enter}
            options={ENTER_OPTIONS}
            title="入场动画"
            onChange={(next) => onPatch(clip.id, { enterAnimation: next }, "修改入场动画")}
          />
        </div>
        <div className="jeek-sub-field" data-move={move}>
          <span title="移动方式：上移、左旋（逆时针 90°）、右旋（顺时针 90°）。这里改的就是画面里这条字幕实际生效的移动方式。">移动</span>
          <IconSelect
            value={move}
            options={MOVE_OPTIONS}
            title="移动方式"
            onChange={(next) => onPatch(clip.id, { moveAnimation: next }, "修改移动方式")}
          />
        </div>
        {customFont && (
          <div className="jeek-sub-field">
            <span>字体</span>
            <IconSelect
              value={String(clip.data.fontFamily ?? "Microsoft YaHei")}
              options={fontOptions.map((f) => ({ value: f.family, icon: "Aa", title: fontCnName(f.family, f.fileName) }))}
              title="字体"
              onChange={(next) => {
                const source = fontOptions.find((f) => f.family === next)?.source;
                onPatch(clip.id, { fontFamily: next, fontSource: source }, "修改字体");
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
});

export function SubtitleList() {
  const doc = useEditor((s) => s.doc);
  const commit = useEditor((s) => s.commit);
  const setSetting = useEditor((s) => s.setSetting);
  const notify = useEditor((s) => s.notify);
  // 只订阅「当前句 id」而不是每帧的时间，播放时列表不会跟着每帧重渲染
  const activeId = useEditor((s) => activeSubtitleId(s.doc, s.playheadMs));
  const items = sortedSubtitles(doc);
  const selected = new Set(doc.selection.clips);
  const customFont = Boolean(doc.settings.customFont);
  const fontCatalog = useEditor((s) => s.fontCatalog);
  const fontOptions = useMemo(() => mergeFontEntries(fontCatalog), [fontCatalog]);
  const randomStyle = Boolean(doc.settings.randomStyle);
  /** 双层文字默认全片同字号，单条覆盖写在 clip.data.duo*Scale，缺省回落到这两个全局值 */
  const subtitleStyle = String(doc.settings.subtitleStyle ?? "fit");
  const globalDuoBackdrop = Math.max(2, Math.min(60, Number(doc.settings.duoBackdropScale ?? 9)));
  const globalDuoFront = Math.max(1, Math.min(40, Number(doc.settings.duoFrontScale ?? 5)));
  /** 字幕轨被锁定时，列表里的文本 / 字号 / 颜色等编辑一律挡住 */
  const subLocked = Boolean(doc.tracks.find((t) => t.kind === "subtitle")?.locked);
  /** 字幕列表的编辑开关：默认关闭，关掉后每条只显示一行文本，省出竖屏空间 */
  const listEdit = Boolean(doc.settings.listEdit ?? false);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);

  const patch = useCallback((clipId: string, data: Record<string, unknown>, label: string) => {
    const state = useEditor.getState();
    if (state.doc.tracks.find((t) => t.kind === "subtitle")?.locked) {
      state.notify("字幕轨已锁定，先解锁再编辑");
      return;
    }
    state.commit(label, patchClip(state.doc, clipId, data));
  }, []);

  /**
   * 拆分 / 合并之后不抢焦点：默认退出文本编辑状态，
   * 想接着改哪条就自己点哪条，回车不会被自动带进下一条的输入框。
   */
  const applyEdit = useCallback((result: SubtitleEditResult | null, label: string, emptyNote: string) => {
    if (useEditor.getState().doc.tracks.find((t) => t.kind === "subtitle")?.locked) {
      useEditor.getState().notify("字幕轨已锁定，先解锁再编辑");
      return;
    }
    if (!result) {
      useEditor.getState().notify(emptyNote);
      return;
    }
    useEditor.getState().commit(label, result.doc);
  }, []);

  const onSelect = useCallback((clipId: string, startMs: number, endMs: number) => {
    const state = useEditor.getState();
    state.commit("选中字幕", setSelection(state.doc, [clipId]));
    // 点哪条就播哪条：从卡片开头播到结尾自动暂停（旧版 click-to-play）
    state.playClipRange(startMs, endMs);
  }, []);

  // 播放时把当前句滚到列表正中（旧版 rowRefs + listRef 的居中逻辑）
  useEffect(() => {
    if (!activeId) return;
    const row = rowRefs.current[activeId];
    const container = listRef.current;
    if (!row || !container) return;
    const rowRect = row.getBoundingClientRect();
    const contRect = container.getBoundingClientRect();
    const delta = rowRect.top - contRect.top - contRect.height / 2 + rowRect.height / 2;
    if (Math.abs(delta) > 12) container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
  }, [activeId, items.length]);

  return (
    <div className="jeek-list-card">
      <h3 className="jeek-list-head">字幕列表</h3>

      <div className="jeek-list">
        {items.length > 0 && (
          <div className="jeek-list-tools">
            <div className="jeek-list-switches">
              <label
                className="jeek-list-switch"
                data-tip={listEdit
                  ? "编辑已开启：每条字幕都带第二行的字号、颜色、入场、移动（以及自定义字体时的字体）。关掉后只剩一行文本，列表更紧凑。"
                  : "编辑已关闭：每条字幕只显示一行文本。打开后才会出现字号、颜色、入场、移动等参数。"}
              >
                <span
                  className={`jeek-switch-track ${listEdit ? "is-on" : ""}`}
                  data-act="list.edit"
                  onClick={() => setSetting("listEdit", !listEdit)}
                />
                <span>编辑</span>
              </label>
              <label className="jeek-list-switch" title="为每条字幕单独设置字体">
                <span
                  className={`jeek-switch-track ${customFont ? "is-on" : ""}`}
                  onClick={() => setSetting("customFont", !customFont)}
                />
                <span>自定义字体</span>
              </label>
              <label className="jeek-list-switch" title="打开后为每条字幕随机分配一次入场动画；之后仍可单条修改，改全局动画可随时把所有条目统一">
                <span
                  className={`jeek-switch-track ${randomStyle ? "is-on" : ""}`}
                  onClick={() => {
                    if (!randomStyle) {
                      const s = useEditor.getState();
                      const next = randomizeEnter(doc);
                      next.settings = { ...next.settings, randomStyle: true };
                      s.commit("随机样式", next);
                    } else {
                      setSetting("randomStyle", false);
                    }
                  }}
                />
                <span>随机样式</span>
              </label>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <div className="jeek-list-empty">
            请先导入字幕文件，或在下方手动添加字幕
          </div>
        ) : (
          <div className="jeek-list-scroll" ref={listRef}>
            {items.map((clip, index) => (
              <SubtitleRow
                key={clip.id}
                clip={clip}
                index={index}
                isSelected={selected.has(clip.id)}
                isActive={activeId === clip.id}
                globalFontSize={Number(doc.settings.fontSize ?? 60)}
                globalEnter={String(doc.settings.enterAnimation ?? "打字机")}
                subtitleStyle={subtitleStyle}
                globalDuoBackdrop={globalDuoBackdrop}
                globalDuoFront={globalDuoFront}
                customFont={customFont}
                fontOptions={fontOptions}
                subLocked={subLocked}
                listEdit={listEdit}
                rowRefs={rowRefs}
                onPatch={patch}
                onEdit={applyEdit}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div className="jeek-list-stat">
          共 {items.length} 条 · 总长 {(durationOf(doc) / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}

export { iconOf };
