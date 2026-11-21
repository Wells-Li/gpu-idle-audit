// test.js — node --test，无框架，零依赖。断言口径见 SPEC.md「合成数据与测试」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { generate } from './synth.js';
import { runPipeline } from './src/cli.js';
import { parseUtilText, parseMetricsText, joinMetrics, inferInterval } from './src/parse.js';
import { VERBATIM } from './src/report.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');

function near(actual, expected, label, tol = 0.05) {
  const denom = Math.max(Math.abs(expected), 1e-9);
  const dev = Math.abs(actual - expected) / denom;
  assert.ok(dev <= tol, `${label}: actual=${actual} truth=${expected} 偏差 ${(dev * 100).toFixed(3)}% > ${tol * 100}%`);
}

function buildDataset(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'gia-'));
  const s = generate({ seed, outDir: dir });
  const lease = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'lease.demo.json'), 'utf8'));
  const dmonText = readFileSync(s.dmonFile, 'utf8');
  const metricsText = readFileSync(s.metricsFile, 'utf8');
  const out = runPipeline({
    utilTexts: [{ name: s.dmonFile, text: dmonText }],
    metricsTexts: [{ name: s.metricsFile, text: metricsText }],
    leaseEntries: lease,
    priceKv: {},
    opts: { utilThreshold: 30, idleMinutes: 15, minReplicas: 2, memTotal: 81920, metricsStaleness: 1800, gpuId: null, metricsGpu: null },
  });
  const manifest = JSON.parse(readFileSync(s.manifestFile, 'utf8'));
  return { dir, synth: s, manifest, pipeline: out, dmonText, metricsText, lease };
}

const A = buildDataset(42);
const F = (id) => A.pipeline.result.findings.find((x) => x.id === id);

test('合成数据规模：≥50,000 行、8 卡、7×24h', () => {
  assert.ok(A.manifest.dmon_data_lines >= 50000, `数据行 ${A.manifest.dmon_data_lines} < 50000`);
  assert.equal(A.manifest.gpus, 8);
  assert.equal(A.manifest.window.hours, 168);
  assert.equal(A.pipeline.records.length, 8 * 6721);
});

test('采样间隔从时间戳推断（=90s，不假设 1 秒）', () => {
  assert.equal(A.pipeline.result.nominalInterval, 90);
});

test('性能：50,000+ 行解析 + 四检测 < 2000ms', () => {
  const t0 = process.hrtime.bigint();
  const r = parseUtilText(A.dmonText, {});
  const m = parseMetricsText(A.metricsText, {});
  for (const rec of r.records) if (rec.mem_total_mib == null) rec.mem_total_mib = 81920;
  joinMetrics(r.records, m.eventsByGpu, { staleness: 1800 });
  const lease = A.lease;
  runPipeline({
    utilTexts: [{ name: 'perf', text: A.dmonText }],
    metricsTexts: [{ name: 'perf-m', text: A.metricsText }],
    leaseEntries: lease, priceKv: {},
    opts: { utilThreshold: 30, idleMinutes: 15, minReplicas: 2, memTotal: 81920, metricsStaleness: 1800 },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `解析+四检测耗时 ${ms.toFixed(0)}ms ≥ 2000ms`);
  console.log(`      perf: 全管线（含二次解析+渲染）${ms.toFixed(0)}ms，记录 ${r.records.length}`);
});

test('parse_errors ≥ 1（fixture 含一行畸形）', () => {
  const fx = parseUtilText(readFileSync(join(ROOT, 'fixtures', 'malformed.dmon'), 'utf8'), {});
  assert.ok(fx.parseErrors >= 1, 'fixture 畸形行未计入 parse_errors');
  assert.equal(fx.records.length, 3, '畸形行应跳过，好行保留');
  assert.ok(A.pipeline.meta.parseErrors >= 1, 'synth dmon 畸形行未计入');
});

test('G1 小时数与金额落在 manifest 真值 ±5%', () => {
  const t = A.manifest.truth.g1;
  near(F('G1').hours, t.hours, 'G1 hours');
  near(F('G1').waste_cny_upper, t.amount_cny, 'G1 waste');
  assert.equal(A.pipeline.result.perGpu.filter((g) => g.g1_runs > 0).reduce((a, g) => a + g.g1_runs, 0), t.runs, 'G1 段数');
  near(Math.max(...A.pipeline.result.perGpu.map((g) => g.g1_longest_hours)), t.longest_hours, 'G1 最长段');
});

test('G2 小时数与金额落在 manifest 真值 ±5%（--min-replicas=2）', () => {
  const t = A.manifest.truth.g2;
  near(F('G2').hours, t.hours, 'G2 hours');
  near(F('G2').waste_cny_upper, t.amount_cny, 'G2 waste');
});

test('G2 缺 --min-replicas 时只报现象不报金额', () => {
  const out = runPipeline({
    utilTexts: [{ name: A.synth.dmonFile, text: A.dmonText }],
    metricsTexts: [{ name: A.synth.metricsFile, text: A.metricsText }],
    leaseEntries: A.lease, priceKv: {},
    opts: { utilThreshold: 30, idleMinutes: 15, minReplicas: null, memTotal: 81920, metricsStaleness: 1800 },
  });
  const g2 = out.result.findings.find((x) => x.id === 'G2');
  assert.ok(g2.hours > 0, '应检出低谷现象');
  assert.equal(g2.waste_cny_upper, null, '缺 min-replicas 不应报金额');
  assert.match(out.report, /只报现象不报金额/);
});

test('G3 金额为 0 且报告文本含「不适用」', () => {
  const t = A.manifest.truth.g3;
  assert.equal(F('G3').waste_cny_upper, 0, 'G3 不得计金额');
  assert.equal(t.amount_cny, 0);
  assert.ok(A.pipeline.report.includes('不适用'), '报告缺「不适用」');
  assert.ok(A.pipeline.report.includes(VERBATIM.VERBATIM_G3), '报告缺 G3 金额栏逐字文案');
  const gpu5 = A.pipeline.result.perGpu.find((g) => g.gpu_key === t.gpu);
  near(gpu5.g3_fraction, t.fraction, 'G3 fraction', 0.05);
  // G3 不计入任何档位小计
  const sum = A.pipeline.result.tiers.immediate.amount_upper + A.pipeline.result.tiers.reform.amount_upper;
  near(sum, A.manifest.truth.g1.amount_cny + A.manifest.truth.g2.amount_cny + A.manifest.truth.g4.amount_cny, '档位小计不含 G3 金额');
});

test('G4 小时数与金额落在 manifest 真值 ±5%', () => {
  const t = A.manifest.truth.g4;
  near(F('G4').hours, t.hours, 'G4 hours');
  near(F('G4').waste_cny_upper, t.amount_cny, 'G4 waste');
  assert.equal(F('G4').tier, '需改造');
});

test('未定价卡出现在 unpriced_gpus 且不计入总额', () => {
  const res = A.pipeline.result;
  for (const k of A.manifest.truth.unpriced_gpus) {
    assert.ok(res.unpricedGpus.includes(k), `GPU ${k} 应在 unpriced_gpus`);
    const row = res.perGpu.find((g) => g.gpu_key === k);
    assert.equal(row.priced, false);
    assert.equal(row.waste_upper_window_cny, null, '未定价卡不应有金额');
    assert.equal(row.g1_amount_upper, null);
    assert.ok(row.g1_hours > 0, '未定价卡的小时数照常报告');
  }
  // 总额 == 仅已定价卡之和
  const pricedSum = res.perGpu.filter((g) => g.priced).reduce((a, g) => a + g.waste_upper_window_cny, 0);
  near(res.totals.total_waste_upper_window, pricedSum, '总额只含已定价卡', 1e-9);
  const csvRow = A.pipeline.csv.split('\n').find((l) => l.startsWith('5,'));
  assert.match(csvRow, /^5,,no,,/, 'findings.csv 未定价卡价格列为空');
  assert.match(A.pipeline.report, /unpriced_gpus/);
});

test('同一 seed 两次运行 sha256(out/findings.csv) 相同', () => {
  const B = buildDataset(42);
  const h = (s) => createHash('sha256').update(s).digest('hex');
  const fa = join(A.dir, 'findings.csv'), fb = join(B.dir, 'findings.csv');
  writeFileSync(fa, A.pipeline.csv);
  writeFileSync(fb, B.pipeline.csv);
  assert.equal(h(readFileSync(fa)), h(readFileSync(fb)), 'sha256(findings.csv) 不一致');
  assert.equal(h(A.pipeline.report), h(B.pipeline.report), 'report.md 也应确定');
});

test('报告口径声明逐字包含 nvidia-smi util 语义自我攻击句', () => {
  assert.ok(A.pipeline.report.includes(VERBATIM.VERBATIM_UTIL), '口径声明缺逐字 util 语义句');
  assert.match(A.pipeline.report, /采样间隔：90 秒/);
  assert.match(A.pipeline.report, /窗口起止：2024-01-01T00:00:00Z ~ 2024-01-08T00:00:00Z/);
  assert.match(A.pipeline.report, /util 阈值：30%/);
});

test('金额一律上界措辞，禁止百分比式降本结论', () => {
  assert.ok(A.pipeline.report.includes(VERBATIM.VERBATIM_UPPER), '缺上界逐字文案');
  assert.doesNotMatch(A.pipeline.report, /预计降本\s*\d+(\.\d+)?\s*%/, '出现百分比式降本结论');
  assert.doesNotMatch(A.pipeline.report, /降本\s*\d+(\.\d+)?\s*%/);
  assert.doesNotMatch(A.pipeline.csv, /预计降本/);
});

test('未覆盖清单出现在报告', () => {
  assert.ok(A.pipeline.report.includes(VERBATIM.UNCOVERED));
});

test('格式嗅探：nvidia-smi CSV / DCGM prom / vLLM metrics join', () => {
  const csv = parseUtilText(readFileSync(join(ROOT, 'fixtures', 'mini_nvidia.csv'), 'utf8'), {});
  assert.equal(csv.format, 'csv');
  assert.equal(csv.records.length, 3);
  assert.deepEqual(csv.records[0].util_pct, 35);
  assert.deepEqual(csv.records[0].mem_total_mib, 81920);
  assert.equal(inferInterval(csv.records.map((r) => r.ts)), 10, 'CSV 间隔应推断为 10s');

  const dcgm = parseUtilText(readFileSync(join(ROOT, 'fixtures', 'mini_dcgm.prom'), 'utf8'), {});
  assert.equal(dcgm.format, 'prom');
  assert.equal(dcgm.records.length, 2);
  const r0 = dcgm.records.find((r) => r.ts === 1704067200);
  assert.equal(r0.util_pct, 42);
  assert.equal(r0.mem_used_mib, 60000);
  assert.equal(r0.mem_total_mib, 81920, 'FB_USED+FB_FREE 应合成 total');
  assert.equal(r0.model, 'A100-SXM4-80GB');

  const vllm = parseMetricsText(readFileSync(join(ROOT, 'fixtures', 'mini_vllm.prom'), 'utf8'), {});
  const joined = joinMetrics(dcgm.records, vllm.eventsByGpu, { staleness: 60 });
  assert.ok(joined >= 2);
  assert.equal(r0.running_req, 2);
  assert.equal(r0.waiting_req, 0);
  assert.equal(r0.kv_cache_usage, 0.3);
  const r1 = dcgm.records.find((r) => r.ts === 1704067210);
  assert.equal(r1.running_req, 4);
  assert.equal(r1.kv_cache_usage, 0.62);
});

test('--help 可用且有内容', () => {
  const out = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.ok(out.length > 200);
  assert.match(out, /用法/);
  assert.match(out, /--util-threshold/);
});

test('demo e2e：node src/cli.js demo 写出三件套 + manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gia-demo-'));
  const stdout = execFileSync(process.execPath, [CLI, 'demo', '--out', dir, '--seed', '7'], { encoding: 'utf8' });
  assert.match(stdout, /立即可回收/);
  for (const f of ['report.md', 'findings.csv', 'assumptions.md', 'manifest.json', 'dmon_synth.txt']) {
    assert.ok(existsSync(join(dir, f)), `缺输出 ${f}`);
  }
  const rep = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.ok(rep.includes(VERBATIM.VERBATIM_UTIL));
});
