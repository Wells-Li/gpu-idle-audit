# gpu-idle-audit v1 · 实现规格

零依赖 Node ≥20 CLI。输入客户已有的导出数据，输出「你每月为没干活的 GPU 付了多少钱」，并把可回收金额分成三档。

## 为什么是这个东西

它替代了原来那个「API 推理成本体检」工具作为开门物料。原因：GPU 租金与利用率数据**不含任何 prompt、用户内容或业务数据**，客户给数据的阻力接近零，而 API 日志要走安全评审。这是这个方向唯一的结构性优势，别把它复杂化。

## 输入（三选一以上即可跑，缺项在报告里明写）

1. **利用率序列**（必需，任一格式，自动嗅探）
   - `nvidia-smi dmon -s um -d 1 -o DT` 的文本导出
   - `nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,memory.total --format=csv` 循环导出
   - DCGM `dcgmproftester` / `dcgm-exported` Prometheus text dump
   - 自有 CSV，表头需含 `timestamp`（或 `time`/`dt`）+ 一个利用率列 + 一张卡标识列
   - 采样间隔从相邻时间戳推断，不假设 1 秒。
2. **租金表** `lease.json`：`[{ "gpu_id"|"gpu_model", "cost_cny_per_hour", "note" }]`，或用 `--price A100=28.0 --price H100=95.0` 传（元/卡/小时）。单价必须由客户自己填，工具不猜、不联网取价；缺失则该卡不计入金额，并列入 `unpriced_gpus`。
3. **可选：推理服务指标**（vLLM/SGLang `/metrics` 的 text dump）
   - `vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:gpu_cache_usage_sys`、`vllm:time_to_first_token_seconds` 直方图
   - 用途：区分「卡空闲」与「卡在等请求」，这是本工具最有价值的一层判断。

## 归一化内部记录

```
{ ts, gpu_key, model, util_pct, mem_used_mib, mem_total_mib,
  running_req, waiting_req, kv_cache_usage }
```
缺列填 null。解析失败行计入 `parse_errors`，不中断。

## 判定与算式（写死，不要自创口径）

设窗口时长 `H` 小时，单卡计费小时价 `p`。

- **计费小时** = 该卡在窗口内出现的时长（按首末时间戳，不假设 7×24）。
- **有效小时** `E` = `Σ (util_pct ≥ util_threshold) × Δt`，`util_threshold` 默认 **30%**，可 `--util-threshold` 覆盖。
- **空转小时** `I` = 计费小时 − 有效小时。
- **白烧金额** = `I × p`。这是**上界**，报告里必须原样写「上界，假设该卡可完全释放或降级；实际取决于业务是否允许缩容」。不要把上界写成确定可省。

四个检测器，输出统一结构 `{id, title, hours, waste_cny_upper, tier, evidence[], action, preconditions[]}`：

| id | 检测内容 | 口径 | 归入档位 |
|---|---|---|---|
| G1 | **挂机不释放**：`util_pct` 连续低于阈值 ≥ `--idle-minutes`（默认 15）且期间 `running_req==0` 或该列为 null | 输出最长连续段、段数、合计小时 | 立即可回收 |
| G2 | **低谷未缩容**：按小时分桶，`00:00–07:00` 平均 util 与全天平均之比 < 0.3 | 该时段合计小时 × p × 可缩容卡数（可缩容卡数需 `--min-replicas` 给定，缺则只报现象不报金额） | 立即可回收 |
| G3 | **喂不饱**：`util_pct` 在 30–70% 之间、且 `waiting_req==0`、且 `kv_cache_usage < 0.5` 的时长占比高 | 该时长占比；金额栏写「不适用——这是吞吐上限问题，不是闲置问题」 | 需调参 |
| G4 | **显存占着不干活**：`mem_used/mem_total > 0.7` 但 `util_pct < 20` 的时长 | 该时长 × p，档位为「需改造」（多为副本数/模型切分问题） | 需改造 |

G3 明确不计金额。这个诚实度是本工具的可信度来源，不要为了报表好看把它也算进钱里。

## 输出

`out/report.md`：
1. 一页表：每卡｜计费小时｜有效小时｜空转小时｜白烧上界（元/月）｜主因（G1–G4 编号）。
2. 三档小计：**立即可回收**（G1+G2，需客户确认能缩容）｜**需调参**（G3，不报金额）｜**需改造**（G4，报上界）。
3. **口径声明**（固定文案，逐字写）：采样间隔、窗口起止、util 阈值、`nvidia-smi` 的 util 是「有 kernel 在跑的时间占比」而非算力利用率，因此 **util 高 ≠ 有效工作**；本工具不测 FLOPS 占用率。这句话是这份报告最容易被工程师攻击的地方，必须先自己说。
4. **未覆盖**：多机通信瓶颈、NCCL、量化与 kernel 层优化、跨云比价、训练任务。

`out/findings.csv`：每卡一行。`out/assumptions.md`：所有默认参数与客户需提供的项目。

**禁止**在报告里出现任何百分比式的「预计降本 40%」结论。只允许出现「在这个窗口里，这 X 小时 util 低于 30%，按你给的 Y 元/小时，上界是 Z 元」。

## 合成数据与测试

`synth.js`：按 seed 生成 ≥50,000 行、跨 7×24 小时、含 8 张卡的 dmon 文本，注入已知量：3 段 G1 挂机、2 个 G2 低谷日、1 张卡的 G3、1 张卡的 G4。ground truth 写 `out/manifest.json`。

`test.js`（`node --test`，无框架）断言：
- G1/G2/G4 小时数与金额落在 manifest 真值 ±5%
- G3 金额为 0 且报告文本含「不适用」
- `parse_errors ≥ 1`（fixture 含一行畸形）
- 未定价卡出现在 `unpriced_gpus` 且不计入总额
- 50,000 行解析+四检测 < 2000ms
- 同一 seed 两次运行 `sha256(out/findings.csv)` 相同

## 硬约束

零依赖（`node:` 内置 only，不许 install）；**不联网**，包括不连客户的 vLLM 端点（只吃 dump 文件）；不读环境变量密钥；`--help` 可用。

## 不做

Web UI、SaaS、实时采集 daemon、DCGM 安装、跨云比价、kernel/量化建议、自动缩容、任何写操作。

## 完成定义

`node --test test.js` 退出 0；`npm run demo`（或 `node src/cli.js demo`）跑合成数据出报告；`node src/cli.js --help` 有内容。
