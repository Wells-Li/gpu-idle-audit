// 复核工具：重跑管线，打印 G1..G4 实测值相对 out/manifest.json 真值的偏差百分比。
// 用法: node scripts/deviation.mjs [outDir] [seed 用的 --min-replicas 默认 2]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/cli.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? join(ROOT, 'out');
const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
const lease = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'lease.demo.json'), 'utf8'));
const out = runPipeline({
  utilTexts: [{ name: 'dmon_synth.txt', text: readFileSync(join(outDir, 'dmon_synth.txt'), 'utf8') }],
  metricsTexts: [{ name: 'vllm_synth.txt', text: readFileSync(join(outDir, 'vllm_synth.txt'), 'utf8') }],
  leaseEntries: lease, priceKv: {},
  opts: { utilThreshold: 30, idleMinutes: 15, minReplicas: m.truth.g2.min_replicas, memTotal: m.mem_total_mib, metricsStaleness: 1800 },
});
const F = (id) => out.result.findings.find((x) => x.id === id);
const dev = (a, e) => (e === 0 ? (Math.abs(a) < 1e-12 ? '0.000' : 'inf') : ((Math.abs(a - e) / Math.abs(e)) * 100).toFixed(3));
const rows = [];
for (const [id, t] of [['G1', m.truth.g1], ['G2', m.truth.g2], ['G4', m.truth.g4]]) {
  const f = F(id);
  rows.push([id, 'hours', f.hours.toFixed(4), t.hours.toFixed(4), dev(f.hours, t.hours) + '%']);
  rows.push([id, 'amount_cny', f.waste_cny_upper.toFixed(2), t.amount_cny.toFixed(2), dev(f.waste_cny_upper, t.amount_cny) + '%']);
}
const g3 = F('G3');
const g3row = out.result.perGpu.find((g) => g.gpu_key === m.truth.g3.gpu);
rows.push(['G3', 'amount_cny', String(g3.waste_cny_upper), String(m.truth.g3.amount_cny), dev(g3.waste_cny_upper, m.truth.g3.amount_cny) + '%（恒为 0，不计金额）']);
rows.push(['G3', 'hours', g3.hours.toFixed(4), m.truth.g3.hours.toFixed(4), dev(g3.hours, m.truth.g3.hours) + '%']);
rows.push(['G3', 'fraction', g3row.g3_fraction.toFixed(6), m.truth.g3.fraction.toFixed(6), dev(g3row.g3_fraction, m.truth.g3.fraction) + '%']);
const g1r = out.result.perGpu.filter((g) => g.g1_runs > 0).reduce((a, g) => a + g.g1_runs, 0);
rows.push(['G1', 'runs', String(g1r), String(m.truth.g1.runs), dev(g1r, m.truth.g1.runs) + '%']);
const longest = Math.max(...out.result.perGpu.map((g) => g.g1_longest_hours));
rows.push(['G1', 'longest_hours', longest.toFixed(4), m.truth.g1.longest_hours.toFixed(4), dev(longest, m.truth.g1.longest_hours) + '%']);
console.log('检测器 | 指标 | 实测 | manifest 真值 | 偏差');
console.log('---|---|---|---|---');
for (const r of rows) console.log(r.join(' | '));
