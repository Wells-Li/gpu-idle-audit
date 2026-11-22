# BENCHMARK · 自证跑测手册（第 0 单）

在花钱获客之前，先在自己能控制的环境里证明两件事：

1. **你真的能把 GPU 利用率提上去**（不是理论上，是有前后数字）
2. **这个工具在真实数据上跑出来的结论是对的**

跑完你会得到一份**真实的前后对比**，那是所有外发话术里最有杀伤力的附件——比开源脚本本身有用得多。

预算：**¥100–300，3–4 小时**。

---

## 0. 租卡

按小时租，不要包月。推荐用你已有的算力商账号，或 AutoDL / 阿里云 / RunPod。

| 卡 | 大约单价 | 够不够 |
|---|---|---|
| RTX 4090 24G | ¥1.5–2.5/小时 | **够，推荐**。7B 模型足够演示并发与批处理对 util 的影响 |
| A10 / L20 | ¥3.5–7.7/小时 | 够 |
| A100 80G | ¥25–35/小时 | 更接近客户环境，但贵 10 倍，第一次不必 |

**方法论在 4090 上成立，在 A100 上也成立**——你验证的是「util 随并发上升直到饱和」这条规律和你的操作能力，不是绝对数值。先用便宜卡把流程跑通。

---

## 1. 环境

```bash
# 建一个干净环境，别污染系统 python
python3 -m venv ~/vllm-test && source ~/vllm-test/bin/activate
pip install -U vllm

# 确认能看到卡
nvidia-smi
```

模型用 `Qwen/Qwen2.5-7B-Instruct`（小、下载快、许可宽松）。

---

## 2. 基线：默认参数 + 低并发（这一步要故意做错）

**开三个终端。**

**终端 A —— 起服务（刻意用保守参数）**

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --gpu-memory-utilization 0.85 \
  --max-num-seqs 4 \
  --port 8000
```

`--max-num-seqs 4` 就是「喂不饱」的典型配置：一次只允许 4 个请求在批里。

**终端 B —— 同时采集利用率**

```bash
nvidia-smi dmon -s um -d 1 -o DT > before.dmon
```

**终端 C —— 打压测**

```bash
vllm bench serve \
  --model Qwen/Qwen2.5-7B-Instruct \
  --dataset-name random \
  --random-input-len 1024 --random-output-len 256 \
  --num-prompts 200 --max-concurrency 4
```

> 不同 vLLM 版本的压测子命令名和参数有差异（老版本是 `benchmark_serving.py`）。**以 `vllm bench serve --help` 为准**，别照抄。核心是三个量要固定：输入长度、输出长度、请求总数。

压测跑完，`Ctrl-C` 停掉终端 B。

---

## 3. 跑工具，得到「变更前」报告

```bash
git clone <这个仓库> && cd gpu-idle-audit
node src/cli.js --util ../before.dmon --price "NVIDIA GeForce RTX 4090=2.0" --out out-before
```

记下 `out-before/report.md` 里的：有效小时占比、G3（喂不饱）时长占比。

**预期**：G3 会命中，而且占比很高。这就是「卡没喂饱」的样子。

---

## 4. 变更：三个动作，一次一个

**动作 1 —— 提高批内并发**

```bash
# 停掉服务，改这一个参数，其他不动
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --gpu-memory-utilization 0.85 \
  --max-num-seqs 32 \
  --port 8000
```

同样跑一遍压测（`--max-concurrency 32`），采集到 `after1.dmon`。

**动作 2 —— 提高显存利用率上限**

```bash
--gpu-memory-utilization 0.92 --max-num-seqs 32
```

采集到 `after2.dmon`。

**动作 3 —— 开前缀缓存**（如果你的压测 prompt 有共同前缀，这一项才看得出效果；`random` 数据集看不出来，**这是诚实的局限，别假装它有效**）

```bash
--enable-prefix-caching --gpu-memory-utilization 0.92 --max-num-seqs 32
```

采集到 `after3.dmon`。

---

## 5. 出对比

```bash
for f in before after1 after2 after3; do
  node src/cli.js --util ../$f.dmon --price "NVIDIA GeForce RTX 4090=2.0" --out out-$f
done
```

把四份 `report.md` 里的这几个数抄成一张表：

| 配置 | 有效小时占比 | 空转小时 | G3 占比 | 压测吞吐（req/s） | P99 延迟 |
|---|---|---|---|---|---|
| max-num-seqs=4, gmu=0.85 | | | | | |
| max-num-seqs=32, gmu=0.85 | | | | | |
| max-num-seqs=32, gmu=0.92 | | | | | |
| + prefix-caching | | | | | |

**这张表就是你要发出去的附件。**

---

## 6. 怎么读结果（这一步决定你是真有本事还是只会背参数）

- **util 上升、吞吐上升、P99 没恶化** → 这是真优化，可以拿去卖。
- **util 上升、吞吐上升、但 P99 明显变差** → 这是拿延迟换吞吐。**必须告诉客户这个取舍**，让他们决定。隐瞒这一点是这类服务最常见的翻车原因。
- **util 上升但吞吐没动** → 你在空转上花了更多时间，不是优化。**这是最需要警惕的假信号**，也是为什么报告里 util 不能单独当指标。
- **`gpu-memory-utilization` 调太高导致 OOM** → 记下这个边界值，它就是你的参数模式库第一条。

**如果三个动作都做完，util 和吞吐都没有明显改善**，那说明这套方法在你的能力范围内跑不通——**这时候不要发那 25 条私信**，先补能力或者找分包方。这正是第 0 单存在的意义：它让你在花钱获客之前就知道答案。

---

## 7. 顺手产出的三样资产

跑完这一轮，除了那张对比表，你还得到：

1. **参数模式库第一条**：`max-num-seqs` 与 `gpu-memory-utilization` 在 24G 卡 + 7B 模型下的安全区间。这就是工作流阶段 8 里「第 3 单后固化」的东西，提前有了。
2. **一份踩坑记录**：OOM 的边界、压测参数怎么固定、dmon 采样间隔怎么选。**把它发出去**——这类内容比任何自我介绍都能建立可信度。
3. **工具的第二次真实验证**：合成数据测试证明代码没错，真实数据证明口径没错。这两件事不一样。
