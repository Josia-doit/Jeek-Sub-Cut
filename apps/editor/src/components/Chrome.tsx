import { setSetting } from "@jeek/core";
import { useEditor } from "../store";
import { sortedSubtitles } from "../lib/srt";
import { useEffect, useState } from "react";
import { IconClose, IconExport, IconFileDown, IconFolderOpen, IconGear, IconMaximize, IconMic, IconMinimize, IconMoon, IconMusic, IconNotebook, IconRestore, IconSave, IconSun } from "./Icons";
import { hasDesktopBridge, onWindowMaximizedChange, getWindowMaximized, windowControl } from "../lib/bridge";

const ASPECT_LABEL: Record<string, string> = {
  landscape: "16:9",
  portrait: "9:16",
  square: "1:1",
  standard: "4:3",
  story: "4:5",
  wide: "21:9",
};

const RESOLUTION_LABEL: Record<string, string> = {
  "1080P": "1920×1080",
  "1440P": "2560×1440",
  "2160P": "3840×2160",
};

/** 顶栏：品牌、设置、主题、导出 */
export function Header({ onCommand }: { onCommand: (name: string) => void }) {
  const theme = useEditor((s) => s.theme);
  const doc = useEditor((s) => s.doc);
  const empty = sortedSubtitles(doc).length === 0;

  return (
    <header
      className="jeek-header"
      onDoubleClick={(e) => {
        // 双击顶栏空白处切换最大化；点在品牌或按钮上不触发，避免误触
        if ((e.target as HTMLElement).closest(".jeek-brand, .jeek-header-actions")) return;
        windowControl("toggle-maximize");
      }}
    >
      <div className="jeek-header-inner">
        <button
          className="jeek-brand"
          title="吉客AI 的主页"
          onClick={() => window.open("https://space.bilibili.com/3706973113551694", "_blank")}
        >
          <img className="jeek-logo" src="./icon.svg" alt="" />
          <span className="jeek-brand-txt">
            <span className="jeek-brand-name">吉客字幕剪辑</span>
            <span className="jeek-brand-sub">
              <i className="jeek-brand-dash" />
              <span className="jeek-brand-sub-text">Jeek Sub Cut</span>
              <i className="jeek-brand-dash" />
            </span>
          </span>
        </button>

        <div className="jeek-header-actions">
          <button className="jeek-icon-btn" data-act="settings.open" title="设置" aria-label="设置" onClick={() => onCommand("settings.open")}>
            <IconGear />
          </button>
          <button
            className="jeek-icon-btn"
            title={theme === "dark" ? "浅色" : "深色"}
            aria-label="切换浅色/深色主题"
            onClick={() => {
              const next = useEditor.getState().theme === "dark" ? "light" : "dark";
              useEditor.getState().update({ theme: next });
              document.documentElement.classList.toggle("dark", next === "dark");
            }}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            className="jeek-export-btn"
            title={empty ? "先添加字幕再导出" : "导出视频"}
            disabled={empty}
            onClick={() => onCommand("export.open")}
          >
            <IconExport />
            <span>导出视频</span>
          </button>
          {hasDesktopBridge() && <WindowControls />}
        </div>
      </div>
    </header>
  );
}

/** 工具行：导入、音频、录音、工程项目、字幕导出与当前规格 */
/** 自绘窗口控制：仅桌面壳（有桥）时显示；浏览器里跑不出现，也不影响布局。 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let off = () => {};
    void getWindowMaximized().then((v) => setMaximized(v));
    off = onWindowMaximizedChange((v) => setMaximized(v));
    return () => off();
  }, []);
  return (
    <div className="jeek-win-ctrls">
      <button className="jeek-win-min" type="button" title="最小化" aria-label="最小化" onClick={() => windowControl("minimize")}>
        <IconMinimize />
      </button>
      <button
        className="jeek-win-max"
        type="button"
        title={maximized ? "向下还原" : "最大化"}
        aria-label={maximized ? "向下还原" : "最大化"}
        onClick={() => windowControl("toggle-maximize")}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </button>
      <button className="jeek-win-close" type="button" title="关闭" aria-label="关闭" onClick={() => windowControl("close")}>
        <IconClose />
      </button>
    </div>
  );
}

export function Toolbar({ onCommand }: { onCommand: (name: string) => void }) {
  const doc = useEditor((s) => s.doc);
  const recording = useEditor((s) => s.recording);
  const subtitleSourceName = useEditor((s) => s.subtitleSourceName);
  const audioName = useEditor((s) => s.doc.assets.find((a) => a.kind === "audio")?.uri ?? null);
  const count = sortedSubtitles(doc).length;
  const aspect = ASPECT_LABEL[String(doc.settings.aspect ?? "landscape")] ?? "16:9";
  const resolution = RESOLUTION_LABEL[String(doc.settings.resolution ?? "1080P")] ?? "1920×1080";

  return (
    <div className="jeek-toolbar">
      <button
        className="jeek-tool-ico"
        data-act="import.open"
        aria-label="导入字幕"
        data-tip="导入字幕文件：读取 SRT / VTT / TXT / JSON 里的时间码，按原时间铺到字幕轨上。"
        onClick={() => onCommand("import.open")}
      >
        <IconNotebook size={18} />
      </button>
      <button
        className="jeek-tool-ico"
        data-act="audio.import"
        aria-label="载入音频"
        data-tip="载入音频文件，音轨会自动铺满整条轨道并生成波形；可再切分、裁剪、对齐字幕。"
        onClick={() => onCommand("audio.import")}
      >
        <IconMusic size={18} />
      </button>
      <button
        className={`jeek-tool-ico ${recording ? "is-recording" : ""}`}
        data-act="audio.record"
        aria-label={recording ? "停止录音" : "录音"}
        data-tip={recording ? "正在录音，点此结束；片段追加到音轨末尾。" : "录音：打开录音面板，点面板里的「开始录制」；录完的片段追加到音轨末尾。"}
        onClick={() => onCommand("audio.record")}
      >
        <IconMic size={18} />
      </button>

      <span className="jeek-tool-sep" />

      <button
        className="jeek-tool-ico"
        data-act="project.open"
        aria-label="导入工程"
        data-tip="导入工程：打开之前用「导出工程」存下的 .jeek 工程文件，恢复字幕、音频与全部样式设置。"
        onClick={() => onCommand("project.open")}
      >
        <IconFolderOpen size={18} />
      </button>
      <button
        className="jeek-tool-ico"
        data-act="export.project"
        aria-label="导出工程"
        data-tip="导出工程：把当前的字幕、音频引用与全部设置存成 .jeek 文件，之后可以原样导入继续编辑。"
        onClick={() => onCommand("export.project")}
      >
        <IconSave size={18} />
      </button>

      <span className="jeek-tool-sep" />

      <button
        className="jeek-tool-ico"
        data-act="export.srt"
        aria-label="导出字幕"
        data-tip="导出字幕：按右侧选择的格式把全部字幕存成文本文件；格式只在导出时生效，不影响工程内容。"
        onClick={() => onCommand("export.srt")}
      >
        <IconFileDown size={18} />
      </button>
      <select
        className="jeek-sub-export-fmt"
        value={String(doc.settings.subtitleExportFormat ?? "srt")}
        data-tip="字幕导出格式：SRT 兼容大多数剪辑软件；VTT 用于网页；TXT 只有纯文本；JSON 保留完整字段便于二次处理。"
        onChange={(e) => {
          const state = useEditor.getState();
          state.commit("设置字幕导出格式", setSetting(state.doc, "subtitleExportFormat", e.target.value));
        }}
      >
        <option value="srt">SRT</option>
        <option value="vtt">VTT</option>
        <option value="txt">TXT</option>
        <option value="json">JSON</option>
      </select>

      {audioName && (
        <span className="jeek-audio-tag" title={`音频：${audioName}`}>
          <span className="jeek-audio-tag-name">{audioName}</span>
          <button
            className="jeek-audio-tag-x"
            onClick={() => onCommand("audio.close")}
            title="关闭音频（清空音轨，之后的录音不会拼接旧音频）"
          >
            ✕
          </button>
        </span>
      )}

      {count > 0 && (
        <span className="jeek-sub-tag" title={subtitleSourceName ?? "关闭字幕（仅移除字幕，不影响音频）"}>
          <span className="jeek-sub-tag-name">{subtitleSourceName || "字幕"}</span>
          <button className="jeek-sub-tag-x" onClick={() => onCommand("subtitle.clear")} title="关闭字幕">
            ✕
          </button>
        </span>
      )}

      {count > 0 && <span className="jeek-loaded-note">{count} 条字幕已加载</span>}

      <span className="jeek-video-meta" title="在右上角设置中修改视频比例、帧率与导出分辨率">
        {aspect} · {doc.video.fps} fps · {resolution}
      </span>
    </div>
  );
}
