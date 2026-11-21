#!/usr/bin/env node
// gpu-idle-audit CLI。零依赖（node: 内置 only），不联网，不读环境变量密钥。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUtilText, parseMetricsText, joinMetrics } from './parse.js';
import { analyze, resolvePrices } from './detect.js';
import { renderReport, renderFindingsCsv, renderAssumptions } from './report.js';

const HELP = `gpu-idle-audit v1 — 你每月为没干活的 GPU 付了多少钱（金额一律为上界）

用法:
  node src/cli.js [analyze] --util <file>... [选项]   分析导出数据，写 out/report.md 等
  node src/cli.js demo [--seed 42] [--out out]        跑合成数据出报告（synth.js）
  node src/cli.js --help                              显示本帮助

输入（--util 可多次；格式自动嗅探）:
  --util <file>          nvidia-smi dmon -s um -o DT 文本 / nvidia-smi --query-gpu CSV 循环导出 /
                         DCGM Prometheus text dump / 自有 CSV（表头含 timestamp|time|dt + 利用率列 + 卡标识列）
  --metrics <file>       可选，vLLM/SGLang /metrics 的 text dump（区分「卡空闲」与「卡在等请求」，G3 必需）。
                         只吃 dump 文件，绝不连端点。
  --lease <file>         租金表 lease.json: [{ "gpu_id"|"gpu_model", "cost_cny_per_hour", "note" }]
  --price A100=28.0      元/卡/小时，可重复；key 为 gpu_model 或 gpu_id。单价必须客户提供，工具不猜、不联网取价。

判定选项:
  --util-threshold <N>   有效 util 阈值，默认 30（%）
  --idle-minutes <N>     G1 连续空转时长阈值，默认 15（分钟）
  --min-replicas <N>     G2 低谷至少保留卡数；缺则 G2 只报现象不报金额
  --mem-total <MiB>      dmon 导出缺显存总量时填充（G4 需要）
  --metrics-gpu <key>    metrics dump 无 gpu 标签时绑定到的卡
  --metrics-staleness <s> as-of join 最大时延，默认 1800 秒
  --gpu-id <key>         无卡标识列的 CSV（nvidia-smi 循环导出）绑定到的卡

输出:
  --out <dir>            输出目录，默认 out/（report.md、findings.csv、assumptions.md）

退出码: 0 成功；2 参数/输入错误。
注意: 报告中所有金额均为上界，不是确定可省。G3 不计金额。`;

function fail(msg) {
  console.error('错误: ' + msg);
  process.exit(2);
}

function parseArgs(argv) {
  const o = {
    command: 'analyze', util: [], metrics: [], lease: null, priceKv: {},
    utilThreshold: 30, idleMinutes: 15, minReplicas: null, memTotal: null,
    metricsGpu: null, metricsStaleness: 1800, gpuId: null, out: 'out', seed: 42,
    help: false,
  };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('-')) { o.command = argv[0]; i = 1; }
  const need = (name) => { const v = argv[++i]; if (v == null) fail(`${name} 缺少参数值`); return v; };
  for (; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--util': o.util.push(need(a)); break;
      case '--metrics': o.metrics.push(need(a)); break;
      case '--lease': o.lease = need(a); break;
      case '--price': {
        const kv = need(a);
        const eq = kv.lastIndexOf('=');
        if (eq <= 0) fail(`--price 格式应为 KEY=元/小时，收到: ${kv}`);
        const v = parseFloat(kv.slice(eq + 1));
        if (!Number.isFinite(v)) fail(`--price 单价不是数字: ${kv}`);
        o.priceKv[kv.slice(0, eq)] = v;
        break;
      }
      case '--util-threshold': o.utilThreshold = parseFloat(need(a)); break;
      case '--idle-minutes': o.idleMinutes = parseFloat(need(a)); break;
      case '--min-replicas': o.minReplicas = parseFloat(need(a)); break;
      case '--mem-total': o.memTotal = parseFloat(need(a)); break;
      case '--metrics-gpu': o.metricsGpu = need(a); break;
      case '--metrics-staleness': o.metricsStaleness = parseFloat(need(a)); break;
      case '--gpu-id': o.gpuId = need(a); break;
      case '--out': o.out = need(a); break;
      case '--seed': o.seed = parseInt(need(a), 10); break;
      default: fail(`未知参数: ${a}（--help 看用法）`);
    }
  }
  for (const [k, v] of Object.entries({ '--util-threshold': o.utilThreshold, '--idle-minutes': o.idleMinutes, '--metrics-staleness': o.metricsStaleness })) {
    if (!Number.isFinite(v)) fail(`${k} 不是数字`);
  }
  if (o.minReplicas != null && !Number.isFinite(o.minReplicas)) fail('--min-replicas 不是数字');
  return o;
}

// 核心管线：文本 → 记录 → join → analyze → 渲染三件套
export function runPipeline({ utilTexts, metricsTexts, leaseEntries, priceKv, opts }) {
  const records = [];
  const inputs = [];
  let parseErrors = 0;
  const errSamples = [];
  const inlineEvents = new Map();
  for (const f of utilTexts) {
    const r = parseUtilText(f.text, { gpuId: opts.gpuId, memTotal: opts.memTotal });
    records.push(...r.records);
    parseErrors += r.parseErrors;
    errSamples.push(...r.errSamples);
    inputs.push({ name: f.name, format: r.format, records: r.records.length, parseErrors: r.parseErrors });
    if (r.eventsByGpu) for (const [g, evs] of r.eventsByGpu) {
      if (!inlineEvents.has(g)) inlineEvents.set(g, []);
      inlineEvents.get(g).push(...evs);
    }
  }
  const eventsByGpu = inlineEvents;
  for (const f of metricsTexts ?? []) {
    const r = parseMetricsText(f.text, { gpuBind: opts.metricsGpu });
    parseErrors += r.parseErrors;
    errSamples.push(...r.errSamples);
    inputs.push({ name: f.name, format: 'prom(metrics)', records: 0, parseErrors: r.parseErrors });
    for (const [g, evs] of r.eventsByGpu) {
      if (!eventsByGpu.has(g)) eventsByGpu.set(g, []);
      eventsByGpu.get(g).push(...evs);
    }
  }
  for (const arr of eventsByGpu.values()) arr.sort((a, b) => a.ts - b.ts);
  if (!records.length) fail('没有解析到任何利用率记录，检查 --util 文件格式');
  if (opts.memTotal != null) {
    for (const r of records) if (r.mem_total_mib == null) r.mem_total_mib = opts.memTotal;
  }
  const joined = joinMetrics(records, eventsByGpu, { staleness: opts.metricsStaleness ?? 1800 });

  // model 汇总（记录内 model 优先，其次 lease）
  const gpuKeys = [...new Set(records.map((r) => r.gpu_key))];
  const modelByGpu = new Map();
  for (const r of records) if (r.model && !modelByGpu.has(r.gpu_key)) modelByGpu.set(r.gpu_key, r.model);
  for (const e of leaseEntries ?? []) {
    if (e.gpu_id != null && e.gpu_model && !modelByGpu.has(String(e.gpu_id))) modelByGpu.set(String(e.gpu_id), e.gpu_model);
  }
  const prices = resolvePrices(gpuKeys, modelByGpu, leaseEntries, priceKv);

  const result = analyze({ records, prices, opts });
  const meta = { parseErrors, errSamples, inputs, memTotal: opts.memTotal, metricsStaleness: opts.metricsStaleness, joinedMetrics: joined };
  const report = renderReport(result, meta);
  const csv = renderFindingsCsv(result);
  const assumptions = renderAssumptions(result, meta);
  return { result, meta, report, csv, assumptions, records };
}

function writeOutputs(outDir, { report, csv, assumptions }) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.md'), report);
  writeFileSync(join(outDir, 'findings.csv'), csv);
  writeFileSync(join(outDir, 'assumptions.md'), assumptions);
}

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch (e) { fail(`读文件失败 ${p}: ${e.message}`); }
}

function loadLease(p) {
  const data = JSON.parse(readText(p));
  if (!Array.isArray(data)) fail('lease.json 顶层必须是数组');
  return data;
}

function printSummary(result, meta, outDir) {
  const t = result.totals;
  console.log(`[gpu-idle-audit] 窗口 ${t.window_start} ~ ${t.window_end}（${t.window_hours.toFixed(2)}h，采样间隔 ${result.nominalInterval}s）`);
  console.log(`  卡数 ${result.perGpu.length}，未定价 ${result.unpricedGpus.length ? result.unpricedGpus.join(',') : '无'}，parse_errors ${meta.parseErrors}，metrics join ${meta.joinedMetrics} 样本`);
  console.log(`  立即可回收（G1+G2）上界 ≤ ${t.immediate_upper_window.toFixed(2)} 元；需改造（G4）上界 ≤ ${t.reform_upper_window.toFixed(2)} 元；需调参（G3）不适用——不计金额`);
  console.log(`  所有金额为${result.upperNote}`);
  console.log(`  输出: ${join(outDir, 'report.md')}、findings.csv、assumptions.md`);
}

function cmdAnalyze(o) {
  if (!o.util.length) fail('缺少 --util <file>（--help 看用法）');
  const utilTexts = o.util.map((p) => ({ name: p, text: readText(p) }));
  const metricsTexts = o.metrics.map((p) => ({ name: p, text: readText(p) }));
  const leaseEntries = o.lease ? loadLease(o.lease) : [];
  if (!leaseEntries.length && !Object.keys(o.priceKv).length) {
    console.error('警告: 未提供 --lease/--price，所有卡将列入 unpriced_gpus，不计入任何金额');
  }
  const out = runPipeline({ utilTexts, metricsTexts, leaseEntries, priceKv: o.priceKv, opts: o });
  const outDir = resolve(o.out);
  writeOutputs(outDir, out);
  printSummary(out.result, out.meta, outDir);
}

async function cmdDemo(o) {
  const { generate } = await import('../synth.js');
  const outDir = resolve(o.out);
  mkdirSync(outDir, { recursive: true });
  const synth = generate({ seed: o.seed, outDir });
  console.log(`[demo] synth.js 生成: ${synth.dmonFile}（${synth.dmonLines} 行，8 卡 × 7×24h，间隔 ${synth.intervalSeconds}s）、${synth.metricsFile}、${synth.manifestFile}`);
  const leasePath = join(resolve(import.meta.dirname, '..'), 'fixtures', 'lease.demo.json');
  const out = runPipeline({
    utilTexts: [{ name: synth.dmonFile, text: readText(synth.dmonFile) }],
    metricsTexts: [{ name: synth.metricsFile, text: readText(synth.metricsFile) }],
    leaseEntries: loadLease(leasePath),
    priceKv: {},
    opts: { ...o, memTotal: 81920, minReplicas: o.minReplicas ?? 2 },
  });
  writeOutputs(outDir, out);
  printSummary(out.result, out.meta, outDir);
  console.log(`[demo] ground truth: ${synth.manifestFile}（node --test test.js 用它做 ±5% 断言）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); process.exit(0); }
  else if (o.command === 'demo') await cmdDemo(o);
  else if (o.command === 'analyze') cmdAnalyze(o);
  else fail(`未知命令: ${o.command}（支持 analyze / demo，--help 看用法）`);
}
