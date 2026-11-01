# Aether

> **Aether：让 AI 编排像写前端一样简单、优雅、坚不可摧。**
> **Aether: make AI orchestration as simple, elegant and unbreakable as writing frontend code.**

Aether 是一个**响应式**（reactive）AI Agent 编排框架。它不再用 Chain / Graph DAG 拼装流程，
而是把 LLM、Tool、Memory、State 统一抽象为**响应式节点**：声明一次，依赖自动追踪，
基础状态变化时下游节点自动标记为 `dirty` 并在下一拍重新求值（re-evaluate）。

A pure-Node.js reactive AI orchestration framework. LLMs, tools, memory and state are all
reactive cells in one dependency graph: declare the flow once, and Aether re-evaluates only
what a change actually invalidates.

- 纯 Node.js + TypeScript（ESM），**零原生依赖**：没有 C++/Rust 编译、没有 PyTorch、没有本地向量库
  — 因此可以在 Windows 7 / 8 GB 内存的机器上跑（本项目即在该环境开发与验证）。
- 响应式内核基于 `Proxy` 手写，无 Vue/React/Redux/MobX 依赖。
- 可追溯：每一次 LLM 调用、工具执行、节点求值都进入依赖图与 Trace 日志，可回放。

---

## 1. 架构图 · Architecture

```mermaid
flowchart TB
  subgraph State["① State / Context（响应式基础状态）"]
    repo["repo: Ref&lt;string&gt;"]
    files["files: Ref&lt;FileStat[]&gt;"]
    analysis["analysis: Ref&lt;RepoAnalysis&gt;"]
  end

  subgraph Reactive["② aether_core —— 依赖图引擎"]
    direction LR
    track["track / trigger"]
    effect["ReactiveEffect"]
    computed["computed（惰性、缓存、可回放）"]
    graph["AetherGraph：节点 + 边 + dirty 传播"]
    sched["scheduler：queueJob 去重 → 串行 flush → nextTick"]
    trace["Tracer：NDJSON 轨迹"]
  end

  subgraph Tools["③ aether_tools —— 沙盒执行层"]
    run["runTool()"]
    abort["AbortController 超时 / 父信号合并"]
    registry["ToolRegistry：schema 校验 + 目录"]
  end

  subgraph LLM["④ aether_llm —— 调度与流控"]
    router["ModelRouter：Atria-Dawn ↔ deepseek-v4.1"]
    rl["RateLimiter：滑动窗口 50 RPM"]
    retry["withRetry：429 / 5xx 指数退避 + 抖动"]
    client["LLMClient：OpenAI 协议 / SSE 流"]
  end

  subgraph Flow["⑤ Agent 级响应式节点"]
    clone["clone"] --> scan["scan"] --> analyze["analyze"] --> architect["architect"] --> write["write"]
  end

  repo --> clone
  files --> analyze
  analysis --> computed --> architect
  clone -. "runTool" .-> run
  scan -. "runTool" .-> run
  write -. "runTool" .-> run
  run --> abort
  run --> trace
  architect -.-> client
  client --> router
  client --> rl
  client --> retry
  track --> effect
  effect --> graph
  computed --> graph
  graph --> sched
  graph --> trace
  graph -. "dirty 传播" .-> clone
  graph -. "dirty 传播" .-> architect

  classDef state fill:#eef2ff,stroke:#6366f1,stroke-width:1px;
  classDef core fill:#ecfdf5,stroke:#10b981,stroke-width:1px;
  classDef tool fill:#fff7ed,stroke:#f59e0b,stroke-width:1px;
  classDef llm fill:#fef2f2,stroke:#ef4444,stroke-width:1px;
  classDef flow fill:#f8fafc,stroke:#64748b,stroke-width:1px;
  class repo,files,analysis state;
  class track,effect,computed,graph,sched,trace core;
  class run,abort,registry tool;
  class router,rl,retry,client llm;
  class clone,scan,analyze,architect,write flow;
```

ASCII 速览（同一张图的极简版）：

```
  user input ──▶ repo (Ref) ──▶ clone ──▶ cloned ──▶ scan ──▶ files ──▶ analyze
                                                                        │
                                              analysis (Ref) ◀──────────┘
                                                     │
                                                prompt (computed)
                                                     │
                                                architect (LLM) ──▶ markdown ──▶ write ──▶ report.md
                                                     ▲
                                        ModelRouter + RateLimiter(50 RPM) + withRetry(429)
```

### 一次真实级联 · One real cascade

```
repo.value = "github.com/..."          # 唯一的命令式赋值
  └─ clone   runs → cloned.value = true
     └─ scan    runs → files.value = [...]      # 下游节点只重算受影响的
        └─ analyze runs → analysis.value = {...}
           └─ prompt (computed) 惰性失效
              └─ architect runs → markdown.value = "..."
                 └─ write runs → report.md
```

没有被依赖的节点**不会**运行；同一拍内的多次写入只会 flush 一次；`flushJobs` 串行执行，
async 节点不会并发踩踏状态。

---

## 2. 包结构 · Packages

| 包 | 作用 |
| --- | --- |
| `packages/aether-core` | 响应式内核：`ref` / `reactive` / `computed` / `effect` / `scope` / `watch` / `batch` / 调度器 / **响应式依赖图** `AetherGraph` / Trace |
| `packages/aether-llm` | OpenAI 协议与 Intern InkStone 客户端、SSE 流式解析、滑动窗口限流（默认 50 RPM）、429/5xx 指数退避 + 抖动重试、复杂度模型路由、`llmNode()` 响应式胶水 |
| `packages/aether-tools` | `Tool` 接口 + JSON-Schema 子集校验、`ToolRegistry`、`runTool()` 沙盒（AbortController 超时、父信号合并、调用轨迹） |
| `packages/aether-demo` | 端到端 Demo：GitHub 仓库 → 克隆 → 扫描 → AST-lite 分析 → 架构 Markdown，含断网自动重试与离线模式 |

依赖方向严格单向：`demo → tools/llm → core`；`core` 零运行时依赖。

---

## 3. 快速开始 · Quick start

```bash
# Node 18.16+（本项目在 Win7 + Node 26 上验证；无原生编译步骤）
pnpm install
pnpm build          # tsc -b，全仓库增量编译
pnpm test           # 79 个单测：core 40 / llm 27 / tools 7 / demo 5
```

Demo（无网络、无 API Key 也能跑；离线时使用确定性的本地架构师，保证可复现）：

```bash
pnpm demo:offline --repo .            # 分析当前仓库，输出 aether-report.md
pnpm demo:chaos 3                     # 注入 3 次网络故障，展示同一上下文的自动重试
```

真实模型（Intern InkStone，OpenAI 协议）：

```bash
set AETHER_INKSTONE_API_KEY=...       # cmd（PowerShell 用 $env:...）
node packages/aether-demo/dist/src/main.js --repo https://github.com/org/repo
```

生成的报告示例见 [`docs/sample-report.md`](docs/sample-report.md)。

---

## 4. 核心概念 · Core concepts

### 4.1 响应式节点 · Reactive nodes

```ts
import { ref, computed, defineNode, nextTick } from 'aether-core'

const repo = ref('', { name: 'repo' })
const cloned = ref(false, { name: 'cloned' })
const files = ref<string[]>([])

const clone = defineNode('clone', async () => {
  const source = repo.value       // ⚠️ 黄金规则：在第一个 await 之前读取响应式单元
  if (!source) return
  await cloneRepo(source)
  cloned.value = true
})

const scan = defineNode('scan', async () => {
  if (!cloned.value) return
  files.value = await walk(files.value.length ? [] : ['.'])
}, { kind: 'tool' })

repo.value = 'github.com/org/repo'   // 唯一命令式入口
await nextTick()                     // 级联收敛
```

**黄金规则（Golden rule）**：异步节点必须在第一个 `await` 之前、以**同步方式**完成所有
响应式读取。原因是 `activeEffect` 在 await 之后不再指向该节点，之后再读的 cell
不会被记录为依赖。这不是缺陷，而是显式、可预测的追踪语义——`EffectScope` / `defineNode`
的文档与全部示例均遵守它。

### 4.2 依赖图与 dirty 传播

`AetherGraph` 把每个 `ref`/`reactive` 键/`computed`/`defineNode` 注册为节点，`track()` 记录边，
`trigger()` **先**标脏（沿入边传递到全部下游）再调度 effect。因此：

- `graph.explain('architect')` 能回答“我为什么会重跑”（哪些上游变了、经过哪些边）。
- `graph.toMermaid()` 直接得到可粘贴到任何 Markdown 的架构图；`dirty` 节点带高亮样式。
- 即使某个 cell 当前没有订阅者，也会被标记为脏 —— 图永远如实反映陈旧状态。

### 4.3 工具沙盒 · Tool sandbox

```ts
import { defineTool, runTool, ToolRegistry } from 'aether-tools'

const readFile = defineTool({
  name: 'read_file',
  description: 'read a utf8 file relative to root',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  async execute({ path }, ctx) {
    ctx.signal.throwIfAborted()
    return { path, content: await readFileUtf8(path) }
  },
})

const record = await runTool(readFile, { args: { path: 'README.md' }, timeoutMs: 5_000, tracer })
// record.status: 'ok' | 'error' | 'timeout' | 'aborted'
```

- 超时由**真实定时器**驱动（`setTimeout` + `finally` 中 `clearTimeout`），无论成功、抛错还是
  超时都只清理一次，绝不泄漏悬挂的 30 秒定时器。
- 父 `AbortSignal` 与内部控制器合并（优先 `AbortSignal.any`，Node 18 回退手动转发）。
- 每次调用恰好产生一条 Trace 记录；失败 re-throw 原错误并附 `aetherStatus`。

### 4.4 LLM 调度与流控

```ts
import { createInkStoneClient } from 'aether-llm'

const client = createInkStoneClient({ apiKey: process.env.AETHER_INKSTONE_API_KEY })
const res = await client.chat([{ role: 'user', content: 'summarise this repo' }], {
  complexity: 'complex',  // → deepseek-v4.1；trivial/standard → Atria-Dawn
  tracer,
})
```

- **限流**：滑动窗口，默认 50 RPM / 60 s，`acquire()` 精确等到最旧时间戳离窗。
- **重试**：429 / 5xx / 网络 `TypeError` 才重试（401 之类立即失败）；指数退避 + full jitter；
  若有 `Retry-After`，取 `max(backoff, retryAfter)` 以尊重服务端。
- **路由**：按 `complexity`、prompt 长度、关键词（架构/审查/重构/调试/设计/理由/trace…）在
  快模型与强模型间切换；强模型连续失败会降级到快模型，成功即恢复。
- **可观测**：`LLMClient` 写入 `Tracer`，`toNDJSON()` 可直接落盘回放。

### 4.5 Trace 与回放

每个条目含 `kind`（llm/tool/graph/state）、`status`（ok/error/timeout/aborted）、`seq`、
`startedAt/finishedAt`、`input/output/error/meta`。`createTracer().emit` **原地**写入入参对象
并返回它，因此调用方事后 `Object.assign(entry, { status: 'error' })` 的修改会反映到轨迹里 ——
这是有意设计的契约（测试与 client 均依赖它）。

---

## 5. Demo：把任意仓库变成架构报告

```bash
node packages/aether-demo/dist/src/main.js \
  --repo https://github.com/doujiaozh/aether \
  --out aether-report.md \
  --max-files 400
```

流程：`clone_repo`（`git clone --depth 1`，abort 会 kill 子进程）→ `scan_repo`（忽略
`node_modules/.git/dist` 等，跳过二进制与超大文件）→ `read_sources` + AST-lite 正则分析
（import/export/class/function、`.js → .ts` 说明符解析、去重边）→ `architect`（LLM 或
本地确定性架构师）→ `write_report`。

**断网演示**：`--chaos N` 会在模型调用处注入 N 次 `TypeError: fetch failed`。
`withRetry` 用**同一份 prompt 上下文**重发，节点状态不丢；日志逐条打印
`↻ model call failed (...); retry #k in Xms — resending the same prompt context`。
离线（无 API Key）时自动退化为 `local-architect`，输出仍包含真实的模块计数、负载模块排序、
风险清单与 Mermaid 依赖草图。

---

## 6. 运行环境约束 · Runtime constraints

| 约束 | 说明 |
| --- | --- |
| OS | Windows 7 可用（本项目在该环境开发；CI 建议同时覆盖 Linux/macOS） |
| 内存 | 8 GB 足够：无编译器进程常驻、无原生库、无模型权重 |
| Node | ≥ 18.16（用到 `AbortSignal.any` 可选分支、`fetch`、`node:test`） |
| 依赖 | 零原生模块；运行时不依赖任何第三方库 |
| 构建 | 仅项目内 `typescript`（devDependency），避免依赖全局 `tsc` |

---

## 7. 目录 · Layout

```
dsh-aether-ai/
├── packages/
│   ├── aether-core/    # ref/reactive/computed/effect/scope/watch/scheduler/graph/trace
│   ├── aether-llm/     # client, rate-limiter, retry, router, inkstone, llm-node
│   ├── aether-tools/   # tool contract, sandbox runner, registry
│   └── aether-demo/    # analyzer, tools, pipeline, CLI
├── docs/
│   └── sample-report.md
├── tsconfig.base.json  # strict, NodeNext ESM, composite project references
└── pnpm-workspace.yaml
```

---

## 8. 测试 · Tests

```
node --test packages/aether-core/dist/tests/*.test.js     # 40 pass
node --test packages/aether-llm/dist/tests/*.test.js      # 27 pass
node --test packages/aether-tools/dist/tests/*.test.js    #  7 pass
node --test packages/aether-demo/dist/tests/*.test.js     #  5 pass
```

覆盖：依赖追踪/条件分支无残留订阅/`stop`/`batch`/`scope`；图边与脏传播、拓扑序、`explain`；
watch 的 async/sync/immediate/deep/once/cleanup；限流窗口、指数退避边界、`Retry-After`、
路由升级与降级、SSE 拼装、超时不破坏重试；沙盒超时/父信号/定时器不悬挂/参数校验；
Demo 的离线闭环与 chaos 重试计数。

---

## 9. License

MIT © Aether Contributors
