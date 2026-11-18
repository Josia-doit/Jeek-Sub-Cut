import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_QUALITY,
  cpuEncoderOf,
  defaultConcurrency,
  gpuEncoderOf,
  gpuUnsupportedMessage,
  logicalSize,
  normalizeExportConfig,
  outputSize,
} from "@jeek/core";

test("质量档换算：快速 / 标准 / 精细对应预设与 CQ", () => {
  assert.deepEqual(
    [EXPORT_QUALITY.fast.crf, EXPORT_QUALITY.fast.cq, EXPORT_QUALITY.fast.cpuPreset, EXPORT_QUALITY.fast.gpuPreset],
    [24, 25, "veryfast", "p3"],
  );
  assert.deepEqual(
    [EXPORT_QUALITY.balanced.crf, EXPORT_QUALITY.balanced.cq, EXPORT_QUALITY.balanced.cpuPreset, EXPORT_QUALITY.balanced.gpuPreset],
    [20, 21, "medium", "p5"],
  );
  assert.deepEqual(
    [EXPORT_QUALITY.high.crf, EXPORT_QUALITY.high.cq, EXPORT_QUALITY.high.cpuPreset, EXPORT_QUALITY.high.gpuPreset],
    [16, 17, "slow", "p7"],
  );
});

test("没给 CRF 时跟随档位，给了就按用户值换算 CQ = CRF + 1", () => {
  const auto = normalizeExportConfig({ quality: "high" });
  assert.equal(auto.crf, 16);
  assert.equal(auto.cq, 17);

  const manual = normalizeExportConfig({ quality: "fast", crf: 18 });
  assert.equal(manual.crf, 18);
  assert.equal(manual.cq, 19);
  // 档位预设不再覆盖用户 CRF
  assert.equal(manual.cpuPreset, "veryfast");
});

test("CRF 与并行帧数都夹在合法区间", () => {
  assert.equal(normalizeExportConfig({ crf: 0 }).crf, 1);
  assert.equal(normalizeExportConfig({ crf: 999 }).crf, 51);
  assert.equal(normalizeExportConfig({ concurrency: 0 }).concurrency, 0);
  assert.equal(normalizeExportConfig({ concurrency: 2.4 }).concurrency, 2);
  assert.equal(normalizeExportConfig({ concurrency: 40 }).concurrency, 32);
});

test("自动并行帧数不超过 4，也不超过机器的一半", () => {
  assert.equal(defaultConcurrency(16, 64), 4);
  assert.equal(defaultConcurrency(4, 64), 2);
  assert.equal(defaultConcurrency(16, 16), 2);
  assert.equal(defaultConcurrency(1, 4), 1);
});

test("输出尺寸：短边固定、长边按比例推、两边取偶数", () => {
  assert.deepEqual(outputSize(1080, 16 / 9), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(1080, 9 / 16), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(1080, 1), { width: 1080, height: 1080 });
  assert.deepEqual(outputSize(1440, 4 / 3), { width: 1920, height: 1440 });
  assert.deepEqual(outputSize(2160, 21 / 9), { width: 5040, height: 2160 });
  // 4:5 竖屏：高 = 1080 / 0.8 = 1350
  assert.deepEqual(outputSize(1080, 4 / 5), { width: 1080, height: 1350 });
});

test("逻辑画布短边恒 1440，与导出口径分开", () => {
  assert.deepEqual(logicalSize(16 / 9), { width: 2560, height: 1440 });
  assert.deepEqual(logicalSize(9 / 16), { width: 1440, height: 2560 });
  assert.equal(normalizeExportConfig({ resolution: "1080P" }).shortEdge, 1080);
  assert.equal(normalizeExportConfig({ resolution: "2160P" }).shortEdge, 2160);
});

test("分辨率与比例组合出真实成片尺寸，不是恒 1920×1080", () => {
  const portrait4k = normalizeExportConfig({ resolution: "2160P", aspect: "portrait" });
  assert.deepEqual([portrait4k.width, portrait4k.height], [2160, 3840]);

  const square2k = normalizeExportConfig({ resolution: "1440P", aspect: "square" });
  assert.deepEqual([square2k.width, square2k.height], [1440, 1440]);
});

test("编码器名与不支持提示跟着编码格式走", () => {
  assert.equal(gpuEncoderOf("h264"), "h264_nvenc");
  assert.equal(gpuEncoderOf("h265"), "hevc_nvenc");
  assert.equal(cpuEncoderOf("h264"), "libx264");
  assert.equal(cpuEncoderOf("h265"), "libx265");
  assert.match(gpuUnsupportedMessage("h265"), /hevc_nvenc/);
  assert.match(gpuUnsupportedMessage("h264"), /「自动」或「CPU 编码」/);
});

test("非法输入落到安全默认值", () => {
  const cfg = normalizeExportConfig({ codec: "av1", quality: "ultra", accel: "npu", resolution: "8K", aspect: "?" });
  assert.equal(cfg.codec, "h264");
  assert.equal(cfg.quality, "balanced");
  assert.equal(cfg.accel, "auto");
  assert.deepEqual([cfg.width, cfg.height], [1920, 1080]);
  assert.equal(cfg.container, "mp4");
});
