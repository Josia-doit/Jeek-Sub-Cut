import { insertSubtitleAt, patchClip, setSelection } from "@jeek/core";
import { useEditor } from "../store";
import { sortedSubtitles } from "../lib/srt";
import { IconSubtitleAdd } from "./Icons";

/** 底部输入框：选中卡片时编辑它，没选中时缓存草稿用于新增；右侧只有「添加字幕」一个图标按钮 */
export function AddBar() {
  const doc = useEditor((s) => s.doc);
  const draftText = useEditor((s) => s.draftText);

  const selected = doc.selection.clips;
  const active = selected.length === 1
    ? doc.tracks.find((t) => t.kind === "subtitle")?.clips.find((c) => c.id === selected[0]) ?? null
    : null;

  const add = () => {
    const state = useEditor.getState();
    const body = state.draftText.trim() || "新字幕";
    const settings = state.doc.settings;
    const result = insertSubtitleAt(state.doc, state.playheadMs, body, {
      fontSize: Number(settings.fontSize ?? 60),
      color: String(settings.fontColor ?? "#ffffff"),
      enterAnimation: String(settings.enterAnimation ?? "打字机"),
      motion: String(settings.motion ?? "up"),
      moveAnimation: "up",
    });
    if (result.doc === state.doc) return;
    state.commit("插入字幕", result.doc);
    state.update({ draftText: "" });
    state.setPlayhead(result.endMs);
    state.notify(`已添加第 ${sortedSubtitles(result.doc).length} 条字幕`);
  };

  return (
    <div className="jeek-add-card">
      <textarea
        className="jeek-add-text"
        rows={1}
        data-active={active ? "1" : "0"}
        placeholder={active
          ? "直接修改这条字幕的文字，输入即时生效…"
          : "输入字幕文本，点右侧 ＋ 插入到播放头位置…"}
        value={active ? String(active.data.text ?? "") : draftText}
        onChange={(e) => {
          const v = e.target.value;
          if (active) {
            const state = useEditor.getState();
            state.commit("修改字幕", patchClip(state.doc, active.id, { text: v }));
          } else {
            useEditor.getState().update({ draftText: v });
          }
        }}
        onKeyDown={(e) => {
          // Ctrl / ⌘ + Enter：保持原有的「插入到播放头」能力
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            add();
            return;
          }
          // 裸 Enter：结束编辑只让输入框失焦，选中的那张卡片继续保持选中。
          // Shift + Enter 留给多行字幕换行。
          if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
            return;
          }
          // Esc：结束编辑并同时清掉选区，文本框随即回到「新增草稿」状态。
          // 自己清选区而不依赖全局 Esc：全局分支在弹出面板打开时会直接 return。
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
            const state = useEditor.getState();
            if (state.doc.selection.clips.length || state.doc.selection.tracks.length) {
              state.commit("取消选中", setSelection(state.doc, []));
            }
          }
        }}
      />

      <button
        className="jeek-add-btn"
        data-tip="在播放头位置插入一条字幕（Ctrl+T）：优先用文本框里的文字，留空则插入一条默认字幕。"
        aria-label="添加字幕"
        onClick={add}
      >
        <IconSubtitleAdd size={17} />
      </button>
    </div>
  );
}
