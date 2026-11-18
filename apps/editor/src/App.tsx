import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectDocument } from "@jeek/contracts";
import {
  applyStyleRules,
  buildMovePlan,
  deleteClips,
  deserializeProject,
  durationOf,
  fillGaps,
  fmtTimecode,
  insertClip,
  insertSubtitleAt,
  mergeClips,
  playheadEndMs,
  removeGaps,
  serializeProject,
  setSelection,
  setSetting,
  sortTrack,
  splitAllAt,
  validateDocument,
} from "@jeek/core";
import { activateDefaultModules, clipLocked, useEditor, withDefaultEnterDuration, writeStoredTheme, type AudioState } from "./store";
import { loadImportSubtitlesCommand } from "./modules.config";
import { Header, Toolbar } from "./components/Chrome";
import { LeftPanel } from "./components/LeftPanel";
import { Preview } from "./components/Preview";
import { Timeline, trimAtPlayhead } from "./components/Timeline";
import { SubtitleList } from "./components/SubtitleList";
import { AddBar } from "./components/AddBar";
import { TrackAudioPanel, TrackSubtitlePanel } from "./components/TrackPanels";
import { AsrPanel, ExportPanel, FindPanel, FontPanel, ModulePanel, RecordPanel, SettingsPanel, TipLayer } from "./components/Overlays";
import {
  computePeaks,
  decodeAudioFile,
  effectivePlaybackGain,
  playAudio,
  renderTrackAudio,
  stopAudio,
} from "./lib/media";
import {
  buildSubtitleText,
  cuesFromDocument,
  downloadText,
  parseSubtitles,
  sortedSubtitles,
  type SubtitleFormat,
} from "./lib/srt";
import { hasDesktopBridge, openProjectFile, saveSubtitleFile, saveProjectFile } from "./lib/bridge";
import { applyFontFaces, ensureFontsLoaded, fontEntriesFromDocument, importFontFile, loadFontCatalog, saveFontCatalog } from "./lib/fonts";
import "./app.css";

const DEFAULT_TEXT = "新字幕";

/**
 * 底部模块（时间轴 + 底部文本框）的最小高度＝默认高度：
 * 正好放得下时间轴工具条、标尺、两条轨道和一行文本框，剩下都给预览区；
 * 往上拖就是给未来新增的轨道留空间，文本框始终贴在底部。
 */
const BOTTOM_MIN = 248;
/** 左侧设置面板的最小宽度＝默认宽度：按 UI 截图量出的 280px（「画布颜色一行」单行不折行、也不空旷） */
const LEFT_MIN = 280;

export function App() {
  const [ready, setReady] = useState(false);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  const overlay = useEditor((s) => s.overlay);
  const theme = useEditor((s) => s.theme);
  const toast = useEditor((s) => s.toast);
  const doc = useEditor((s) => s.doc);

  /**
   * 三块可拖动分隔：宽度与高度都记住，双击恢复默认。
   * 键名带版本号：默认值变了（例如时间轴默认缩到最小高度）时，
   * 旧版本记下的旧尺寸不会盖住新默认值。
   */
  const layoutKey = (k: string) => `jeek-layout-v5-${k}`;
  const readLayout = (k: string, fallback: number) => {
    try {
      const raw = localStorage.getItem(layoutKey(k));
      const v = Number(raw);
      return raw !== null && Number.isFinite(v) && v > 0 ? v : fallback;
    } catch { return fallback; }
  };
  const saveLayout = (k: string, v: number) => {
    try { localStorage.setItem(layoutKey(k), String(Math.round(v))); } catch { /* 隐私模式 */ }
  };
  const clearLayout = () => {
    try { ["left", "right", "bottom"].forEach((k) => localStorage.removeItem(layoutKey(k))); } catch { /* 隐私模式 */ }
  };
  // 默认尺寸：左侧按 UI 截图量出的 280px（颜色行不折行也不空旷），右侧与底部收窄，
  // 给中间播放器留出空间，让 16:9 画面默认能完整显示。
  const [leftW, setLeftW] = useState(() => readLayout("left", LEFT_MIN));
  const [rightW, setRightW] = useState(() => readLayout("right", 304));
  const [bottomH, setBottomH] = useState(() => readLayout("bottom", BOTTOM_MIN));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    writeStoredTheme(theme);
  }, [theme]);

  useEffect(() => {
    void activateDefaultModules().then(() => setReady(true));
  }, []);

  /** 字体目录：启动时读出来，注入 @font-face 并等字体加载完（否则量字宽会算错） */
  useEffect(() => {
    void (async () => {
      const entries = await loadFontCatalog();
      if (entries.length) useEditor.getState().setFontCatalog(entries);
      // 随程序分发的开源字体也要注入：没有导入字体时同样要能看到真实字形
      applyFontFaces(entries);
      await ensureFontsLoaded(entries);
    })();
  }, []);

  /** 自动排序持续生效：裁剪、移动、删除、撤销之后都把音频轨重新贴合 */
  useEffect(() => {
    let lastDoc = useEditor.getState().doc;
    return useEditor.subscribe((state) => {
      if (state.doc === lastDoc) return;
      lastDoc = state.doc;
      if (!state.autoSortOn) return;
      const audio = state.doc.tracks.find((t) => t.kind === "audio");
      if (!audio?.clips.length) return;
      const next = sortTrack(state.doc, audio.id, state.syncWithAudio);
      if (next !== state.doc) state.commit("音频自动排序", next);
    });
  }, []);

  /* ------------------------------------------------------------ 文件动作 */

  const importAudio = useCallback(async (file: File) => {
    const state = useEditor.getState();
    try {
      const decoded = await decodeAudioFile(file);
      const track = state.doc.tracks.find((t) => t.kind === "audio");
      let next = state.doc;
      if (track) {
        next = { ...next, tracks: next.tracks.map((t) => (t.kind === "audio" ? { ...t, clips: [] } : t)) };
        next = insertClip(next, track.id, {
          kind: "audio",
          startMs: 0,
          endMs: Math.max(100, Math.min(decoded.durationMs, 60 * 60 * 1000)),
          inMs: 0,
          assetId: `asset_${file.name}`,
          data: { gain: 1 },
        });
        next = {
          ...next,
          assets: [...next.assets.filter((a) => a.kind !== "audio"), {
            id: `asset_${file.name}`,
            kind: "audio" as const,
            uri: file.name,
            durationMs: decoded.durationMs,
          }],
        };
      }
      state.commit(`导入音频 ${file.name}`, next);
      state.rebase();
      const audio: AudioState = {
        name: decoded.name,
        buffer: decoded.buffer,
        peaks: decoded.peaks,
        durationMs: decoded.durationMs,
        url: decoded.url,
      };
      state.update({ audio });
      state.notify(`已载入 ${file.name}（${(decoded.durationMs / 1000).toFixed(1)} 秒）`);
    } catch (error) {
      state.notify(`音频解码失败：${String(error)}`);
    }
  }, []);

  const importSubtitles = useCallback(async (file: File) => {
    const state = useEditor.getState();
    const raw = await file.text();
    const parsed = parseSubtitles(raw, undefined, file.name);
    const track = state.doc.tracks.find((t) => t.kind === "subtitle");
    if (!track) return;
    if (!parsed.cues.length && !parsed.plain.length) {
      state.notify(`${file.name} 里没有找到可用的字幕内容`);
      return;
    }
    let next = state.doc;
    next = { ...next, tracks: next.tracks.map((t) => (t.kind === "subtitle" ? { ...t, clips: [] } : t)) };

    const enterAnimation = String(state.doc.settings.enterAnimation ?? "打字机");
    const motion = String(state.doc.settings.motion ?? "up");
    const insertOne = (
      startMs: number,
      endMs: number,
      text: string,
    ) => {
      next = insertClip(next, track.id, {
        kind: "subtitle",
        startMs,
        endMs,
        data: { text, enterAnimation, motion },
      });
    };

    if (parsed.cues.length) {
      parsed.cues.forEach((cue) => {
        insertOne(cue.startMs, Math.max(cue.startMs + 100, cue.endMs), cue.text);
      });
    } else {
      const factory = await loadImportSubtitlesCommand();
      const cmd = factory(state.doc, track.id, parsed.plain, 0);
      const sourceSubs = cmd.after.tracks.find((t) => t.kind === "subtitle")?.clips ?? [];
      sourceSubs.forEach((clip) => {
        insertOne(clip.startMs, clip.endMs, String(clip.data.text ?? ""));
      });
    }

    // 套用全局样式规则：随机字号 + 调色板随机色 + 重算旋转计划（对齐旧版 L）。
    // 入场动画与移动方向不在规则里改写，保持各条已设值。
    next = applyStyleRules(next, {
      minFontSize: Number(state.doc.settings.minFontSize ?? 90),
      maxFontSize: Number(state.doc.settings.maxFontSize ?? 100),
      palette: Array.isArray(state.doc.settings.palette) ? state.doc.settings.palette : [],
      rotationMode: String(state.doc.settings.rotationMode ?? "auto"),
      rotationInterval: Number(state.doc.settings.rotationInterval ?? 0),
    });
    state.commit(`导入字幕 ${file.name}`, next);
    state.update({ subtitleSourceName: file.name });
    state.fitAll();
    state.notify(`已导入 ${sortedSubtitles(next).length} 条字幕`);
  }, []);

  /** 导入本地字体：进字体目录，并顺手设为全局默认（旧版「选择字体」就是这个口径） */
  const importFont = useCallback(async (file: File) => {
    const state = useEditor.getState();
    const result = await importFontFile(file);
    if (!result.ok || !result.entry) {
      state.notify(result.error ?? "导入字体失败");
      return;
    }
    const next = [result.entry, ...state.fontCatalog.filter((f) => f.family !== result.entry!.family)];
    state.setFontCatalog(next);
    applyFontFaces(next);
    await ensureFontsLoaded(next);
    const saved = await saveFontCatalog(next);
    state.commit("设置全局字体", setSetting(state.doc, "fontFamily", result.entry.family));
    state.notify(saved.ok ? `已导入字体 ${result.entry.family} 并设为全局字体` : (saved.error ?? "字体已导入"));
  }, []);

  const loadProject = useCallback(async (file: File) => {    const state = useEditor.getState();
    try {
      const doc = withDefaultEnterDuration(deserializeProject(await file.text()));
      state.commit(`载入工程 ${file.name}`, doc);
      state.update({ subtitleSourceName: file.name.replace(/\.jeek$/i, "").replace(/\.json$/i, "") });
      state.fitAll();
      // 工程里带的字体（字幕条目自带 fontSource）也要注入，否则换台机器打开会退回系统字体
      const embedded = fontEntriesFromDocument(doc);
      if (embedded.length) {
        const merged = [...state.fontCatalog, ...embedded];
        applyFontFaces(merged);
        await ensureFontsLoaded(merged);
      }
      const legacyAudio = String(doc.settings.legacyAudioPath ?? "");
      state.notify(
        legacyAudio
          ? "工程已载入；原工程里的音频需要重新载入一次"
          : "工程已载入",
      );
    } catch (error) {
      state.notify(`工程载入失败：${String(error)}`);
    }
  }, []);

  /* ------------------------------------------------------------ 命令分发 */

  const runCommand = useCallback((name: string) => {
    const s = useEditor.getState();
    const d = s.doc;
    const track = d.tracks.find((t) => t.kind === "subtitle");
    const audioTrack = d.tracks.find((t) => t.kind === "audio");
    const at = s.playheadMs;

    switch (name) {
      case "undo": s.undo(); break;
      case "redo": s.redo(); break;

      case "clip.split": {
        // 锁定轨道不可编辑：播放头落在锁定轨的卡片里时整次切分拒绝，提示解锁
        if (d.tracks.some((t) => t.locked && t.clips.some((c) => c.startMs < at && c.endMs > at))) {
          s.notify("该轨道已锁定，先解锁再切分");
          break;
        }
        const next = splitAllAt(d, at);
        if (next === d) s.notify("播放头不在可切分的位置，先定位到卡片中间");
        else s.commit("切分", next);
        break;
      }
      case "subtitle.insert": {
        if (!track) break;
        if (track.locked) { s.notify("字幕轨已锁定，先解锁再添加字幕"); break; }
        const result = insertSubtitleAt(d, at, s.draftText.trim() || DEFAULT_TEXT, {
          fontSize: Number(d.settings.fontSize ?? 60),
          color: String(d.settings.fontColor ?? "#ffffff"),
          enterAnimation: String(d.settings.enterAnimation ?? "打字机"),
          motion: String(d.settings.motion ?? "up"),
          moveAnimation: "up",
        });
        s.commit("插入字幕", result.doc);
        s.update({ draftText: "" });
        s.setPlayhead(result.endMs);
        break;
      }
      case "subtitle.clear": {
        if (!track) break;
        s.commit("关闭字幕", {
          ...d,
          tracks: d.tracks.map((t) => (t.kind === "subtitle" ? { ...t, clips: [] } : t)),
        });
        s.update({ subtitleSourceName: null });
        // 关闭载入的字幕后恢复默认时间轴：缩放复位、播放头回 0，不留上一层压缩的标尺
        s.seekTo(0);
        s.fitAll();
        s.notify("已关闭字幕，音频不受影响");
        break;
      }
      case "clip.delete": {
        if (!d.selection.clips.length) { s.notify("先选中要删除的卡片"); break; }
        if (d.selection.clips.some((id) => clipLocked(d, id))) {
          s.notify("选中里有锁定轨的卡片，先解锁再删除");
          break;
        }
        s.commit("删除卡片", deleteClips(d, d.selection.clips));
        break;
      }
      case "subtitle.merge": {
        if (d.selection.clips.length < 2) { s.notify("选中两张以上字幕再合并"); break; }
        if (d.selection.clips.some((id) => clipLocked(d, id))) {
          s.notify("选中里有锁定轨的卡片，先解锁再合并");
          break;
        }
        s.commit("合并字幕", mergeClips(d, d.selection.clips));
        break;
      }
      case "timeline.fill": {
        if (!track) break;
        const result = fillGaps(d, track.id);
        if (result.filled) s.commit("自动填充", result.doc);
        else s.notify("没有需要填充的空隙");
        break;
      }
      case "timeline.removeGaps": {
        const result = removeGaps(d);
        if (result.moved) s.commit("消除缝隙", result.doc);
        s.notify(result.moved
          ? `已消除 ${result.moved} 处空隙${result.blocked ? `，另有 ${result.blocked} 处被贴合边界挡住` : ""}`
          : "两侧卡片都已经贴合，没有可继续前移的空间");
        break;
      }
      case "timeline.fit": s.fitAll(); break;
      case "timeline.zoomIn": s.changeZoom(1); break;
      case "timeline.zoomOut": s.changeZoom(-1); break;

      case "range.start": {
        const r = (d.settings.exportRange as { startMs: number; endMs: number } | null) ?? null;
        s.setSetting("exportRange", { startMs: at, endMs: r ? Math.max(at + 1, r.endMs) : durationOf(d) });
        s.notify(`导出范围起点：${fmtTimecode(at, d.video.fps)}`);
        break;
      }
      case "range.end": {
        const r = (d.settings.exportRange as { startMs: number; endMs: number } | null) ?? null;
        s.setSetting("exportRange", { startMs: r ? Math.min(r.startMs, at - 1) : 0, endMs: at });
        s.notify(`导出范围终点：${fmtTimecode(at, d.video.fps)}`);
        break;
      }
      case "range.clear":
        s.setSetting("exportRange", null);
        s.notify("已清除导出范围");
        break;

      case "preview.toggle": {
        const next = !s.playing;
        // 全量播放不走片段区间：切到整轨播放前清掉片段区间
        s.clearClipRange();
        if (next) {
          const end = playheadEndMs(d);
          // 空工程没有内容可播：播放头不动，也不起播
          if (end <= 0) {
            s.notify("还没有可播放的内容：先导入字幕或音频");
            break;
          }
          if (at >= end) s.setPlayhead(0);
          const mixed = renderTrackAudio(d, s.audio?.buffer ?? null);
          // 播放器喇叭与音轨总控任一静音都按 0 增益播放，画面照常
          const gain = effectivePlaybackGain(d, s.volumeMuted);
          playAudio(mixed, useEditor.getState().playheadMs, gain);
        } else {
          stopAudio();
        }
        s.update({ playing: next });
        break;
      }
      case "preview.prev":
      case "preview.next": {
        const clips = sortedSubtitles(d);
        if (!clips.length) break;
        const idx = clips.findIndex((c) => c.startMs > at + 1);
        if (name === "preview.next") {
          s.seekTo(idx === -1 ? clips[clips.length - 1].startMs : clips[idx].startMs);
        } else {
          const earlier = [...clips].reverse().filter((c) => c.startMs < at - 1);
          s.seekTo(earlier.length ? earlier[0].startMs : 0);
        }
        break;
      }
      case "preview.home": s.seekTo(0); break;
      case "preview.end": s.seekTo(playheadEndMs(d)); break;

      case "audio.import": audioInputRef.current?.click(); break;
      case "import.open": subtitleInputRef.current?.click(); break;

      case "audio.record": s.update({ overlay: "record" }); break;
      case "audio.close": {
        s.commit("关闭音频", {
          ...d,
          assets: d.assets.filter((a) => a.kind !== "audio"),
          tracks: d.tracks.map((t) => (t.kind === "audio" ? { ...t, clips: [] } : t)),
        });
        s.update({ audio: null, recording: false });
        stopAudio();
        // 关闭音轨同样恢复默认时间轴，标尺不留在压缩状态
        s.seekTo(0);
        s.fitAll();
        s.notify("音频已关闭，之后的录音不会拼接旧音频");
        break;
      }
      case "audio.sort": {
        if (!audioTrack) break;
        s.commit("音频自动排序", sortTrack(d, audioTrack.id));
        break;
      }

      case "font.pick":
        fontInputRef.current?.click();
        break;
      case "font.catalog":
        s.update({ overlay: "fonts" });
        break;

      case "export.srt": {
        const format = String(d.settings.subtitleExportFormat ?? "srt") as SubtitleFormat;
        const cues = cuesFromDocument(d);
        if (!cues.length) {
          s.notify("时间轴上还没有字幕，先添加或导入");
          break;
        }
        const text = buildSubtitleText(cues, format);
        // 默认文件名用简短英文，避开工程中文名在不同系统 / 软件里的兼容性问题
        const fileName = `subtitles.${format}`;
        if (hasDesktopBridge()) {
          void (async () => {
            // 弹系统保存对话框：位置与文件名由用户选，不再自动写进默认目录
            const saved = await saveSubtitleFile(text, format, fileName);
            if (saved.ok && saved.filePath) {
              s.notify(`已导出字幕到 ${saved.filePath}`);
              return;
            }
            if (saved.canceled) return;
            s.notify(`字幕导出失败：${saved.error ?? ""}`);
          })();
        } else {
          const mime: Record<SubtitleFormat, string> = {
            srt: "application/x-subrip;charset=utf-8",
            vtt: "text/vtt;charset=utf-8",
            txt: "text/plain;charset=utf-8",
            json: "application/json;charset=utf-8",
          };
          downloadText(text, fileName, mime[format]);
          s.notify(`已导出 ${format.toUpperCase()} 字幕，共 ${cues.length} 条`);
        }
        break;
      }
      case "export.project": {
        const text = serializeProject(d);
        // 默认文件名用简短英文，避开工程中文名的兼容性问题；保存对话框里仍可自行修改
        const name = "project.jeek";
        void (async () => {
          const saved = await saveProjectFile(text, name);
          if (saved.ok && saved.filePath) {
            s.notify(`工程已保存到 ${saved.filePath}`);
            return;
          }
          if (saved.canceled) return;
          downloadText(text, name, "application/json;charset=utf-8");
          s.notify("工程已保存为 .jeek 文件");
        })();
        break;
      }
      case "project.open": {
        void (async () => {
          try {
            const picked = await openProjectFile();
            if (!picked) {
              projectInputRef.current?.click();
              return;
            }
            const doc = withDefaultEnterDuration(deserializeProject(picked.text));
            s.commit(`载入工程 ${picked.filePath.split(/[\\/]/).pop() ?? ""}`, doc);
            s.fitAll();
            s.notify(String(doc.settings.legacyAudioPath ?? "") ? "工程已载入；原工程里的音频需要重新载入一次" : "工程已载入");
          } catch (error) {
            s.notify(`工程载入失败：${String(error)}`);
          }
        })();
        break;
      }
      case "export.open": s.update({ overlay: "export" }); break;
      case "asr.open": s.update({ overlay: "asr" }); break;
      case "settings.open": s.update({ overlay: "settings" }); break;
      case "modules.open": s.update({ overlay: "modules" }); break;
      default: break;
    }
  }, []);

  /* ------------------------------------------------------------ 快捷键 */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const inputType = (target as HTMLInputElement).type;
      // 真正的文字录入框（文本框 / 文本类 input）里才放行空格，其余一律当播放暂停
      const isTextEntry = tag === "TEXTAREA"
        || (tag === "INPUT" && ["text", "search", "url", "email", "password", "number"].includes(inputType));
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === "Escape") {
        const state = useEditor.getState();
        // 弹出面板只能按面板上的关闭按钮关闭：Esc 与点击面板外都不关，
        // 避免识别 / 录音 / 导出进行到一半被误关，重开后内容与进度不符
        if (state.overlay !== "none") return;
        if (state.doc.selection.clips.length || state.doc.selection.tracks.length) {
          state.commit("取消选中", setSelection(state.doc, []));
        }
        return;
      }
      // 查找替换在输入框里也能唤起（旧版 onFind 无输入态让路）
      if (ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        const s = useEditor.getState();
        s.update({ overlay: s.overlay === "find" ? "none" : "find" });
        return;
      }
      // 空格恒为播放 / 暂停：只有在真正录入文字的框里（文本框 / 文本类 input）才让位给空格，
      // 否则即便焦点停在某根滑块或按钮上，按空格也只触发播放，不会翻页或选中
      if (e.key === " " && !ctrl && !e.altKey && !isTextEntry && !target.isContentEditable) {
        e.preventDefault();
        // 鼠标点过滑块 / 按钮后焦点仍停在它身上，按空格会点亮 :focus-visible 的橙色焦点框。
        // 播放的同时把焦点收掉，框就不会冒出来；键盘 Tab 用户仍保留 :focus-visible 样式。
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && /^(BUTTON|INPUT|SELECT)$/.test(active.tagName)) {
          active.blur();
        }
        runCommand("preview.toggle");
        return;
      }
      // 组合快捷键在文本输入时同样生效（Ctrl+T 加字幕、Ctrl+B 切分、Ctrl+E 合并、撤销重做…）。
      // 只有不带 Ctrl / ⌘ 的裸键才让位给输入框，避免打字时误触发删除、裁剪与方向键跳转。
      if (typing && !ctrl) return;

      if (ctrl) {
        if (e.altKey) return;
        const key = e.key.toLowerCase();
        // 只保留旧版有的组合键
        if (e.shiftKey) {
          if (key === "z") { e.preventDefault(); runCommand("redo"); }
          return;
        }
        if (key === "z") { e.preventDefault(); runCommand("undo"); return; }
        if (key === "y") { e.preventDefault(); runCommand("redo"); return; }
        if (key === "t") { e.preventDefault(); runCommand("subtitle.insert"); return; }
        if (key === "b") { e.preventDefault(); runCommand("clip.split"); return; }
        if (key === "e") { e.preventDefault(); runCommand("subtitle.merge"); return; }
        return;
      }

      const state = useEditor.getState();
      const doc = state.doc;
      const fps = doc.video.fps || 30;
      const fm = 1000 / fps;
      const quantize = (ms: number) => Math.max(0, Math.round(ms / fm) * fm);

      switch (e.key) {
        case "Delete": runCommand("clip.delete"); break;
        case "q": case "Q": trimAtPlayhead("q"); break;
        case "w": case "W": trimAtPlayhead("w"); break;
        case "i": case "I": runCommand("range.start"); break;
        case "o": case "O": runCommand("range.end"); break;
        case "p": case "P": runCommand("range.clear"); break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          // Shift 5 秒 > Alt 1 秒 > Ctrl 5 帧 > 裸键 1 帧
          const step = e.shiftKey ? 5000 : e.altKey ? 1000 : fm;
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          state.seekTo(quantize(quantize(state.playheadMs) + dir * step));
          break;
        }
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const points = new Set<number>();
          for (const track of doc.tracks) for (const clip of track.clips) points.add(Math.round(clip.startMs));
          const sorted = [...points].sort((a, b) => a - b);
          if (!sorted.length) break;
          const current = quantize(state.playheadMs);
          const eps = fm / 2;
          if (e.key === "ArrowUp") {
            const prev = [...sorted].reverse().find((p) => p < current - eps);
            if (prev !== undefined) state.seekTo(prev);
          } else {
            const next = sorted.find((p) => p > current + eps);
            if (next !== undefined) state.seekTo(next);
          }
          break;
        }
        case "Home": e.preventDefault(); state.seekTo(0); break;
        case "End": e.preventDefault(); state.seekTo(playheadEndMs(doc)); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand]);

  /* ---------------------------------------------------- 拖动分隔条 */

  const startResize = (mode: "left" | "right" | "bottom") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseL = leftW;
    const baseR = rightW;
    const baseB = bottomH;
    let latest = 0;
    document.documentElement.classList.add("jeek-resizing");
    const move = (ev: MouseEvent) => {
      if (mode === "left") { latest = Math.max(LEFT_MIN, Math.min(520, baseL + ev.clientX - startX)); setLeftW(latest); }
      if (mode === "right") { latest = Math.max(260, Math.min(620, baseR - (ev.clientX - startX))); setRightW(latest); }
      if (mode === "bottom") { latest = Math.max(BOTTOM_MIN, Math.min(window.innerHeight - 320, baseB - (ev.clientY - startY))); setBottomH(latest); }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.documentElement.classList.remove("jeek-resizing");
      if (latest) saveLayout(mode, latest);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const resetSizes = () => {
    clearLayout();
    setLeftW(LEFT_MIN);
    setRightW(304);
    setBottomH(BOTTOM_MIN);
  };

  return (
    <div className="jeek-app">
      <Header onCommand={runCommand} />

      <main className="jeek-main">
        <Toolbar onCommand={runCommand} />

        <div className="jeek-workspace">
          <div className="jeek-col jeek-col-left" style={{ width: leftW }}>
            <LeftPanel onCommand={runCommand} />
          </div>

          <div
            className="jeek-split jeek-split-v"
            title="拖动调整区域大小 · 双击恢复默认"
            onMouseDown={startResize("left")}
            onDoubleClick={resetSizes}
          />

          <div className="jeek-col jeek-col-center">
            <Preview onCommand={runCommand} />
          </div>

          <div
            className="jeek-split jeek-split-v"
            title="拖动调整区域大小 · 双击恢复默认"
            onMouseDown={startResize("right")}
            onDoubleClick={resetSizes}
          />

          <div className="jeek-col jeek-col-right" style={{ width: rightW }}>
            <SubtitleList />
          </div>
        </div>

        <div
          className="jeek-split jeek-split-h"
          title="拖动调整区域大小 · 双击恢复默认"
          onMouseDown={startResize("bottom")}
          onDoubleClick={resetSizes}
        />

        <div className="jeek-bottom" style={{ height: bottomH }}>
          <Timeline onCommand={runCommand} />
          <AddBar />
        </div>
      </main>

      <TipLayer />

      {toast && <div className="jeek-toast">{toast}</div>}

      {overlay === "settings" && <SettingsPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "export" && <ExportPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "record" && <RecordPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "asr" && <AsrPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "modules" && <ModulePanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "find" && <FindPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "fonts" && <FontPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "trackSubtitle" && <TrackSubtitlePanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}
      {overlay === "trackAudio" && <TrackAudioPanel onClose={() => useEditor.getState().update({ overlay: "none" })} />}

      <span className="jeek-audio">
        <input
          ref={audioInputRef} type="file" accept="audio/*" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importAudio(file);
            e.target.value = "";
          }}
        />
      </span>
      <span className="jeek-subtitle-file">
        <input
          ref={subtitleInputRef} type="file" accept=".srt,.txt,.vtt,.json,text/plain" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importSubtitles(file);
            e.target.value = "";
          }}
        />
      </span>
      <span className="jeek-project">
        <input
          ref={projectInputRef} type="file" accept=".jeek,.json" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadProject(file);
            e.target.value = "";
          }}
        />
      </span>
      <span className="jeek-font-file">
        <input
          ref={fontInputRef} type="file" accept=".ttf,.otf,.woff,.woff2" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFont(file);
            e.target.value = "";
          }}
        />
      </span>

      {!ready && <div className="jeek-toast">正在加载模块…</div>}
    </div>
  );
}
