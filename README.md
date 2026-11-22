# gpu-idle-audit

[![test](https://github.com/Wells-Li/gpu-idle-audit/actions/workflows/test.yml/badge.svg)](https://github.com/Wells-Li/gpu-idle-audit/actions/workflows/test.yml)

**你已经付了钱的 GPU，有多少小时在空转？按你的租金折算，那是多少钱？**

> **English TL;DR** — A zero-dependency Node CLI that answers one question: *of the GPU-hours you already paid for, how many did no work, and what did they cost at your own lease rate?* Feed it a `nvidia-smi dmon` / DCGM / vLLM-metrics dump plus your per-card hourly price; it reports idle hours and cost **as an upper bound**, split into "reclaimable now", "needs config change" and "needs re-architecture". It never phones home, never guesses prices, and never prints a "save 40%" style claim. Runs offline on Node ≥20 with zero `npm install`.


零依赖（只用 Node ≥20 内置模块）、纯本地、不联网、不猜价。输入你已有的利用率导出和每卡租金，输出一页报告：每张卡的计费小时、有效小时、空转小时、白烧金额**上界**，以及它属于「立即能回收」还是「要改配置」还是「要改架构」。

## 为什么写这个

公开数据里，这件事的浪费量级大得反常：

- Cast AI《2026 Kubernetes 优化报告》称 GPU 平均利用率 **仅 5%**，调优最好的集群 H200 也只有约 49%
- 行业估算**全国智算中心利用率约 20%–30%**；西部某千卡级智算中心上架率不足 50%，已上架服务器实际利用率不足 30%，年运营成本超 3,000 万元
- Mobvista 的公开复盘里有个经典案例：监控显示平均利用率 75%+，看起来很健康，月底结算却发现 **23% 的费用对应的时间段里 GPU 没有产生任何有效 token**——钱花在冷启动间隙、模型切换空窗和推理完成后没缩容的「挂机」时段

问题是，大多数团队**不知道自己那张卡的实际数字**。这个工具就是用来算这个数字的。

## 30 秒试用（不需要 GPU）

```bash
npm run demo
```

生成 8 张卡 × 7 天的合成数据，跑完整分析，写出 `out/report.md`、`out/findings.csv`、`out/assumptions.md`。合成数据的 ground truth 写在 `out/manifest.json`，`npm test` 用它做 ±5% 断言。

## 用你自己的数据

**第一步，采集（在你的 GPU 机器上，任选一种）**

```bash
# A. nvidia-smi dmon（推荐，含显存与功耗）
nvidia-smi dmon -s um -d 10 -o DT > dmon.txt

# B. nvidia-smi CSV 轮询
while true; do
  nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,memory.total \
    --format=csv,noheader,nounits >> util.csv; sleep 10
done

# C. DCGM Prometheus 文本导出（已有 dcgm-exporter 的话）
curl -s localhost:9400/metrics > dcgm.prom
```

采多久？至少覆盖一个完整的日周期（24 小时），最好 3–7 天，否则低谷检测（G2）没有意义。

**第二步，准备租金表** `lease.json`：

```json
[
  { "gpu_id": "0", "cost_cny_per_hour": 28.0, "note": "A100 80G 包月折算" },
  { "gpu_model": "A100", "cost_cny_per_hour": 28.0 }
]
```

或者直接用命令行传：`--price A100=28.0 --price H100=95.0`。**单价必须你自己填**——工具不联网取价、不猜价，没定价的卡不计入任何金额，只列进 `unpriced_gpus`。

**第三步，跑**

```bash
node src/cli.js --util dmon.txt --lease lease.json --min-replicas 2
# 可选：加入推理服务指标，区分「卡空闲」和「卡在等请求」
node src/cli.js --util dmon.txt --lease lease.json --metrics vllm.prom
```

`--metrics` 只吃 dump 文件（vLLM/SGLang `/metrics` 的文本导出），**工具绝不会自己去连你的端点**。

## 四个检测器

| id | 检测内容 | 口径 | 归入档位 |
|---|---|---|---|
| **G1** | 挂机不释放：`util` 连续低于阈值 ≥15 分钟，且期间 `running_req==0` | 最长连续段、段数、合计小时 | 立即可回收 |
| **G2** | 低谷未缩容：00:00–07:00 平均 util 与全天平均之比 <0.3 | 该时段小时数 × 单价 × 可缩容卡数 | 立即可回收 |
| **G3** | 喂不饱：util 在 30–70%、`waiting_req==0`、`kv_cache_usage<0.5` 的时长占比 | **不计金额** | 需调参 |
| **G4** | 显存占着不干活：`mem_used/mem_total>0.7` 但 `util<20%` | 时长 × 单价 | 需改造 |

去重优先级 G2 > G4 > G1，同一小时只计入一个检测器，避免「立即可回收」档重复计价。

## 它刻意不做的事

这些不是没做完，是设计决定：

- **所有金额都是上界。** 上界的含义是「假设这张卡可以完全释放或降级」。实际能省多少取决于你的业务允不允许缩容。报告里不会出现任何「预计降本 40%」这类百分比结论。
- **G3 不计金额。** 「卡没喂饱」是吞吐上限问题，不是闲置问题，把它算进钱里是骗人的。报告那一栏写的是「不适用」。
- **`nvidia-smi` 的 util 语义有限。** 它是「有 kernel 在跑的时间占比」，不是算力利用率。**util 高 ≠ 有效工作**，util 低也 ≠ 完全没干活。这个工具不测 FLOPS 占用率。这一句会在每份报告的口径声明里逐字出现——它是这份报告最容易被工程师攻击的地方，所以先自己说。
- **未覆盖**：多机通信瓶颈、NCCL、量化与 kernel 层优化、跨云比价、训练任务。
- **不联网**，不读环境变量里的密钥，只吃你给的导出文件。
- **零依赖**，不会 `npm install` 任何东西，代码可以全读完。

## 测试

```bash
npm test
```

17 个断言，覆盖：G1/G2/G4 的小时数与金额落在 ground truth ±5%、G3 金额为 0 且报告含「不适用」、`parse_errors ≥ 1`、未定价卡不计入总额、同一 seed 两次运行 `sha256(findings.csv)` 相同、50,000+ 行解析加四检测 <2000ms（实测约 87ms）、报告口径声明逐字包含 util 语义那句、格式嗅探（nvidia-smi CSV / DCGM prom / vLLM metrics as-of join）、demo 端到端。

## 采集命令与运行示例

```bash
# 完整的一条龙（在 GPU 机器上采 24 小时，然后拷回来分析）
nvidia-smi dmon -s um -d 10 -o DT > dmon.txt &
DMON=$!; sleep 86400; kill $DMON
node src/cli.js --util dmon.txt --price A100=28.0 --min-replicas 4 --out ./report
```

## 许可

MIT。

---

<!-- 发布前必填：这一段是 inbound 的唯一入口，空着等于没人能找到你 -->

## 需要有人帮你把这张表跑起来？

工具是开源的，你可以自己跑。如果你想让人替你把「跑完之后该改哪三个参数、改完怎么不回滚、下个月怎么盯着它别涨回去」这一段做掉，可以联系：

- 联系方式：**（待填：邮箱 / 微信 / 即刻）**
- 形式：按月兼职，3 个月起；不含 7×24 on-call
- 先决条件：你能提供 ≥24 小时的 `nvidia-smi dmon` 导出和每卡单价。**先免费跑一次诊断**，看完表再决定要不要谈。

