// 解析层：多格式嗅探 + 归一化内部记录。零依赖。
// 归一化记录: { ts, gpu_key, model, util_pct, mem_used_mib, mem_total_mib,
//              running_req, waiting_req, kv_cache_usage }
// 缺列填 null；解析失败行计入 parse_errors，不中断。

export function parseDmonDateTime(dateStr, timeStr) {
  if (!/^\d{8}$/.test(dateStr) || !/^\d{2}:\d{2}:\d{2}$/.test(timeStr)) return null;
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  const h = +timeStr.slice(0, 2), mi = +timeStr.slice(3, 5), s = +timeStr.slice(6, 8);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isNaN(t) ? null : t / 1000; // 一律按 UTC 解释（见 assumptions）
}

export function parseTimestamp(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    return v > 1e12 ? v / 1000 : v; // epoch ms 或 s
  }
  const iso = s.includes('T') || s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)
    ? s
    : s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'); // 无时区标记按 UTC
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t / 1000;
}

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(N\/A|NA|-|nan|NaN|\[N\/A\])$/i.test(s)) return null;
  const cleaned = s.replace(/[^0-9eE+\-.]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '+') return null;
  const f = parseFloat(cleaned);
  return Number.isFinite(f) ? f : null;
}

export function sniffFormat(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      if (/^#\s*TYPE\s+(DCGM_FI|vllm:)/i.test(t)) return 'prom';
      continue;
    }
    if (/^(DCGM_FI_\w+|vllm:[\w]+)\s*(\{|[\s])/.test(t)) return 'prom';
    if (/^\d{8}\s+\d{2}:\d{2}:\d{2}(\s|$)/.test(t)) return 'dmon';
    if (t.includes(',')) {
      const head = t.toLowerCase();
      if (/(timestamp|(^|,)\s*time\s*(,|$)|(^|,)\s*dt\s*(,|$))/.test(head)) return 'csv';
      return 'csv';
    }
    return 'dmon';
  }
  return 'unknown';
}

// ---------- dmon ----------
// nvidia-smi dmon -s um -d N -o DT
// 列: #Date Time gpu sm mem enc dec fb bar1 （fb = 显存已用 MiB）
export function parseDmon(text, opts = {}) {
  const records = [];
  let parseErrors = 0;
  const errSamples = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    const ts = f.length >= 2 ? parseDmonDateTime(f[0], f[1]) : null;
    if (ts == null || f.length < 7) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const gpuIdx = f[2];
    if (!/^\d+$/.test(gpuIdx)) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const smRaw = f[3].trim();
    const util = num(smRaw);
    if (util == null && !/^(N\/A|-)$/i.test(smRaw)) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const fb = f.length >= 9 ? num(f[7]) : num(f[f.length - 2]);
    records.push({
      ts,
      gpu_key: gpuIdx,
      model: null,
      util_pct: util,
      mem_used_mib: fb,
      mem_total_mib: null, // dmon 不含总量，由 --mem-total 填
      running_req: null,
      waiting_req: null,
      kv_cache_usage: null,
    });
  }
  return { records, parseErrors, errSamples, format: 'dmon' };
}

// ---------- CSV（nvidia-smi --query-gpu 循环导出 / 自有 CSV）----------
export function parseCsv(text, opts = {}) {
  const records = [];
  let parseErrors = 0;
  const errSamples = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return { records, parseErrors, errSamples, format: 'csv' };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const find = (pred) => header.findIndex(pred);
  const iTs = find((h) => /^(timestamp|time|dt|date_time)$/.test(h));
  let iUtil = find((h) => h.includes('utilization.gpu'));
  if (iUtil < 0) iUtil = find((h) => h.includes('util') && !h.includes('mem'));
  if (iUtil < 0) iUtil = find((h) => h === 'sm');
  const iMemUsed = find((h) => h.includes('memory.used') || h.includes('mem_used') || h.includes('fb_used'));
  const iMemTotal = find((h) => h.includes('memory.total') || h.includes('mem_total'));
  const iId = find((h) => /^(index|gpu|gpu_id|gpu_idx|gpu_uuid|uuid|device|id)$/.test(h));
  const iModel = find((h) => /^(name|model|modelname|gpu_model|gpu_name)$/.test(h));
  if (iTs < 0) {
    return {
      records,
      parseErrors: lines.length,
      errSamples: ['CSV 表头缺 timestamp/time/dt 列: ' + lines[0].slice(0, 120)],
      format: 'csv',
    };
  }
  const get = (f, i) => (i >= 0 && i < f.length ? f[i].trim() : '');
  for (let li = 1; li < lines.length; li++) {
    const f = lines[li].split(',');
    const ts = parseTimestamp(get(f, iTs));
    if (ts == null) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(lines[li].slice(0, 120));
      continue;
    }
    const utilRaw = iUtil >= 0 ? get(f, iUtil) : '';
    const util = num(utilRaw);
    if (util == null && utilRaw !== '' && !/^(N\/A|-)$/i.test(utilRaw)) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(lines[li].slice(0, 120));
      continue;
    }
    const idVal = iId >= 0 ? get(f, iId) : '';
    const gpuKey = idVal !== '' ? idVal : (opts.gpuId != null ? String(opts.gpuId) : '0');
    const modelRaw = iModel >= 0 ? get(f, iModel) : '';
    records.push({
      ts,
      gpu_key: gpuKey,
      model: modelRaw !== '' ? modelRaw : null,
      util_pct: util,
      mem_used_mib: num(get(f, iMemUsed)),
      mem_total_mib: num(get(f, iMemTotal)),
      running_req: null,
      waiting_req: null,
      kv_cache_usage: null,
    });
  }
  return { records, parseErrors, errSamples, format: 'csv' };
}

// ---------- Prometheus text（DCGM exporter / vLLM /metrics dump）----------
const PROM_RE = /^([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+([^\s]+))?\s*$/;

function parseLabels(s) {
  const out = {};
  if (!s) return out;
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

export function parseProm(text, opts = {}) {
  const records = []; // 设备指标 → 归一化记录
  const eventsByGpu = new Map(); // 服务指标 → as-of join 事件
  let parseErrors = 0;
  const errSamples = [];
  const devByKey = new Map(); // `${gpu}|${ts}` → partial
  const evByKey = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = PROM_RE.exec(line);
    if (!m) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const [, name, labelStr, valRaw, tsRaw] = m;
    const labels = parseLabels(labelStr);
    const value = num(valRaw);
    if (tsRaw == null) {
      parseErrors++; // 无时间戳的瞬时 dump 无法构成序列
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const ts = parseTimestamp(tsRaw);
    if (ts == null) {
      parseErrors++;
      if (errSamples.length < 5) errSamples.push(line.slice(0, 120));
      continue;
    }
    const gpu = labels.gpu ?? labels.gpu_id ?? labels.device ?? labels.UUID ??
      (opts.gpuBind != null ? String(opts.gpuBind) : '0');
    const model = labels.modelName ?? labels.model_name ?? null;
    if (name.startsWith('vllm:') || name.startsWith('sglang')) {
      const k = gpu + '|' + ts;
      let ev = evByKey.get(k);
      if (!ev) { ev = { ts, gpu, running: null, waiting: null, kv: null }; evByKey.set(k, ev); }
      if (name.includes('num_requests_running')) ev.running = value;
      else if (name.includes('num_requests_waiting')) ev.waiting = value;
      else if (name.includes('gpu_cache_usage')) ev.kv = value;
      continue;
    }
    if (!name.startsWith('DCGM_FI')) continue; // 其他指标忽略，不算错误
    const k = gpu + '|' + ts;
    let rec = devByKey.get(k);
    if (!rec) {
      rec = {
        ts, gpu_key: gpu, model, util_pct: null,
        mem_used_mib: null, mem_total_mib: null,
        fb_free_mib: null,
        running_req: null, waiting_req: null, kv_cache_usage: null,
      };
      devByKey.set(k, rec);
    }
    if (rec.model == null && model) rec.model = model;
    if (name === 'DCGM_FI_DEV_GPU_UTIL') rec.util_pct = value;
    else if (name === 'DCGM_FI_DEV_FB_USED') rec.mem_used_mib = value;
    else if (name === 'DCGM_FI_DEV_FB_FREE') rec.fb_free_mib = value;
    else if (name === 'DCGM_FI_DEV_FB_TOTAL') rec.mem_total_mib = value;
  }
  for (const rec of devByKey.values()) {
    if (rec.mem_total_mib == null && rec.mem_used_mib != null && rec.fb_free_mib != null) {
      rec.mem_total_mib = rec.mem_used_mib + rec.fb_free_mib;
    }
    delete rec.fb_free_mib;
    records.push(rec);
  }
  for (const ev of evByKey.values()) {
    if (!eventsByGpu.has(ev.gpu)) eventsByGpu.set(ev.gpu, []);
    eventsByGpu.get(ev.gpu).push(ev);
  }
  for (const arr of eventsByGpu.values()) arr.sort((a, b) => a.ts - b.ts);
  return { records, eventsByGpu, parseErrors, errSamples, format: 'prom' };
}

// 统一入口：嗅探 + 解析
export function parseUtilText(text, opts = {}) {
  const fmt = sniffFormat(text);
  if (fmt === 'prom') {
    const r = parseProm(text, opts);
    return { records: r.records, parseErrors: r.parseErrors, errSamples: r.errSamples, format: 'prom', eventsByGpu: r.eventsByGpu };
  }
  if (fmt === 'csv') return parseCsv(text, opts);
  if (fmt === 'dmon') return parseDmon(text, opts);
  return { records: [], parseErrors: 1, errSamples: ['无法识别的输入格式'], format: 'unknown' };
}

// 服务指标 dump（vLLM/SGLang）→ 每 gpu 的 as-of 事件序列
export function parseMetricsText(text, opts = {}) {
  const r = parseProm(text, opts);
  return { eventsByGpu: r.eventsByGpu, parseErrors: r.parseErrors, errSamples: r.errSamples };
}

// as-of join：样本取「最后一个 ts ≤ 样本 ts 且不超过 staleness」的指标值
function asOf(sortedEvents, ts, staleness, field) {
  let lo = 0, hi = sortedEvents.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].ts <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const ev = sortedEvents[best];
  if (ts - ev.ts > staleness) return null;
  return ev[field];
}

export function joinMetrics(records, eventsByGpu, { staleness = 1800 } = {}) {
  if (!eventsByGpu || !eventsByGpu.size) return 0;
  let joined = 0;
  for (const rec of records) {
    const evs = eventsByGpu.get(rec.gpu_key);
    if (!evs || !evs.length) continue;
    const running = asOf(evs, rec.ts, staleness, 'running');
    const waiting = asOf(evs, rec.ts, staleness, 'waiting');
    const kv = asOf(evs, rec.ts, staleness, 'kv');
    if (running != null) rec.running_req = running;
    if (waiting != null) rec.waiting_req = waiting;
    if (kv != null) rec.kv_cache_usage = kv;
    if (running != null || waiting != null || kv != null) joined++;
  }
  return joined;
}

// 采样间隔推断：相邻时间戳差值的众数（每卡），不假设 1 秒
export function inferInterval(sortedTs) {
  if (sortedTs.length < 2) return null;
  const counts = new Map();
  for (let i = 1; i < sortedTs.length; i++) {
    const d = Math.round(sortedTs[i] - sortedTs[i - 1]);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [d, n] of counts) {
    if (n > bestN || (n === bestN && d < best)) { best = d; bestN = n; }
  }
  return best;
}
