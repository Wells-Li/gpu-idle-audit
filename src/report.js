// 输出渲染：out/report.md、out/findings.csv、out/assumptions.md。
// 全部确定性（不含生成时刻），同输入 → sha256 相同。
// 金额一律标注为上界；G3 不计金额；口径声明逐字包含 nvidia-smi util 语义那句。

const VERBATIM_UTIL = 'nvidia-smi 的 util 是「有 kernel 在跑的时间占比」而非算力利用率，因此 util 高 ≠ 有效工作；本工具不测 FLOPS 占用率。';
const VERBATIM_UPPER = '上界，假设该卡可完全释放或降级；实际取决于业务是否允许缩容';
const VERBATIM_G3 = '不适用——这是吞吐上限问题，不是闲置问题';
const UNCOVERED = '多机通信瓶颈、NCCL、量化与 kernel 层优化、跨云比价、训练任务';

const f2 = (v) => (v == null ? '' : v.toFixed(2));
const f4 = (v) => (v == null ? '' : v.toFixed(4));
const f6 = (v) => (v == null ? '' : v.toFixed(6));

export function renderFindingsCsv(result) {
  const header = [
    'gpu_key', 'model', 'priced', 'price_cny_per_hour',
    'billed_hours', 'effective_hours', 'idle_hours',
    'waste_upper_window_cny', 'waste_upper_month_cny',
    'g1_hours', 'g1_runs', 'g1_longest_hours', 'g1_amount_upper_cny',
    'g2_hours', 'g2_days', 'g2_amount_upper_cny',
    'g3_hours', 'g3_fraction', 'g3_amount_cny',
    'g4_hours', 'g4_amount_upper_cny', 'main_cause',
  ].join(',');
  const lines = [header];
  for (const g of result.perGpu) {
    lines.push([
      csvCell(g.gpu_key), csvCell(g.model ?? ''), g.priced ? 'yes' : 'no',
      g.priced ? f2(g.price_cny_per_hour) : '',
      f4(g.billed_hours), f4(g.effective_hours), f4(g.idle_hours),
      f2(g.waste_upper_window_cny), f2(g.waste_upper_month_cny),
      f4(g.g1_hours), String(g.g1_runs), f4(g.g1_longest_hours), f2(g.g1_amount_upper),
      f4(g.g2_hours), String(g.g2_days), g.g2_amount_upper == null ? '' : f2(g.g2_amount_upper),
      f4(g.g3_hours), f6(g.g3_fraction), '0.00',
      f4(g.g4_hours), f2(g.g4_amount_upper), csvCell(g.main_cause),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function csvCell(s) {
  const str = String(s);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

export function renderReport(result, meta = {}) {
  const { totals, findings, tiers, perGpu } = result;
  const L = [];
  L.push('# GPU 空转审计报告（gpu-idle-audit v1）');
  L.push('');
  L.push(`数据窗口：${totals.window_start} ~ ${totals.window_end}（UTC，${f2(totals.window_hours)} 小时）。本报告完全由输入数据决定，可复现。`);
  L.push('');
  L.push('> 本报告所有金额均为' + VERBATIM_UPPER + '。禁止把上界读成确定可省。');
  L.push('');

  // 1. 一页表
  L.push('## 1. 每卡汇总');
  L.push('');
  L.push('| GPU | model | 计费小时 | 有效小时 | 空转小时 | 白烧上界（元/月） | 主因 |');
  L.push('|---|---|---:|---:|---:|---:|---|');
  for (const g of perGpu) {
    const waste = g.priced ? `≤ ${f2(g.waste_upper_month_cny)}` : '不计入（未定价）';
    L.push(`| ${g.gpu_key} | ${g.model ?? '未知'} | ${f2(g.billed_hours)} | ${f2(g.effective_hours)} | ${f2(g.idle_hours)} | ${waste} | ${g.main_cause} |`);
  }
  L.push(`| **合计（已定价卡）** | | | | ${f2(totals.total_idle_hours_priced)} | ≤ ${f2(totals.total_waste_upper_month)} | |`);
  L.push('');
  L.push(`「元/月」为窗口金额按 ${f2(totals.month_factor)} 倍（720h ÷ 窗口小时）线性外推的上界，不是承诺值。窗口内白烧上界合计 ≤ ${f2(totals.total_waste_upper_window)} 元。`);
  if (result.unpricedGpus.length) {
    L.push('');
    L.push(`**unpriced_gpus（未定价，不计入任何金额）**：${result.unpricedGpus.map((x) => 'GPU ' + x).join('、')}。单价必须由客户提供（lease.json 或 --price），工具不猜价、不联网取价。`);
  }
  L.push('');

  // 2. 三档小计
  const g1 = findings[0], g2 = findings[1], g3 = findings[2], g4 = findings[3];
  L.push('## 2. 三档小计（全部为上界）');
  L.push('');
  L.push(`- **${tiers.immediate.label}**：上界 ≤ ${f2(tiers.immediate.amount_upper)} 元（窗口内）`);
  L.push(`  - G1 ${g1.title}：${f2(g1.hours)} 小时，上界 ≤ ${f2(g1.waste_cny_upper)} 元`);
  if (g2.waste_cny_upper == null) {
    L.push(`  - G2 ${g2.title}：${f2(g2.hours)} 小时；未提供 --min-replicas（可缩容卡数），只报现象不报金额`);
  } else {
    L.push(`  - G2 ${g2.title}：${f2(g2.hours)} 小时，上界 ≤ ${f2(g2.waste_cny_upper)} 元（--min-replicas=${result.minReplicas}）`);
  }
  L.push(`- **${tiers.tune.label}**：金额栏 ${VERBATIM_G3}（G3 时长 ${f2(g3.hours)} 小时，占比见明细）`);
  L.push(`- **${tiers.reform.label}**：上界 ≤ ${f2(tiers.reform.amount_upper)} 元（G4 ${g4.title} ${f2(g4.hours)} 小时）`);
  L.push('');
  L.push(`以上每笔金额口径相同：${VERBATIM_UPPER}。`);
  L.push('');

  // 3. 检测器明细
  L.push('## 3. 检测器明细（evidence）');
  L.push('');
  L.push(`### G1 ${g1.title}（util < ${result.utilThreshold}% 连续 ≥ ${result.idleMinutes} 分钟，且 running_req==0 或该列为 null）`);
  if (g1.evidence.length) {
    L.push('');
    L.push('| GPU | 起 | 止 | 小时 | 上界（元） |');
    L.push('|---|---|---|---:|---:|');
    for (const e of g1.evidence) {
      L.push(`| ${e.gpu} | ${e.start} | ${e.end} | ${f2(e.hours)} | ${e.amount_cny_upper == null ? '不计入（未定价）' : '≤ ' + f2(e.amount_cny_upper)} |`);
    }
  } else {
    L.push('');
    L.push('本窗口未发现。');
  }
  L.push('');
  L.push(`G1 合计 ${f2(g1.hours)} 小时。在这个窗口里，这 ${f2(g1.hours)} 小时 util 低于 ${result.utilThreshold}%，按你给的单价，上界是 ${f2(g1.waste_cny_upper)} 元（未定价卡不计入）。`);
  L.push('');
  L.push(`### G2 ${g2.title}（按天分桶，00:00–07:00 平均 util / 全天平均 < 0.3）`);
  if (g2.evidence.length) {
    L.push('');
    L.push('| GPU | 低谷日 | 夜均 util | 全天均 util | 比值 | 小时 |');
    L.push('|---|---|---:|---:|---:|---:|');
    for (const e of g2.evidence) {
      for (const d of e.days) {
        L.push(`| ${e.gpu} | ${d.day} | ${f2(d.night_mean)}% | ${f2(d.all_mean)}% | ${f4(d.ratio)} | ${f2(d.hours)} |`);
      }
    }
  } else {
    L.push('');
    L.push('本窗口未发现。');
  }
  L.push('');
  if (g2.waste_cny_upper == null && g2.hours > 0) {
    L.push(`G2 合计 ${f2(g2.hours)} 小时。只报现象不报金额：可缩容卡数需 --min-replicas 给定。`);
  } else {
    L.push(`G2 合计 ${f2(g2.hours)} 小时，金额上界 ≤ ${f2(g2.waste_cny_upper)} 元（需客户确认能缩容）。`);
  }
  L.push('');
  L.push(`### G3 ${g3.title}（util 在 30–70% 之间、waiting_req==0、kv_cache_usage < 0.5 的时长占比高）`);
  L.push('');
  L.push(`金额栏：${VERBATIM_G3}`);
  if (g3.evidence.length) {
    L.push('');
    L.push('| GPU | 时长（小时） | 占计费时长比例 | 金额 |');
    L.push('|---|---:|---:|---|');
    for (const e of g3.evidence) {
      L.push(`| ${e.gpu} | ${f2(e.hours)} | ${f2(e.fraction * 100)}% | ${VERBATIM_G3} |`);
    }
  } else {
    L.push('');
    L.push('本窗口未发现（或无 vLLM/SGLang 指标覆盖，无法判定）。');
  }
  L.push('');
  L.push(`### G4 ${g4.title}（mem_used/mem_total > 0.7 且 util < 20%）`);
  if (g4.evidence.length) {
    L.push('');
    L.push('| GPU | 小时 | 平均显存占比 | 上界（元） |');
    L.push('|---|---:|---:|---:|');
    for (const e of g4.evidence) {
      L.push(`| ${e.gpu} | ${f2(e.hours)} | ${e.mean_mem_ratio == null ? '' : f2(e.mean_mem_ratio * 100) + '%'} | ${e.amount_cny_upper == null ? '不计入（未定价）' : '≤ ' + f2(e.amount_cny_upper)} |`);
    }
  } else {
    L.push('');
    L.push('本窗口未发现。');
  }
  L.push('');

  // 4. 口径声明
  L.push('## 4. 口径声明');
  L.push('');
  L.push(`- 采样间隔：${result.nominalInterval != null ? result.nominalInterval + ' 秒' : '无法推断'}（从相邻时间戳推断，不假设 1 秒${result.intervals.length > 1 ? '；各卡间隔不一致：' + result.intervals.join('/') + ' 秒' : ''}）。`);
  L.push(`- 窗口起止：${totals.window_start} ~ ${totals.window_end}（UTC），共 ${f2(totals.window_hours)} 小时。计费小时按每卡首末时间戳，不假设 7×24。`);
  L.push(`- util 阈值：${result.utilThreshold}%（--util-threshold 可覆盖）；G1 连续时长阈值：${result.idleMinutes} 分钟（--idle-minutes 可覆盖）。`);
  L.push(`- ${VERBATIM_UTIL}`);
  L.push(`- 金额口径：所有金额均为上界。${VERBATIM_UPPER}。报告只允许出现「在这个窗口里，这 X 小时 util 低于 ${result.utilThreshold}%，按你给的 Y 元/小时，上界是 Z 元」这类窗口级陈述，不出现任何百分比式降本结论。`);
  L.push(`- 去重优先级：G2 > G4 > G1，同一小时只计入一个检测器，避免「立即可回收」档重复计价。`);
  L.push(`- 「元/月」为线性外推上界（窗口金额 × 720 ÷ ${f2(totals.window_hours)}），假设业务负载按窗口模式重复，实际以真实月度数据为准。`);
  L.push(`- 解析失败 ${meta.parseErrors ?? 0} 行（parse_errors，样例：${(meta.errSamples ?? []).slice(0, 3).join(' | ') || '无'}），已跳过不中断。`);
  L.push('');

  // 5. 未覆盖
  L.push('## 5. 未覆盖');
  L.push('');
  L.push(UNCOVERED + '。');
  L.push('');
  return L.join('\n');
}

export function renderAssumptions(result, meta = {}) {
  const L = [];
  L.push('# 假设与客户需提供的项目（assumptions）');
  L.push('');
  L.push('## 默认参数');
  L.push('');
  L.push('| 参数 | 值 | 覆盖方式 |');
  L.push('|---|---|---|');
  L.push(`| util_threshold | ${result.utilThreshold}% | --util-threshold |`);
  L.push(`| idle-minutes（G1 连续时长） | ${result.idleMinutes} 分钟 | --idle-minutes |`);
  L.push(`| min-replicas（G2 可缩容卡数） | ${result.minReplicas ?? '未给定（G2 只报现象不报金额）'} | --min-replicas |`);
  L.push(`| mem-total（dmon 缺显存总量） | ${meta.memTotal != null ? meta.memTotal + ' MiB' : '未给定（缺总量的卡不参与 G4）'} | --mem-total |`);
  L.push(`| metrics 时延容忍（as-of join） | ${meta.metricsStaleness ?? 1800} 秒 | --metrics-staleness |`);
  L.push('| 月度外推 | 窗口金额 × 720 ÷ 窗口小时（上界） | 不可调，仅口径说明 |');
  L.push('');
  L.push('## 解释性口径（实现决定，均在报告中生效）');
  L.push('');
  L.push('- 时间戳一律按 UTC 解释；00:00–07:00 低谷桶按数据自身时区（UTC）划分。');
  L.push('- 每卡末样本 dt=0，使 Σdt 恰等于首末时间戳跨度（计费小时）。');
  L.push('- util 为 null 的样本不计入有效小时（计入空转），但不参与 G2 均值。');
  L.push('- 检测器去重优先级 G2 > G4 > G1。');
  L.push('- G2 金额 = 低谷小时 × 单价 × (同 model 组卡数 T − min_replicas)/T；min_replicas 未给定则金额为空。');
  L.push('- G3 一律不计金额：' + VERBATIM_G3 + '。');
  L.push('- ' + VERBATIM_UTIL);
  L.push('');
  L.push('## 客户需提供');
  L.push('');
  L.push('1. 单价：lease.json（gpu_id/gpu_model + cost_cny_per_hour）或 --price A100=28.0。工具不猜价、不联网取价。');
  L.push('2. --min-replicas：低谷至少保留几张卡（缺则 G2 只报现象）。');
  L.push('3. dmon 导出的显存总量：--mem-total <MiB>（dmon 文本不含 total）。');
  L.push('4. vLLM/SGLang /metrics dump 文件（G3 判定必需；不连端点，只吃 dump）。');
  L.push('');
  L.push('## 未定价卡（unpriced_gpus，不计入总额）');
  L.push('');
  L.push(result.unpricedGpus.length ? result.unpricedGpus.map((k) => '- GPU ' + k).join('\n') : '- 无');
  L.push('');
  L.push('## 输入文件');
  L.push('');
  for (const f of meta.inputs ?? []) L.push(`- ${f.name}（格式 ${f.format}，记录 ${f.records} 行，解析失败 ${f.parseErrors} 行）`);
  L.push('');
  L.push('## 未覆盖');
  L.push('');
  L.push(UNCOVERED + '。');
  L.push('');
  return L.join('\n');
}

export const VERBATIM = { VERBATIM_UTIL, VERBATIM_UPPER, VERBATIM_G3, UNCOVERED };
