// 判定与算式（口径按 SPEC 写死，不自创）。
// 计费小时 = 首末时间戳跨度；E = Σ(util≥阈值)×Δt；I = 计费 − E；白烧 = I×p（上界）。
// 检测器去重优先级 G2 > G4 > G1：同一小时只计入一个档位（见 assumptions.md）。
// G3 明确不计金额。

import { inferInterval } from './parse.js';

const UPPER_NOTE = '上界，假设该卡可完全释放或降级；实际取决于业务是否允许缩容';
const G3_AMOUNT_NOTE = '不适用——这是吞吐上限问题，不是闲置问题';

function iso(ts) {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

export function resolvePrices(gpuKeys, modelByGpu, leaseEntries, priceKv) {
  // 返回 Map<gpu_key, {p, model, source}> 与 unpriced 列表。单价必须客户提供，工具不猜。
  const byId = new Map();
  const byModel = new Map();
  for (const e of leaseEntries ?? []) {
    const p = typeof e.cost_cny_per_hour === 'number' ? e.cost_cny_per_hour : parseFloat(e.cost_cny_per_hour);
    if (!Number.isFinite(p)) continue;
    if (e.gpu_id != null) byId.set(String(e.gpu_id), { p, model: e.gpu_model ?? null, note: e.note ?? null });
    if (e.gpu_model != null) byModel.set(String(e.gpu_model), { p, note: e.note ?? null });
  }
  const price = new Map();
  const unpriced = [];
  for (const key of gpuKeys) {
    const model = modelByGpu.get(key) ?? null;
    let hit = byId.get(key);
    let source = 'lease.gpu_id';
    let resolvedModel = hit?.model ?? model;
    if (!hit && model && byModel.has(model)) {
      hit = byModel.get(model);
      source = 'lease.gpu_model';
      resolvedModel = model;
    }
    if (!hit && priceKv && model && priceKv[model] != null) {
      hit = { p: priceKv[model], note: null };
      source = '--price';
      resolvedModel = model;
    }
    // --price 也允许直接按 gpu_key 定价
    if (!hit && priceKv && priceKv[key] != null) {
      hit = { p: priceKv[key], note: null };
      source = '--price(gpu_id)';
      resolvedModel = model;
    }
    if (hit) price.set(key, { p: hit.p, model: resolvedModel, source, note: hit.note });
    else {
      unpriced.push(key);
      price.set(key, { p: null, model, source: null, note: null });
    }
  }
  return { price, unpriced };
}

export function analyze({ records, prices = null, opts = {} }) {
  const utilThreshold = opts.utilThreshold ?? 30;
  const idleMinutes = opts.idleMinutes ?? 15;
  const minReplicas = opts.minReplicas ?? null;

  if (!records.length) {
    throw new Error('没有可用记录：检查输入文件与格式');
  }

  // 分组 + 排序
  const byGpu = new Map();
  for (const r of records) {
    if (!byGpu.has(r.gpu_key)) byGpu.set(r.gpu_key, []);
    byGpu.get(r.gpu_key).push(r);
  }
  const gpuKeys = [...byGpu.keys()].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  for (const k of gpuKeys) byGpu.get(k).sort((x, y) => x.ts - y.ts);

  // 模型：记录内 model 优先，其次定价表
  const modelByGpu = new Map();
  for (const k of gpuKeys) {
    const recs = byGpu.get(k);
    const m = recs.find((r) => r.model)?.model ?? null;
    modelByGpu.set(k, m);
  }
  const priceInfo = prices ?? resolvePrices(gpuKeys, modelByGpu, opts.leaseEntries, opts.priceKv);
  for (const k of gpuKeys) {
    if (modelByGpu.get(k) == null && priceInfo.price.get(k)?.model) {
      modelByGpu.set(k, priceInfo.price.get(k).model);
    }
  }

  // 采样间隔（每卡众数）与 dt（末样本 dt=0，使 Σdt == 首末跨度）
  const intervalByGpu = new Map();
  const dtArr = new Map();
  for (const k of gpuKeys) {
    const recs = byGpu.get(k);
    const iv = inferInterval(recs.map((r) => r.ts));
    intervalByGpu.set(k, iv);
    const dts = new Array(recs.length).fill(iv ?? 0);
    if (recs.length) dts[recs.length - 1] = 0;
    dtArr.set(k, dts);
  }
  const intervals = [...new Set([...intervalByGpu.values()].filter((v) => v != null))].sort((a, b) => a - b);
  const nominalInterval = intervals.length === 1 ? intervals[0] : (intervals[0] ?? null);

  let windowStart = Infinity, windowEnd = -Infinity;
  for (const recs of byGpu.values()) {
    windowStart = Math.min(windowStart, recs[0].ts);
    windowEnd = Math.max(windowEnd, recs[recs.length - 1].ts);
  }
  const windowHours = (windowEnd - windowStart) / 3600;
  const monthFactor = windowHours > 0 ? 720 / windowHours : 0;

  // G2 分组因子：同 model 组内 可缩容卡数 = max(0, T − min_replicas)
  const modelCounts = new Map();
  for (const k of gpuKeys) {
    const m = modelByGpu.get(k);
    if (m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
  }

  const perGpu = [];
  const g1Evidence = [], g2Evidence = [], g3Evidence = [], g4Evidence = [];

  for (const k of gpuKeys) {
    const recs = byGpu.get(k);
    const dts = dtArr.get(k);
    const n = recs.length;
    const pr = priceInfo.price.get(k) ?? { p: null, model: null };
    const p = pr.p;
    const model = modelByGpu.get(k);

    const billed = (recs[n - 1].ts - recs[0].ts) / 3600;
    let effectiveSec = 0;
    for (let i = 0; i < n; i++) {
      const u = recs[i].util_pct;
      if (u != null && u >= utilThreshold) effectiveSec += dts[i];
    }
    const effective = effectiveSec / 3600;
    const idle = billed - effective;

    // ---- G2：按天分桶，00:00–07:00 平均 util / 全天平均 < 0.3 ----
    const dayStats = new Map(); // dayIdx → {nightSum,nightN,allSum,allN,nightIdx:[]}
    for (let i = 0; i < n; i++) {
      const ts = recs[i].ts;
      const dayIdx = Math.floor(ts / 86400);
      const hour = Math.floor((ts % 86400) / 3600);
      let d = dayStats.get(dayIdx);
      if (!d) { d = { nightSum: 0, nightN: 0, allSum: 0, allN: 0, nightIdx: [] }; dayStats.set(dayIdx, d); }
      const u = recs[i].util_pct;
      if (u != null) { d.allSum += u; d.allN++; }
      if (hour < 7) {
        d.nightIdx.push(i);
        if (u != null) { d.nightSum += u; d.nightN++; }
      }
    }
    const g2Flag = new Uint8Array(n);
    let g2Sec = 0;
    const g2Days = [];
    for (const [dayIdx, d] of [...dayStats.entries()].sort((a, b) => a[0] - b[0])) {
      if (!d.nightN || !d.allN) continue;
      const nightMean = d.nightSum / d.nightN;
      const allMean = d.allSum / d.allN;
      if (allMean <= 0) continue;
      const ratio = nightMean / allMean;
      if (ratio < 0.3) {
        let h = 0;
        for (const i of d.nightIdx) { g2Flag[i] = 1; g2Sec += dts[i]; h += dts[i]; }
        g2Days.push({ day: iso(dayIdx * 86400).slice(0, 10), night_mean: nightMean, all_mean: allMean, ratio, hours: h / 3600 });
      }
    }
    const g2Hours = g2Sec / 3600;
    let g2Factor = null;
    if (minReplicas != null && model) {
      const T = modelCounts.get(model) ?? 0;
      g2Factor = T > 0 ? Math.max(0, T - minReplicas) / T : 0;
    }
    const g2Amount = (p != null && g2Factor != null) ? g2Hours * p * g2Factor : null;
    if (g2Hours > 0) {
      g2Evidence.push({ gpu: k, days: g2Days, hours: g2Hours, amount_cny_upper: g2Amount });
    }

    // ---- G4：mem_used/mem_total > 0.7 且 util < 20（未被 G2 计入的样本）----
    let g4Sec = 0;
    const g4Flag = new Uint8Array(n);
    let g4First = null, g4Last = null, g4RatioSum = 0, g4RatioN = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      if (g2Flag[i]) continue;
      if (r.mem_used_mib == null || r.mem_total_mib == null || r.mem_total_mib <= 0) continue;
      if (r.util_pct == null || r.util_pct >= 20) continue;
      const ratio = r.mem_used_mib / r.mem_total_mib;
      if (ratio <= 0.7) continue;
      g4Flag[i] = 1;
      g4Sec += dts[i];
      g4RatioSum += ratio; g4RatioN++;
      if (g4First == null) g4First = r.ts;
      g4Last = r.ts;
    }
    const g4Hours = g4Sec / 3600;
    const g4Amount = p != null ? g4Hours * p : null;
    if (g4Hours > 0) {
      g4Evidence.push({
        gpu: k, hours: g4Hours, mean_mem_ratio: g4RatioN ? g4RatioSum / g4RatioN : null,
        span: { start: iso(g4First), end: iso(g4Last + (intervalByGpu.get(k) ?? 0)) },
        amount_cny_upper: g4Amount,
      });
    }

    // ---- G1：util < 阈值 连续 ≥ idle-minutes，且 running_req==0 或 null；排除 G2/G4 样本 ----
    let runStart = -1, runSec = 0;
    let g1Sec = 0, g1Runs = 0, g1Longest = 0;
    const minRunSec = (idleMinutes / 60) * 3600;
    const flushRun = (endIdx) => {
      if (runStart < 0) return;
      if (runSec >= minRunSec) {
        g1Sec += runSec;
        g1Runs++;
        const h = runSec / 3600;
        if (h > g1Longest) g1Longest = h;
        g1RunsList.push({
          gpu: k, start: iso(recs[runStart].ts),
          end: iso(recs[endIdx].ts + (intervalByGpu.get(k) ?? 0)), hours: h,
        });
      }
      runStart = -1; runSec = 0;
    };
    const g1RunsList = [];
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      const cond = !g2Flag[i] && !g4Flag[i] &&
        r.util_pct != null && r.util_pct < utilThreshold &&
        (r.running_req == null || r.running_req === 0);
      if (cond) {
        if (runStart < 0) runStart = i;
        runSec += dts[i];
      } else {
        flushRun(i - 1);
      }
    }
    flushRun(n - 1);
    const g1Hours = g1Sec / 3600;
    const g1Amount = p != null ? g1Hours * p : null;
    g1Evidence.push(...g1RunsList.map((x) => ({ ...x, amount_cny_upper: p != null ? x.hours * p : null })));

    // ---- G3：util∈[30,70] 且 waiting==0 且 kv<0.5 的时长占比。不计金额。----
    let g3Sec = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      if (r.util_pct == null || r.util_pct < 30 || r.util_pct > 70) continue;
      if (r.waiting_req !== 0) continue;
      if (r.kv_cache_usage == null || r.kv_cache_usage >= 0.5) continue;
      g3Sec += dts[i];
    }
    const g3Hours = g3Sec / 3600;
    const g3Fraction = billed > 0 ? g3Hours / billed : 0;
    if (g3Hours > 0) {
      g3Evidence.push({ gpu: k, hours: g3Hours, fraction: g3Fraction, amount: G3_AMOUNT_NOTE });
    }

    // 主因：G1/G2/G4/G3 中该卡小时数最大者
    let mainCause = '—', mainMax = 0;
    for (const [id, h] of [['G2', g2Hours], ['G4', g4Hours], ['G1', g1Hours], ['G3', g3Hours]]) {
      if (h > mainMax) { mainMax = h; mainCause = id; }
    }

    perGpu.push({
      gpu_key: k, model, priced: p != null, price_cny_per_hour: p,
      billed_hours: billed, effective_hours: effective, idle_hours: idle,
      waste_upper_window_cny: p != null ? idle * p : null,
      waste_upper_month_cny: p != null ? idle * p * monthFactor : null,
      g1_hours: g1Hours, g1_runs: g1Runs, g1_longest_hours: g1Longest, g1_amount_upper: g1Amount,
      g2_hours: g2Hours, g2_days: g2Days.length, g2_amount_upper: g2Amount,
      g3_hours: g3Hours, g3_fraction: g3Fraction,
      g4_hours: g4Hours, g4_amount_upper: g4Amount,
      main_cause: mainCause,
    });
  }

  // ---- 汇总 findings（SPEC 统一结构）----
  const sum = (f) => perGpu.reduce((a, g) => a + f(g), 0);
  const sumNullable = (f) => {
    let s = 0, any = false;
    for (const g of perGpu) { const v = f(g); if (v != null) { s += v; any = true; } }
    return any ? s : null;
  };

  const g1TotalHours = sum((g) => g.g1_hours);
  const g1TotalAmount = sumNullable((g) => g.g1_amount_upper) ?? 0;
  const g2TotalHours = sum((g) => g.g2_hours);
  const g2TotalAmount = minReplicas == null ? null : (sumNullable((g) => g.g2_amount_upper) ?? 0);
  const g3TotalHours = sum((g) => g.g3_hours);
  const g4TotalHours = sum((g) => g.g4_hours);
  const g4TotalAmount = sumNullable((g) => g.g4_amount_upper) ?? 0;

  const findings = [
    {
      id: 'G1', title: '挂机不释放',
      hours: g1TotalHours, waste_cny_upper: g1TotalAmount, tier: '立即可回收',
      evidence: g1Evidence.sort((a, b) => b.hours - a.hours).slice(0, 10),
      action: '回收/释放挂机实例，配置空闲自动停机或缩容策略',
      preconditions: ['客户确认这些时段业务允许释放或降级该卡', UPPER_NOTE],
    },
    {
      id: 'G2', title: '低谷未缩容',
      hours: g2TotalHours, waste_cny_upper: g2TotalAmount, tier: '立即可回收',
      evidence: g2Evidence.slice(0, 12),
      action: '低谷时段定时缩容（cron / HPA / 云商定时伸缩组）',
      preconditions: minReplicas == null
        ? ['未提供 --min-replicas（可缩容卡数），只报现象不报金额']
        : [`--min-replicas=${minReplicas} 已由客户给定并确认`, `金额 = 低谷小时 × 单价 × 可缩容比例（同 model 组内 (T−min_replicas)/T）`, UPPER_NOTE],
    },
    {
      id: 'G3', title: '喂不饱',
      hours: g3TotalHours, waste_cny_upper: 0, tier: '需调参',
      amount_note: G3_AMOUNT_NOTE,
      evidence: g3Evidence.slice(0, 12),
      action: '加大 batch/并发、合并副本，提高单卡有效吞吐（调参，不是退卡）',
      preconditions: ['需要 vLLM/SGLang metrics dump；无指标覆盖的卡不参与 G3 判定', '本检测器不计金额，不进任何小计'],
    },
    {
      id: 'G4', title: '显存占着不干活',
      hours: g4TotalHours, waste_cny_upper: g4TotalAmount, tier: '需改造',
      evidence: g4Evidence.slice(0, 12),
      action: '调整副本数或模型切分，释放显存占用后缩卡',
      preconditions: ['多为副本数/模型切分问题，需业务侧改造方案确认', UPPER_NOTE],
    },
  ];

  const tiers = {
    immediate: {
      label: '立即可回收（G1+G2，需客户确认能缩容）', ids: ['G1', 'G2'],
      amount_upper: g1TotalAmount + (g2TotalAmount ?? 0),
      g2_amount_missing: minReplicas == null && g2TotalHours > 0,
    },
    tune: { label: '需调参（G3，不报金额）', ids: ['G3'], amount_upper: null, note: G3_AMOUNT_NOTE },
    reform: { label: '需改造（G4，报上界）', ids: ['G4'], amount_upper: g4TotalAmount },
  };

  const pricedRows = perGpu.filter((g) => g.priced);
  const totals = {
    window_hours: windowHours,
    window_start: iso(windowStart),
    window_end: iso(windowEnd),
    month_factor: monthFactor,
    total_idle_hours_priced: pricedRows.reduce((a, g) => a + g.idle_hours, 0),
    total_waste_upper_window: pricedRows.reduce((a, g) => a + g.waste_upper_window_cny, 0),
    total_waste_upper_month: pricedRows.reduce((a, g) => a + g.waste_upper_month_cny, 0),
    immediate_upper_window: tiers.immediate.amount_upper,
    reform_upper_window: tiers.reform.amount_upper,
  };

  return {
    gpuKeys, perGpu, findings, tiers, totals,
    unpricedGpus: priceInfo.unpriced,
    intervalByGpu, nominalInterval, intervals,
    windowStart, windowEnd, windowHours, monthFactor,
    utilThreshold, idleMinutes, minReplicas,
    upperNote: UPPER_NOTE, g3AmountNote: G3_AMOUNT_NOTE,
    modelCounts,
  };
}
