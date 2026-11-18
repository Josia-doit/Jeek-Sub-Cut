import { useEffect, useRef, useState } from "react";
import type { ProjectDocument } from "@jeek/contracts";
import { applyGlobalEnter, applyRotationPlan, mergeFontEntries, patchClip } from "@jeek/core";
import { DEFAULT_ENTER_DURATION_MS, useEditor } from "../store";
import { fontCnName } from "../lib/fonts";
import { pathForFile, readImagePath } from "../lib/bridge";
import { snappedRangeValue } from "../lib/range-snap";

const ENTER_ANIMATIONS = [
  "无", "淡入淡出", "上滑入", "左滑入", "缩放", "弹出", "弹跳上浮", "模糊入",
  "摆动入", "打字机", "落下", "旋转入", "缩小退场", "弹性弹出", "上浮淡入",
];

const SUBTITLE_STYLES = [
  { value: "custom", label: "自定义字号" },
  { value: "fill", label: "等宽字幕" },
  { value: "fit", label: "屏幕适配" },
  { value: "duo", label: "双层文字" },
  { value: "particle", label: "粒子飘散" },
] as const;

const ROTATION_MODES = [
  { value: "auto", label: "随机旋转" },
  { value: "alternate", label: "交替旋转" },
  { value: "off", label: "不旋转" },
] as const;

const DEFAULT_PALETTE = ["#FFF4B5", "#FFB4A2", "#A0E7E5", "#B8C0FF", "#CDE77F"];

/** 文字描边：三种层数 / 位置，颜色与粗细另设 */
const STROKE_STYLES = [
  { value: "outer", label: "单层外描边" },
  { value: "double", label: "双层描边（外深内浅）" },
  { value: "inner", label: "内描边" },
] as const;

const STROKE_PRESETS = [
  { hex: "#000000", label: "纯黑" },
  { hex: "#ffffff", label: "纯白" },
  { hex: "#ff3b30", label: "正红" },
  { hex: "#2f6bff", label: "亮蓝" },
] as const;

/** 画布背景预设：黑、白 + 两个常用色，点一下直接套用，色值框与拾色器一起跟着变 */
const CANVAS_PRESETS = [
  { hex: "#000000", label: "纯黑" },
  { hex: "#ffffff", label: "纯白" },
  { hex: "#1b2a4a", label: "深海蓝" },
  { hex: "#f5e7d0", label: "米杏" },
] as const;

/**
 * 连续拖动滑块时先改文档、松手才入撤销栈：
 * 否则一次拖动会灌进几十条命令，撤销要点很多下。
 */
function useTransientSetting() {
  const store = useEditor;
  const dirty = useRef(false);

  const preview = (key: string, value: unknown) => {
    const s = store.getState();
    s.previewSetting(key, value);
    dirty.current = true;
  };
  const commit = (label: string) => {
    if (!dirty.current) return;
    dirty.current = false;
    store.getState().commitSettingDraft(label);
  };
  return { preview, commit };
}

function RangeRow({
  label,
  value,
  suffix,
  min,
  max,
  step = 1,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  suffix?: string;
  min: number;
  max: number;
  step?: number;
  onPreview: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <div>
      <label className="jeek-pos-label">
        <span>{label}</span>
        <span className="jeek-pos-val">
          {Math.round(value)}
          {suffix ?? ""}
        </span>
      </label>
      <input
        className="jeek-pos-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-snap="1"
        onChange={(e) => onPreview(snappedRangeValue(e))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
    </div>
  );
}

/** 百分比滑竿：1% 一档共 100 格，10 的倍数附近轻吸附（按住 Alt 临时不吸附）；两侧带 −/＋ 步进按钮 */
function PercentRow({
  label,
  value,
  min = 0,
  max = 100,
  tip,
  onPreview,
  onCommit,
  onStep,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  tip?: string;
  onPreview: (v: number) => void;
  onCommit: () => void;
  onStep: (v: number) => void;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
  return (
    <div data-tip={tip}>
      <div className="jeek-pos-label">
        <span>{label}</span>
        <span className="jeek-pos-stepper">
          <button type="button" className="jeek-pos-step" aria-label="减 1%" onClick={() => onStep(clamp(value - 1))}>−</button>
          <span className="jeek-pos-val">{Math.round(value)}%</span>
          <button type="button" className="jeek-pos-step" aria-label="加 1%" onClick={() => onStep(clamp(value + 1))}>＋</button>
        </span>
      </div>
      <input
        className="jeek-pos-range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        data-snap="1"
        onChange={(e) => onPreview(clamp(snappedRangeValue(e)))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
    </div>
  );
}

/** 左栏：画布与全局样式 */
export function LeftPanel({ onCommand }: { onCommand: (name: string) => void }) {
  const doc = useEditor((s) => s.doc);
  const setSetting = useEditor((s) => s.setSetting);
  const fileRef = useRef<HTMLInputElement>(null);
  const { preview, commit } = useTransientSetting();

  const settings = doc.settings as Record<string, unknown>;
  const background = String(settings.background ?? "solid");
  const color = String(settings.backgroundColor ?? "#000000");
  const posY = Number(settings.subtitleY ?? 50);
  const posX = Number(settings.subtitleX ?? 30);
  const style = String(settings.subtitleStyle ?? "fit");
  const fitRatio = Number(settings.fitRatio ?? 80);
  const duoBackdropScale = Number(settings.duoBackdropScale ?? 9);
  const duoFrontScale = Number(settings.duoFrontScale ?? 5);
  const particleSize = Number(settings.particleSize ?? 10);
  const particleGatherMs = Number(settings.particleGatherMs ?? 900);
  const particleScatterMs = Number(settings.particleScatterMs ?? 900);
  const particleSpread = Number(settings.particleSpread ?? 100);
  const particleDensity = Number(settings.particleDensity ?? 3);
  const fontFamily = String(settings.fontFamily ?? "Microsoft YaHei");
  const fontCatalog = useEditor((s) => s.fontCatalog);
  const fontOptions = mergeFontEntries(fontCatalog);
  const enter = String(settings.enterAnimation ?? "打字机");
  const enterDurationMs = Number(settings.enterDurationMs ?? DEFAULT_ENTER_DURATION_MS);
  const rotationMode = String(settings.rotationMode ?? "auto");
  const rotationInterval = Number(settings.rotationInterval ?? 0);
  const palette = (Array.isArray(settings.palette) ? settings.palette : DEFAULT_PALETTE) as string[];
  const strokeEnabled = Boolean(settings.strokeEnabled ?? false);
  const strokeStyle = String(settings.strokeStyle ?? "outer");
  const strokeColor = String(settings.strokeColor ?? "#ffffff");
  const strokeColor2 = String(settings.strokeColor2 ?? "#ffffff");
  const strokeWidth = Number(settings.strokeWidth ?? 5);

  /** 背景图路径栏：显示当前图片的物理地址，可粘贴后回车改图 */
  const [imagePath, setImagePath] = useState("");
  const [imagePathError, setImagePathError] = useState("");
  const [imageBusy, setImageBusy] = useState(false);

  /** 恢复默认要按两次：第一次只把按钮变成「确认恢复」，4 秒内不再点就退回 */
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  const resetPalette = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setSetting("palette", [...DEFAULT_PALETTE]);
    useEditor.getState().notify("调色板已恢复默认颜色");
  };

  /** 随机分配：从调色板里给每条字幕随机取一个颜色 */
  const assignRandomColors = () => {
    const state = useEditor.getState();
    const colors = palette.length ? palette : DEFAULT_PALETTE;
    let next = state.doc;
    let count = 0;
    for (const track of next.tracks) {
      if (track.kind !== "subtitle") continue;
      for (const clip of track.clips) {
        const color = colors[Math.floor(Math.random() * colors.length)];
        next = patchClip(next, clip.id, { color });
        count += 1;
      }
    }
    if (!count) {
      state.notify("还没有字幕，先添加或导入字幕再随机分配");
      return;
    }
    // 同时按当前「随机移动」设置重排旋转：随机旋转方向随机、交替旋转顺逆交替，
    // 不论字幕是导入的、识别转换的、手动添加的还是拆分的，都按统一规则分配旋转。
    const rotated = applyRotationPlan(next);
    state.commit("随机分配颜色与旋转", rotated);
    state.notify(`已按调色板给 ${count} 条字幕随机上色并分配旋转`);
  };

  /** 剥掉粘贴地址外层的引号（资源管理器「复制文件地址」会给带双引号的路径）与 file:// 前缀 */
  const normalizeImagePath = (raw: string): string => raw
    .trim()
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .trim()
    .replace(/^file:\/\/\//i, "")
    .replace(/^file:\/\//i, "");

  /** 图片数据到手后统一走这里：交给画布、切到图片模式、回填路径栏 */
  const applyImage = (src: string, label: string, errorText = "路径错误") => {
    const image = new Image();
    image.onload = () => {
      useEditor.getState().update({ backgroundImage: image });
      setSetting("background", "image");
      setImagePath(label);
      setImagePathError("");
      useEditor.getState().notify(`已载入背景图 ${label.split(/[\\/]/).pop()}`);
    };
    image.onerror = () => setImagePathError(errorText);
    image.src = src;
  };

  /** 文件输入框选中后：桌面端先拿到物理路径回填路径栏，再按路径读成同源数据；
   *  浏览器端没有物理路径，退回 blob URL，路径栏显示文件名。 */
  const pickImage = async (file: File) => {
    const physical = pathForFile(file);
    if (!physical) {
      applyImage(URL.createObjectURL(file), file.name, "背景图载入失败");
      return;
    }
    setImagePath(physical);
    setImageBusy(true);
    try {
      const res = await readImagePath(physical);
      if (!res.ok || !res.dataUrl) {
        setImagePathError("路径错误");
        return;
      }
      applyImage(res.dataUrl, res.path ?? physical);
    } finally {
      setImageBusy(false);
    }
  };

  /** 路径栏回车确认：粘一个物理地址就能换图，地址无效提示「路径错误」 */
  const commitImagePath = async () => {
    const cleaned = normalizeImagePath(imagePath);
    if (!cleaned) {
      setImagePathError("路径错误");
      return;
    }
    setImagePath(cleaned);
    setImageBusy(true);
    try {
      const res = await readImagePath(cleaned);
      if (!res.ok || !res.dataUrl) {
        setImagePathError("路径错误");
        return;
      }
      applyImage(res.dataUrl, res.path ?? cleaned);
    } finally {
      setImageBusy(false);
    }
  };

  /** 上传按钮：随时都能点，选完就把物理路径回填到路径栏并换成新背景 */
  const uploadImage = () => {
    if (imageBusy) return;
    fileRef.current?.click();
  };

  return (
    <>
      {/* ---------------- 画布 ---------------- */}
      <div className="jeek-card jeek-space-y4">
        <i className="jeek-card-bar" />

        <div className="jeek-seg">
          {[
            { value: "solid", label: "纯色" },
            { value: "image", label: "图片" },
            { value: "transparent", label: "透明" },
          ].map((item) => (
            <button
              key={item.value}
              className={background === item.value ? "is-on" : ""}
              data-tip={item.value === "solid"
                ? "纯色背景：用下方的取色盘、十六进制色值或预设色块设定画布底色。"
                : item.value === "image"
                  ? "图片背景：选中后用下方的路径栏粘一个图片地址，或点「上传图像」重新选一张，随时可以更换。"
                  : "透明背景：画布不带底色也不带图片，导出带透明通道的视频时用它。"}
              onClick={() => setSetting("background", item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {background === "solid" && (
          <div className="jeek-color-row">
            <input
              type="color"
              value={color.toLowerCase()}
              onChange={(e) => setSetting("backgroundColor", e.target.value.toLowerCase())}
              data-tip="背景颜色：点开取色盘随意调，右侧同步显示十六进制色值；点右侧的预设色也会跟着变。"
            />
            <input
              className="jeek-hex-input"
              type="text"
              value={color}
              maxLength={7}
              onChange={(e) => setSetting("backgroundColor", e.target.value)}
              data-tip="十六进制色值：也可以直接粘一个 #RRGGBB。"
            />
            <div className="jeek-preset-row">
              {CANVAS_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  className={`jeek-preset ${color.toLowerCase() === preset.hex ? "is-on" : ""}`}
                  style={{ background: preset.hex }}
                  aria-label={preset.label}
                  data-tip={`${preset.label} ${preset.hex}：点一下就把画布背景设成这个颜色，色值与左侧拾色器同步跟着变。`}
                  onClick={() => setSetting("backgroundColor", preset.hex)}
                />
              ))}
            </div>
          </div>
        )}

        {background === "image" && (
          <div className="jeek-bg-image-panel">
            <div className="jeek-bg-image-row">
              <input
                className="jeek-bg-path-input"
                type="text"
                value={imagePath}
                placeholder="粘贴图片完整路径后按回车"
                spellCheck={false}
                data-act="background.path"
                data-tip="图片路径：显示当前背景图的物理地址。可以直接粘贴一个图片文件的完整路径（带双引号、带 file:// 前缀也能识别），按回车确认后立刻换图；地址不对会提示「路径错误」。"
                onChange={(e) => {
                  setImagePath(e.target.value);
                  setImagePathError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitImagePath();
                  }
                }}
              />
              <button
                className="jeek-btn-secondary"
                style={{ height: 32, flex: "none" }}
                disabled={imageBusy}
                data-act="background.upload"
                data-tip="上传图像：打开系统文件窗口选一张图片，选好后把它的完整路径回填到左边的路径栏并立刻换成新背景。已经设过图片也能反复点，随时更换。"
                onClick={uploadImage}
              >
                上传图像
              </button>
            </div>
            {imagePathError && (
              <div
                className="jeek-bg-path-error"
                data-tip="请确认地址指向一个真实存在的图片文件，支持 png / jpg / jpeg / webp / bmp / gif / avif / svg；也可以直接点「上传图像」从文件窗口里选。"
              >
                {imagePathError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------- 全局样式 ---------------- */}
      <div className="jeek-card jeek-space-y4">
        <i className="jeek-card-bar jeek-card-bar-alt" />

        <div>
          <label className="jeek-field">字幕风格</label>
          <select
            className="jeek-select"
            value={style}
            onChange={(e) => setSetting("subtitleStyle", e.target.value)}
          >
            {SUBTITLE_STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="jeek-divider jeek-space-y3">
          {style === "duo" ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>双层文字大小</div>
              <div style={{ marginBottom: 14 }}>
                <PercentRow
                  label="衬底文字"
                  value={duoBackdropScale}
                  min={2}
                  max={60}
                  tip="底层半透明大字的文字高度占画面高度的百分比，默认 9%。所有句子用同一字号，宽度随内容自适应；两层都居中，以画面中心为原点缩放；1% 一档，按住 Alt 临时取消吸附。"
                  onPreview={(v) => preview("duoBackdropScale", v)}
                  onCommit={() => commit("衬底文字")}
                  onStep={(v) => { preview("duoBackdropScale", v); commit("衬底文字"); }}
                />
              </div>
              <PercentRow
                label="顶层文字"
                value={duoFrontScale}
                min={1}
                max={40}
                tip="顶层实色小字的文字高度占画面高度的百分比，默认 5%。与衬底文字同为同一句话、都居中、同一字号口径；1% 一档，按住 Alt 临时取消吸附。"
                onPreview={(v) => preview("duoFrontScale", v)}
                onCommit={() => commit("顶层文字")}
                onStep={(v) => { preview("duoFrontScale", v); commit("顶层文字"); }}
              />
            </>
          ) : style === "particle" ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>粒子飘散</div>
              <div style={{ marginBottom: 14 }}>
                <PercentRow
                  label="粒子文字大小"
                  value={particleSize}
                  min={2}
                  max={30}
                  tip="文字高度占画面高度的百分比，默认 10%。转场结束后显示的就是这个字号的完整实心字；所有句子同一字号、宽度随内容自适应；1% 一档，按住 Alt 临时取消吸附。"
                  onPreview={(v) => preview("particleSize", v)}
                  onCommit={() => commit("粒子文字大小")}
                  onStep={(v) => { preview("particleSize", v); commit("粒子文字大小"); }}
                />
              </div>
              <div style={{ marginBottom: 14 }} data-tip="汇聚（入场）时长：字幕出现时，文字从左侧开始逐段凝结成完整实心字，粒子从屏幕左侧飞向文字、到位即消失。设为 0 表示不使用汇聚，字幕直接在原位显示。与打字机等入场动画互斥，不会同时执行。">
                <RangeRow
                  label="汇聚时长"
                  value={particleGatherMs}
                  suffix=" ms"
                  min={0}
                  max={3000}
                  step={50}
                  onPreview={(v) => preview("particleGatherMs", v)}
                  onCommit={() => commit("汇聚时长")}
                />
              </div>
              <div style={{ marginBottom: 14 }} data-tip="飘散（出场）时长：字幕结束时，文字从右侧开始逐渐随机融化，融化处的笔画化成沙尘粒子朝右上方飘散消失。设为 0 表示不使用飘散，字幕到点直接消失。">
                <RangeRow
                  label="飘散时长"
                  value={particleScatterMs}
                  suffix=" ms"
                  min={0}
                  max={3000}
                  step={50}
                  onPreview={(v) => preview("particleScatterMs", v)}
                  onCommit={() => commit("飘散时长")}
                />
              </div>
              <div style={{ marginBottom: 14 }} data-tip="粒子密度：1 档最省（约数百粒），5 档最多（逐像素采样，沙尘级密度）。档位越高转场时沙尘越细密，但对性能要求也越高。">
                <RangeRow
                  label="粒子密度"
                  value={particleDensity}
                  suffix=" 档"
                  min={1}
                  max={5}
                  step={1}
                  onPreview={(v) => preview("particleDensity", v)}
                  onCommit={() => commit("粒子密度")}
                />
              </div>
              <PercentRow
                label="扩散范围"
                value={particleSpread}
                min={20}
                max={300}
                tip="粒子汇聚的起点距离与飘散的飞行距离倍率，默认 100%。越大飘得越远、汇聚来处越远；1% 一档，按住 Alt 临时取消吸附。"
                onPreview={(v) => preview("particleSpread", v)}
                onCommit={() => commit("扩散范围")}
                onStep={(v) => { preview("particleSpread", v); commit("扩散范围"); }}
              />
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>字幕位置</div>
              <div style={{ marginBottom: 14 }}>
                {style === "fit" ? (
                  <PercentRow
                    label="屏幕适配比例"
                    value={fitRatio}
                    min={20}
                    max={100}
                    tip="字幕占屏幕宽度的百分比，决定「屏幕适配」风格下字幕整体大小；1% 一档，10 的倍数附近会轻微吸附（按住 Alt 临时不吸附），方便选中整数档。"
                    onPreview={(v) => preview("fitRatio", v)}
                    onCommit={() => commit("屏幕适配比例")}
                    onStep={(v) => { preview("fitRatio", v); commit("屏幕适配比例"); }}
                  />
                ) : (
                  <PercentRow
                    label="字幕水平位置"
                    value={posX}
                    min={0}
                    max={100}
                    tip="字幕在屏幕左右的位置：0% 贴最左，100% 贴最右，默认 30%。「自定义字号 / 等宽字幕」风格下可自由水平挪动；1% 一档，10 的倍数附近会轻微吸附（按住 Alt 临时不吸附）。"
                    onPreview={(v) => preview("subtitleX", v)}
                    onCommit={() => commit("字幕水平位置")}
                    onStep={(v) => { preview("subtitleX", v); commit("字幕水平位置"); }}
                  />
                )}
              </div>
              <PercentRow
                label="字幕垂直位置"
                value={posY}
                min={0}
                max={100}
                tip="字幕在屏幕上下的位置，以垂直居中线为基准，50% 为正中；1% 一档，10 的倍数附近会轻微吸附（按住 Alt 临时不吸附）。"
                onPreview={(v) => preview("subtitleY", v)}
                onCommit={() => commit("字幕垂直位置")}
                onStep={(v) => { preview("subtitleY", v); commit("字幕垂直位置"); }}
              />
            </>
          )}
        </div>

        <div>
          <label className="jeek-field">全局字体</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              className="jeek-select" style={{ width: 200 }}
              value={fontFamily}
              onChange={(e) => setSetting("fontFamily", e.target.value)}
            >
              {fontOptions.map((f) => <option key={f.family} value={f.family}>{fontCnName(f.family, f.fileName)}</option>)}
            </select>
            <button
              className="jeek-btn-secondary"
              style={{ height: 32 }}
              data-act="font.catalog"
              data-tip="打开字体管理：查看内置字体与 fonts 目录里识别到的字体，可设为全局默认或删除。"
              onClick={() => onCommand("font.catalog")}
            >
              管理
            </button>
          </div>
        </div>

        <div className="jeek-anim-row">
          <div className="jeek-anim-col">
            <label className="jeek-field">全局动画</label>
            <select
              className="jeek-select"
              value={enter}
              data-tip="全局入场动画：修改后一次性把所有字幕（含之后新增的）都设成这一种。字幕列表里仍可单条修改某一条，单条修改优先生效；再改一次全局，又会把所有条目统一回来。"
              onChange={(e) => {
                const state = useEditor.getState();
                state.commit("全局动画", applyGlobalEnter(state.doc, e.target.value));
              }}
            >
              {ENTER_ANIMATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="jeek-anim-col">
            <label className="jeek-field">随机移动</label>
            <select
              className="jeek-select"
              value={style === "duo" ? "off" : rotationMode}
              disabled={style === "duo"}
              data-tip={style === "duo" ? "双层文字风格不使用随机移动，两层始终居中；可使用全局动画入场。" : undefined}
              onChange={(e) => setSetting("rotationMode", e.target.value)}
            >
              {ROTATION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>

        <div data-tip="入场动画时长：控制每条字幕从入场到完全稳定的过渡时间，位移、缩放、旋转、模糊等效果都在这段时间里展开。数值越大，动效越明显、越舒缓；打字机逐字露出的时间也会同步拉长。拖动时画面实时预览，松手才记入撤销栈。范围 200～1500 毫秒。">
          <RangeRow
            label="入场时长"
            value={enterDurationMs}
            suffix=" ms"
            min={200}
            max={1500}
            step={50}
            onPreview={(v) => preview("enterDurationMs", v)}
            onCommit={() => commit("入场时长")}
          />
        </div>

        <div>
          <label className="jeek-field">
            旋转间隔：{rotationInterval > 0 ? `${rotationInterval} 条` : "随机（3~5）"}
          </label>
          <input
            type="range" min={0} max={12} value={rotationInterval}
            style={{ width: "100%" }}
            data-snap="1"
            onChange={(e) => preview("rotationInterval", snappedRangeValue(e))}
            onPointerUp={() => commit("旋转间隔")}
            onKeyUp={() => commit("旋转间隔")}
          />
        </div>

        <div className="jeek-space-y2">
          <label className="jeek-field">调色板</label>
          <div className="jeek-swatches">
            {palette.map((c, i) => (
              <span className="jeek-swatch" key={`${c}-${i}`}>
                <input
                  type="color"
                  value={c}
                  onChange={(e) => {
                    const next = [...palette];
                    next[i] = e.target.value;
                    setSetting("palette", next);
                  }}
                />
                <button
                  className="jeek-swatch-del"
                  title="移除这个颜色"
                  onClick={() => setSetting("palette", palette.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              className="jeek-swatch-add"
              title="添加颜色"
              onClick={() => setSetting("palette", [...palette, "#ffffff"])}
            >
              +
            </button>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button
            className={`jeek-btn-ghost ${confirmReset ? "is-confirm" : ""}`}
            style={{ height: 32, fontSize: 13, padding: "0 14px" }}
            data-act="palette.reset"
            data-tip={confirmReset
              ? "再点一次就把调色板恢复成出厂的那几个颜色，新增与改过的颜色都会被清掉。"
              : "恢复默认：把调色板还原成出厂颜色。点一下会先变成「确认恢复」，再点一次才生效。"}
            onClick={resetPalette}
          >
            {confirmReset ? "确认恢复" : "恢复默认"}
          </button>
          <button
            className="jeek-btn-primary"
            style={{ height: 32, fontSize: 13, padding: "0 14px" }}
            data-act="palette.random"
            data-tip="随机分配：从当前调色板里给每条字幕随机取一个颜色，重复点可以一直换，直到配色满意。"
            onClick={assignRandomColors}
          >
            随机分配
          </button>
        </div>
      </div>

      {/* ---------------- 文字描边 ---------------- */}
      <div className="jeek-card jeek-space-y4">
        <i className="jeek-card-bar" />

        <div className="jeek-stroke-title">
          <span>文字描边</span>
          <button
            type="button"
            className={`jeek-switch-track ${strokeEnabled ? "is-on" : ""}`}
            role="switch"
            aria-checked={strokeEnabled}
            aria-label="启用文字描边"
            data-act="stroke.enabled"
            data-tip="文字描边总开关：打开后，字幕轨里所有文字都会按下面的颜色、样式和粗细描边；关闭时画面保持不加边的原始样子。"
            onClick={() => setSetting("strokeEnabled", !strokeEnabled)}
          />
        </div>

        {strokeEnabled && (
          <>
            <div data-tip="描边样式：单层外描边是在字形外面加一圈；双层描边先描一圈宽的外色、再描一圈窄的内色，适合花字；内描边把颜色压在字形边缘上，字身仍是主体，看起来更紧凑。">
              <label className="jeek-field">描边样式</label>
              <select
                className="jeek-select"
                value={strokeStyle}
                data-act="stroke.style"
                onChange={(e) => setSetting("strokeStyle", e.target.value)}
              >
                {STROKE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            <div data-tip="描边颜色：外层描边用这个颜色。点取色盘随意调，也可以在色值框里直接粘一个 #RRGGBB，或点右侧预设色块一键套用。">
              <label className="jeek-field">描边颜色</label>
              <div className="jeek-color-row">
                <input
                  type="color"
                  value={strokeColor.toLowerCase()}
                  data-act="stroke.color"
                  onChange={(e) => setSetting("strokeColor", e.target.value.toLowerCase())}
                />
                <input
                  className="jeek-hex-input"
                  type="text"
                  value={strokeColor}
                  maxLength={7}
                  data-act="stroke.colorHex"
                  onChange={(e) => setSetting("strokeColor", e.target.value)}
                />
                <div className="jeek-preset-row">
                  {STROKE_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      className={`jeek-preset ${strokeColor.toLowerCase() === p.hex ? "is-on" : ""}`}
                      style={{ background: p.hex }}
                      aria-label={p.label}
                      title={p.label}
                      data-act="stroke.preset"
                      data-value={p.hex}
                      onClick={() => setSetting("strokeColor", p.hex)}
                    />
                  ))}
                </div>
              </div>
            </div>

            {strokeStyle === "double" && (
              <div data-tip="内圈颜色：双层描边时贴着字形的那一圈细边用这个颜色。与外圈拉开明暗，层次最明显。">
                <label className="jeek-field">内圈颜色</label>
                <div className="jeek-color-row">
                  <input
                    type="color"
                    value={strokeColor2.toLowerCase()}
                    data-act="stroke.color2"
                    onChange={(e) => setSetting("strokeColor2", e.target.value.toLowerCase())}
                  />
                  <input
                    className="jeek-hex-input"
                    type="text"
                    value={strokeColor2}
                    maxLength={7}
                    data-act="stroke.color2Hex"
                    onChange={(e) => setSetting("strokeColor2", e.target.value)}
                  />
                  <div className="jeek-preset-row">
                    {STROKE_PRESETS.map((p) => (
                      <button
                        key={p.hex}
                        className={`jeek-preset ${strokeColor2.toLowerCase() === p.hex ? "is-on" : ""}`}
                        style={{ background: p.hex }}
                        aria-label={p.label}
                        title={p.label}
                        data-act="stroke.preset2"
                        data-value={p.hex}
                        onClick={() => setSetting("strokeColor2", p.hex)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div data-act="stroke.widthRow" data-tip="描边粗细：按画布逻辑像素算，0 等于没有描边，16 最粗，默认 5 px。拖动时画面实时变化，松手才记入撤销栈；每 10 档有轻微吸附，按住 Alt 临时不吸附。">
              <RangeRow
                label="描边粗细"
                value={strokeWidth}
                suffix=" px"
                min={0}
                max={16}
                step={1}
                onPreview={(v) => preview("strokeWidth", v)}
                onCommit={() => commit("描边粗细")}
              />
            </div>
          </>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pickImage(file);
          e.target.value = ""; // 允许连续选同一张图，也能随时换图
        }}
      />
    </>
  );
}

/** 供外部读取默认调色板 */
export const paletteOf = (doc: ProjectDocument): string[] => {
  const v = (doc.settings as Record<string, unknown>).palette;
  return Array.isArray(v) ? (v as string[]) : DEFAULT_PALETTE;
};
