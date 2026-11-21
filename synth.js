// synth.js — 按 seed 生成 ≥50,000 行、跨 7×24 小时、8 张卡的 dmon 文本。
// 注入已知量：3 段 G1 挂机、2 个 G2 低谷日、1 张卡的 G3、1 张卡的 G4。
// ground truth 写 out/manifest.json。truth 与检测器同一套 dt 口径（末样本 dt=0），
// 注入段全部对齐 90s 网格，因此真值是构造性精确的。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = Date.UTC(2024, 0, 1) / 1000; // 2024-01-01T00:00:00Z = 1704067200
const DT = 90;                              // 采样间隔（秒）
const N = 6721;                             // 每卡样本数：6721×90s = 7 天 + 末样本
const GPUS = ['0', '1', '2', '3', '4', '5', '6', '7'];
const VALLEY_GPUS = new Set(['0', '1', '2', '3', '4', '6']);
const LOW_DAYS = [2, 5];                    // 1月3日、1月6日（dayIdx，UTC）
const PRICE = 28.0;                         // A100 元/卡/小时（fixtures/lease.demo.json 同值）
const MEM_TOTAL = 81920;

// 注入计划
const G1_EPS = [
  { gpu: '2', start: START + 0 * 86400 + 9 * 3600, end: START + 0 * 86400 + 11 * 3600 },        // 2h
  { gpu: '4', start: START + 2 * 86400 + 13 * 3600, end: START + 2 * 86400 + 16 * 3600 },       // 3h
  { gpu: '5', start: START + 5 * 86400 + 20 * 3600, end: START + 5 * 86400 + 21.5 * 3600 },     // 1.5h（未定价卡）
];
const G4_WINS = [ // gpu 7
  { start: START + 1 * 86400 + 10 * 3600, end: START + 1 * 86400 + 16 * 3600 },                 // 6h
  { start: START + 3 * 86400 + 9 * 3600, end: START + 3 * 86400 + 12 * 3600 },                  // 3h
];
const G3_GPU = '5';
const G4_GPU = '7';
const UNPRICED = new Set(['5']); // lease.demo.json 故意不给 GPU 5 定价

const pad = (v, w = 2) => String(v).padStart(w, '0');
function dmonDate(ts) {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function dmonTime(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

export function generate({ seed = 42, outDir = 'out' } = {}) {
  mkdirSync(outDir, { recursive: true });
  const rnd = mulberry32(seed);
  const lines = [];
  lines.push(`# gpu-idle-audit synthetic dmon export — nvidia-smi dmon -s um -d ${DT} -o DT (seed=${seed})`);
  lines.push('#Date       Time        gpu   sm   mem   enc   dec     fb   bar1');
  lines.push('#YYYYMMDD   HH:MM:SS    Idx    %     %     %     %     MB     MB');

  // truth 累计器（与检测器同口径：每卡末样本 dt=0）
  const truth = {
    g1: { hoursByGpu: {}, runs: 0, longest_hours: 0 },
    g2: { hoursByGpu: {}, daysByGpu: {} },
    g3: { sec: 0 },
    g4: { sec: 0 },
  };

  let malformedLines = 0;
  let dataLines = 0;
  for (let i = 0; i < N; i++) {
    const ts = START + i * DT;
    const dtSec = i < N - 1 ? DT : 0;
    const dayIdx = Math.floor(ts / 86400) - Math.floor(START / 86400);
    const hour = Math.floor((ts % 86400) / 3600);
    const dateStr = dmonDate(ts), timeStr = dmonTime(ts);

    if (i === 1234) {
      lines.push(`${dateStr} ${timeStr} 2 ##CORRUPT## 5 0 0 4096 300`); // fixture 畸形行 → parse_errors
      malformedLines++;
    }

    for (const g of GPUS) {
      let util, memRatio;
      let cat = 'baseline';
      const inValley = VALLEY_GPUS.has(g) && LOW_DAYS.includes(dayIdx) && hour < 7;
      const g1ep = G1_EPS.find((e) => e.gpu === g && ts >= e.start && ts < e.end);
      const g4w = g === G4_GPU && G4_WINS.find((w) => ts >= w.start && ts < w.end);

      if (inValley) {
        cat = 'g2';
        util = 3 + Math.floor(rnd() * 7);       // 3–9%
        memRatio = 0.55;
        truth.g2.hoursByGpu[g] = (truth.g2.hoursByGpu[g] ?? 0) + dtSec / 3600;
        truth.g2.daysByGpu[g] = truth.g2.daysByGpu[g] ?? new Set();
        truth.g2.daysByGpu[g].add(dayIdx);
      } else if (g4w) {
        cat = 'g4';
        util = 8 + Math.floor(rnd() * 7);       // 8–14%
        memRatio = 0.85;                         // >0.7 且 util<20
        truth.g4.sec += dtSec;
      } else if (g1ep) {
        cat = 'g1';
        util = 2 + Math.floor(rnd() * 6);       // 2–7%
        memRatio = 0.5;
        truth.g1.hoursByGpu[g] = (truth.g1.hoursByGpu[g] ?? 0) + dtSec / 3600;
      } else if (g === G3_GPU) {
        util = 35 + Math.floor(rnd() * 30);     // 35–64%：喂不饱区间 [30,70]
        memRatio = 0.45;
        truth.g3.sec += dtSec;                   // metrics 全窗口 waiting=0/kv=0.4（episode 除外）
      } else {
        if (hour < 7) { util = 45 + Math.floor(rnd() * 15); memRatio = 0.55; }  // 45–59%
        else { util = 50 + Math.floor(rnd() * 20); memRatio = 0.45 + rnd() * 0.15; } // 50–69%，显存 ≤0.6
      }
      void cat;
      const fb = Math.round(memRatio * MEM_TOTAL);
      const memCopy = 10 + Math.floor(rnd() * 50);
      lines.push(`${dateStr} ${timeStr} ${g} ${util} ${memCopy} 0 0 ${fb} ${2 + Math.floor(rnd() * 4)}`);
      dataLines++;
    }
  }

  // G1 段数/最长段（注入计划即真值）
  truth.g1.runs = G1_EPS.length;
  truth.g1.longest_hours = Math.max(...G1_EPS.map((e) => (e.end - e.start) / 3600));
  const g1HoursTotal = Object.values(truth.g1.hoursByGpu).reduce((a, b) => a + b, 0);
  const g1Amount = Object.entries(truth.g1.hoursByGpu)
    .filter(([g]) => !UNPRICED.has(g))
    .reduce((a, [g, h]) => a + h * PRICE, 0);

  const g2HoursTotal = Object.values(truth.g2.hoursByGpu).reduce((a, b) => a + b, 0);
  const T_A100 = GPUS.filter((g) => !UNPRICED.has(g)).length; // lease 里 model=A100 的卡数 = 7
  const MIN_REPLICAS = 2;
  const g2Factor = (T_A100 - MIN_REPLICAS) / T_A100;
  const g2Amount = Object.entries(truth.g2.hoursByGpu)
    .filter(([g]) => !UNPRICED.has(g))
    .reduce((a, [g, h]) => a + h * PRICE * g2Factor, 0);

  const g3Hours = truth.g3.sec / 3600;
  const billed = ((N - 1) * DT) / 3600; // 168h
  const g4Hours = truth.g4.sec / 3600;

  const dmonFile = join(outDir, 'dmon_synth.txt');
  const metricsFile = join(outDir, 'vllm_synth.txt');
  const manifestFile = join(outDir, 'manifest.json');
  writeFileSync(dmonFile, lines.join('\n') + '\n');

  // vLLM metrics dump（gpu5，900s 一条；episode 期间 running=0/kv=0.1，其余 running=3/kv=0.4）
  const mlines = ['# TYPE vllm:num_requests_running gauge', '# TYPE vllm:num_requests_waiting gauge', '# TYPE vllm:gpu_cache_usage_sys gauge'];
  const ep = G1_EPS.find((e) => e.gpu === G3_GPU);
  for (let t = START; t <= START + (N - 1) * DT; t += 900) {
    const inEp = t >= ep.start && t < ep.end;
    const ms = t * 1000;
    mlines.push(`vllm:num_requests_running{gpu="${G3_GPU}",model_name="demo-svc"} ${inEp ? 0 : 3}.0 ${ms}`);
    mlines.push(`vllm:num_requests_waiting{gpu="${G3_GPU}",model_name="demo-svc"} 0.0 ${ms}`);
    mlines.push(`vllm:gpu_cache_usage_sys{gpu="${G3_GPU}",model_name="demo-svc"} ${inEp ? 0.1 : 0.4} ${ms}`);
  }
  writeFileSync(metricsFile, mlines.join('\n') + '\n');

  const manifest = {
    seed,
    generator: 'synth.js',
    window: { start: iso(START), end: iso(START + (N - 1) * DT), hours: billed },
    interval_seconds: DT,
    gpus: GPUS.length,
    dmon_data_lines: dataLines,
    malformed_lines: malformedLines,
    metrics_file_lines: mlines.length - 3,
    lease: 'fixtures/lease.demo.json',
    price_cny_per_hour: PRICE,
    mem_total_mib: MEM_TOTAL,
    injected: {
      g1: G1_EPS.map((e) => ({ gpu: e.gpu, start: iso(e.start), end: iso(e.end), hours: (e.end - e.start) / 3600, priced: !UNPRICED.has(e.gpu) })),
      g2: { gpus: [...VALLEY_GPUS].sort(), days: LOW_DAYS.map((d) => iso(START + d * 86400).slice(0, 10)), hours_per_gpu: 14, min_replicas: MIN_REPLICAS },
      g3: { gpu: G3_GPU, note: 'util 35–64 全窗口，waiting=0，kv=0.4；G1 episode 时段除外' },
      g4: { gpu: G4_GPU, windows: G4_WINS.map((w) => ({ start: iso(w.start), end: iso(w.end), hours: (w.end - w.start) / 3600 })), mem_ratio: 0.85 },
    },
    truth: {
      g1: { hours: g1HoursTotal, runs: truth.g1.runs, longest_hours: truth.g1.longest_hours, amount_cny: g1Amount, note: 'amount 仅含已定价卡（gpu5 未定价 → 小时计入、金额 0）' },
      g2: { hours: g2HoursTotal, amount_cny: g2Amount, min_replicas: MIN_REPLICAS, model_group_T: T_A100, factor: g2Factor },
      g3: { gpu: G3_GPU, hours: g3Hours, fraction: g3Hours / billed, amount_cny: 0 },
      g4: { hours: g4Hours, amount_cny: g4Hours * PRICE },
      unpriced_gpus: [...UNPRICED],
    },
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  return { dmonFile, metricsFile, manifestFile, manifest, dmonLines: lines.length, dataLines, intervalSeconds: DT };
}

// 直接执行：node synth.js [seed] [outDir]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seed = parseInt(process.argv[2] ?? '42', 10);
  const outDir = process.argv[3] ?? 'out';
  const r = generate({ seed, outDir });
  console.log(`synth: ${r.dmonFile}（${r.dmonLines} 行，数据行 ${r.dataLines}，畸形 ${r.manifest.malformed_lines}）→ ${r.manifestFile}`);
}
