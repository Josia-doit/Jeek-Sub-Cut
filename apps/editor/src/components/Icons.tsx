/** 界面图标：统一 24×24 viewBox、描边风格，与整体视觉一致 */
interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconUpload = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const IconExport = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

/** 导入字幕：记事本（左侧装订环 + 三条文本线），强调「读入文件」而不是方向箭头 */
export const IconNotebook = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4.5" y="2.5" width="15" height="19" rx="2.4" />
    <path d="M2 7h2.5M2 12h2.5M2 17h2.5" />
    <path d="M9 8h6M9 12h6M9 16h3.5" />
  </svg>
);

/** 导入工程：打开的文件夹 */
export const IconFolderOpen = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.8 8V5.6a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.7.9l.9 1.4h6.5a2 2 0 0 1 2 2V9" />
    <path d="M2.8 9.4h17.6a1.6 1.6 0 0 1 1.55 2l-1.5 6.4a2 2 0 0 1-1.95 1.55H5.1a2 2 0 0 1-1.96-1.6L2.8 9.4Z" />
  </svg>
);

/** 导出工程：软盘（保存到文件） */
export const IconSave = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M15.2 2.8a2 2 0 0 1 1.42.6l3.98 3.98a2 2 0 0 1 .59 1.41V19a2 2 0 0 1-2 2H4.8a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2h10.4Z" />
    <path d="M16.6 21v-6.4a1.4 1.4 0 0 0-1.4-1.4H8.8a1.4 1.4 0 0 0-1.4 1.4V21" />
    <path d="M7.4 2.8v3.9a1.3 1.3 0 0 0 1.3 1.3h5.6" />
  </svg>
);

/** 导出字幕：文件 + 向下箭头 */
export const IconFileDown = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M14.6 2.6H6.4a2 2 0 0 0-2 2v14.8a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2V7.6l-5-5Z" />
    <path d="M14.4 2.8v4.6a1 1 0 0 0 1 1h4.6" />
    <path d="M12 17.6v-5.2" />
    <path d="m9.4 14.8 2.6 2.8 2.6-2.8" />
  </svg>
);

export const IconMusic = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);

export const IconMic = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

export const IconSliders = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);

export const IconSun = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="4" />
    <line x1="12" y1="20" x2="12" y2="22" />
    <line x1="4.9" y1="4.9" x2="6.3" y2="6.3" />
    <line x1="17.7" y1="17.7" x2="19.1" y2="19.1" />
    <line x1="2" y1="12" x2="4" y2="12" />
    <line x1="20" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="19.1" x2="6.3" y2="17.7" />
    <line x1="17.7" y1="6.3" x2="19.1" y2="4.9" />
  </svg>
);

export const IconMoon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

/** 窗口控制图标（去原生标题栏后界面自绘）：最小化 / 最大化 / 向下还原 / 关闭 */
export const IconMinimize = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconMaximize = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
  </svg>
);

export const IconRestore = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="5" y="8" width="11" height="11" rx="1.4" />
    <path d="M8 8V5.5a1.5 1.5 0 0 1 1.5-1.5H19a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5H16" />
  </svg>
);

export const IconClose = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
);

export const IconPlay = ({ size = 25 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 4.5a1 1 0 0 1 1.53-.85l11 7a1 1 0 0 1 0 1.7l-11 7A1 1 0 0 1 6 18.5z" />
  </svg>
);

export const IconPause = ({ size = 25 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" rx="1.2" />
    <rect x="14" y="4" width="4" height="16" rx="1.2" />
  </svg>
);

export const IconVolume = ({ size = 25 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const IconMuted = ({ size = 25 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none" />
    <line x1="16" y1="9" x2="21" y2="15" />
    <line x1="21" y1="9" x2="16" y2="15" />
  </svg>
);

export const IconFullscreen = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8V5a2 2 0 0 1 2-2h3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
  </svg>
);

/* ------------------------------------------------------------------
   时间轴工具条：统一 24×24 描边线稿，与上面一套图标同风格
   ------------------------------------------------------------------ */

/** 自动填充 / 消除缝隙：向左向右把卡片拉开或并拢 */
export const IconFillGap = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 12h20" />
    <path d="M6 8 2 12l4 4M18 8l4 4-4 4" />
  </svg>
);

/** 同步：两个环环相扣的链节，声画对位 */
export const IconLink = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M10.2 13.8a4.6 4.6 0 0 0 6.6.4l2.3-2.3a4.6 4.6 0 0 0-6.5-6.5l-1.4 1.4" />
    <path d="M13.8 10.2a4.6 4.6 0 0 0-6.6-.4l-2.3 2.3a4.6 4.6 0 0 0 6.5 6.5l1.4-1.4" />
  </svg>
);

/** 自动排序：两条卡片向左贴齐同一条起跑线 */
export const IconPackLeft = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.5 3v18" />
    <rect x="8" y="4" width="13" height="6" rx="1.4" />
    <rect x="8" y="14" width="9" height="6" rx="1.4" />
  </svg>
);

/** 语音转字幕：一串高低起伏的声波条，表示「把声音变成字」 */
export const IconWaveText = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.5 10v4M6.5 6.5v11M10.5 3.5v17M14.5 7.5v9M18.5 9v6M21.5 10.5v3" />
  </svg>
);

/** 导出范围起点：左竖线 + 朝右指的箭头（示意「从这里开始」） */
export const IconRangeStart = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M5 4v16" />
    <path d="M5 12h11" />
    <path d="M12 8l4 4-4 4" />
  </svg>
);

/** 导出范围终点：右竖线 + 朝左指的箭头（示意「到此为止」） */
export const IconRangeEnd = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M19 4v16" />
    <path d="M8 12h11" />
    <path d="M12 8l-4 4 4 4" />
  </svg>
);

/** 清除范围：虚线框 + 叉 */
export const IconRangeClear = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 3" />
    <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
  </svg>
);

/** 切分：剪刀 */
export const IconScissors = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="6" cy="18" r="2.6" />
    <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
  </svg>
);

/** 合并选中：两张相邻卡片向中间并成一张（左右箭头相向 + 中间合并线） */
export const IconMerge = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="2" y="7" width="7" height="10" rx="1.4" />
    <rect x="15" y="7" width="7" height="10" rx="1.4" />
    <path d="M9.2 12h5.6" />
    <path d="M11.2 9.8 9 12l2.2 2.2M12.8 9.8 15 12l-2.2 2.2" />
  </svg>
);

/** 撤销：向左回勾的箭头 */
export const IconUndo = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    <path d="M8 4 3 9l5 5" />
  </svg>
);

/** 重做：撤销的镜像 */
export const IconRedo = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    <path d="M16 4l5 5-5 5" />
  </svg>
);

/** 删除：垃圾桶 */
export const IconTrash = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3.5 6h17" />
    <path d="M8.5 6V4.2c0-.66.54-1.2 1.2-1.2h4.6c.66 0 1.2.54 1.2 1.2V6" />
    <path d="M6.4 6l.9 13.1c.05.7.63 1.4 1.34 1.4h6.72c.7 0 1.3-.7 1.34-1.4L17.6 6" />
    <path d="M10.2 10.5v6M13.8 10.5v6" />
  </svg>
);

/** 添加字幕：字幕框 + 右下角加号 */
export const IconSubtitleAdd = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="2.5" y="3.8" width="14" height="9" rx="2" />
    <path d="M6 7.4h7M9.5 7.4v2.6" />
    <path d="M18.8 13.6v6.4M15.6 16.8h6.4" />
  </svg>
);

/** 编辑：一支斜放的笔 */
export const IconPencil = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20h4l10.3-10.3a2.1 2.1 0 0 0 0-3L16.3 4.7a2.1 2.1 0 0 0-3 0L3 15v5Z" />
    <path d="M13.6 6.4l4 4" />
  </svg>
);

/** 设置：齿轮 */
export const IconGear = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64h.08A1.7 1.7 0 0 0 10.1 3.08V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
  </svg>
);

/** 字形：加粗 B */
export const IconBold = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7Z" />
    <path d="M7 12h6.8a3.75 3.75 0 0 1 0 7.5H7Z" />
  </svg>
);

/** 字形：倾斜 I */
export const IconItalic = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M15 4.5h-5M14 19.5H9M13.6 4.5 10.4 19.5" />
  </svg>
);

/** 字形：下划线 U */
export const IconUnderline = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M7 4.5v7a5 5 0 0 0 10 0v-7" />
    <path d="M5 20h14" />
  </svg>
);

/** 字形：删除线 S */
export const IconStrike = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 12h16" />
    <path d="M7.4 8.1A3.6 3.6 0 0 1 10.6 5.5h3.1a3.4 3.4 0 0 1 3.4 3.4" />
    <path d="M7 14.4a3.6 3.6 0 0 0 3.6 3.6h2.8a3.6 3.6 0 0 0 3.6-3.6" />
  </svg>
);
