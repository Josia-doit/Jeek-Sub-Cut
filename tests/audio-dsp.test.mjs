import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGain,
  applyNoiseReduction,
  clampGainDb,
  dbToGain,
  formatGainDb,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GAIN_DB_SILENT,
  readAudioProcessing,
  segmentNormalizeGain,
} from "@jeek/core";

const rms = (arr) => {
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, arr.length));
};

test("增益档位：静音哨兵、左右各 30 档与非数值兜底", () => {
  assert.equal(GAIN_DB_MIN, -30);
  assert.equal(GAIN_DB_MAX, 30);
  assert.equal(GAIN_DB_SILENT, -31);
  assert.equal(clampGainDb(GAIN_DB_SILENT), GAIN_DB_SILENT);
  assert.equal(clampGainDb(-999), GAIN_DB_SILENT);
  assert.equal(clampGainDb(-31), GAIN_DB_SILENT);
  assert.equal(clampGainDb(-30), -30);
  assert.equal(clampGainDb(0), 0);
  assert.equal(clampGainDb(30), GAIN_DB_MAX);
  assert.equal(clampGainDb(99), GAIN_DB_MAX);
  assert.equal(clampGainDb(3.6), 4);
  assert.equal(clampGainDb("abc"), 0);
  assert.equal(clampGainDb(undefined), 0);
});

test("面板读数：-∞ 静音、正负分贝与 0 dB", () => {
  assert.equal(formatGainDb(GAIN_DB_SILENT), "-∞");
  assert.equal(formatGainDb(-30), "-30 dB");
  assert.equal(formatGainDb(-12), "-12 dB");
  assert.equal(formatGainDb(0), "0 dB");
  assert.equal(formatGainDb(6), "+6 dB");
  assert.equal(formatGainDb(30), "+30 dB");
});

test("分贝转线性增益：0 dB 不动、-∞ 静音、±6 dB 约两倍/一半", () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(dbToGain(GAIN_DB_SILENT), 0);
  assert.ok(Math.abs(dbToGain(6) - 1.9953) < 0.001);
  assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 0.001);
  assert.ok(Math.abs(dbToGain(-30) - 0.0316228) < 1e-6);
});

test("工程设置读取：缺字段时全部不处理，勾选与档位原样带出", () => {
  assert.deepEqual(readAudioProcessing({}), {
    noiseReduction: false, uniformVolume: false, gainDb: 0,
  });
  assert.deepEqual(readAudioProcessing({
    audioNoiseReduction: true, audioUniformVolume: true, audioGainDb: 9,
  }), { noiseReduction: true, uniformVolume: true, gainDb: 9 });
  assert.equal(readAudioProcessing({ audioGainDb: 500 }).gainDb, GAIN_DB_MAX);
});

test("统一音量：静音段不放大、轻声放大、大声压低、增益夹在 ±12 dB", () => {
  const silent = new Float32Array(1000);
  assert.equal(segmentNormalizeGain(silent, 0, 1000), 1);
  const quiet = new Float32Array(1000).fill(0.01);
  assert.ok(segmentNormalizeGain(quiet, 0, 1000) > 1);
  const loud = new Float32Array(1000).fill(0.5);
  assert.ok(segmentNormalizeGain(loud, 0, 1000) < 1);
  assert.ok(segmentNormalizeGain(new Float32Array(1000).fill(1), 0, 1000) >= 0.25);
  assert.ok(segmentNormalizeGain(new Float32Array(1000).fill(1e-6), 0, 1000) <= 4);
  assert.equal(segmentNormalizeGain(quiet, 0, 0), 1);
  // 只按片段区间取响度，不把片段外的样本算进来
  const mixed = new Float32Array(2000).fill(0.01);
  mixed.fill(0.9, 1000);
  assert.ok(segmentNormalizeGain(mixed, 0, 1000) > 1);
});

test("基础降噪：低频隆隆被滤掉、静音段底噪被压低、有效信号保留", () => {
  const rate = 48000;
  const n = rate / 2;
  const low = new Float32Array(n);
  const voice = new Float32Array(n);
  const hiss = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    low[i] = 0.3 * Math.sin(2 * Math.PI * 20 * t);
    voice[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t);
    hiss[i] = 0.001 * Math.sin(2 * Math.PI * 7000 * t);
  }
  const lowBefore = rms(low);
  const voiceBefore = rms(voice);
  const hissBefore = rms(hiss);
  applyNoiseReduction(low, rate);
  applyNoiseReduction(voice, rate);
  applyNoiseReduction(hiss, rate);
  assert.ok(rms(low) < lowBefore * 0.35, `20Hz 应被明显衰减：${lowBefore} → ${rms(low)}`);
  assert.ok(rms(voice) > voiceBefore * 0.9, `440Hz 应基本保留：${voiceBefore} → ${rms(voice)}`);
  assert.ok(rms(hiss) < hissBefore * 0.35, `底噪应被噪声门压低：${hissBefore} → ${rms(hiss)}`);
});

test("整轨增益：逐样本施加、0 静音、削波夹在 ±1", () => {
  const a = new Float32Array([0.5, -0.8, 0.2]);
  applyGain(a, 0);
  assert.deepEqual([...a], [0, 0, 0]);
  const b = new Float32Array([0.5, -0.8, 0.2]);
  applyGain(b, 2);
  assert.equal(b[0], 1);
  assert.equal(b[1], -1);
  assert.ok(Math.abs(b[2] - 0.4) < 1e-6);
  const c = new Float32Array([0.5, -0.8, 0.2]);
  applyGain(c, 1);
  assert.equal(c[0], 0.5);
  assert.equal(c[2], 0.20000000298023224);
});
