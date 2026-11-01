/**
 * The end-to-end reactive pipeline:
 *
 *   repo (state) ──▶ clone ──▶ cloned (state) ──▶ scan ──▶ files (state)
 *        └──────────────────────────────▶ read/analyze ──▶ analysis (state)
 *                                                              │
 *                                                     prompt (computed)
 *                                                              │
 *                                                          architect (llm)
 *                                                              │
 *                                                       markdown (state) ──▶ write
 *
 * Every arrow is a tracked dependency. Change `repo` and the whole downstream
 * chain is marked dirty and re-evaluated — no orchestrator loop, no `while`.
 */

import { dirname, join, resolve } from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import { analyze, rankModules, toMermaid, type RepoAnalysis, type SourceFile } from './analyzer.js'
import {
  computed,
  createTracer,
  defineNode,
  nextTick,
  pendingJobCount,
  ref,
  type AetherNodeKind,
  type Tracer,
  type TraceEntry,
} from 'aether-core'
import { withRetry, type LLMClient } from 'aether-llm'
import { runTool } from 'aether-tools'
import { cloneRepoTool, readSourcesTool, scanRepoTool, writeReportTool } from './tools.js'

export interface PipelineOptions {
  /** git URL or local directory */
  repo: string
  /** where clones land (unused when `repo` is a local dir) */
  workDir?: string
  /** markdown output path */
  out: string
  /** skip the network entirely and synthesise the report locally */
  offline?: boolean
  /** inject N transient failures into the model call, to prove retry */
  chaos?: number
  /** an LLM client (omit in offline mode) */
  client?: LLMClient
  maxFiles?: number
  tracer?: Tracer
  log?: (line: string) => void
}

export interface PipelineResult {
  markdown: string
  analysis: RepoAnalysis
  commit?: string
  files: number
  /** node ids in evaluation order — the reactive trail */
  trail: string[]
  /** how many model calls were lost and recovered */
  retried: number
  model: string
  trace: TraceEntry[]
}

const isLocalRepo = (repo: string): boolean =>
  repo.startsWith('/') ||
  repo.startsWith('\\') ||
  repo.startsWith('.') ||
  /^[A-Za-z]:[\\/]/.test(repo)

function slug(repo: string): string {
  const cleaned = repo.replace(/\.git$/, '').replace(/[\\/]+$/, '')
  const base = cleaned.split(/[\\/]/).pop() ?? 'repo'
  return base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'repo'
}

export function buildPrompt(analysis: RepoAnalysis): string {
  const ranked = rankModules(analysis).slice(0, 12)
  const moduleLines = ranked.map((m) => `- ${m.path} (in:${m.inDegree} out:${m.outDegree})`).join('\n')
  const coreModules = analysis.modules
    .filter((m) => m.exports.length > 0)
    .slice(0, 24)
    .map((m) => `- ${m.path}: exports [${m.exports.slice(0, 6).join(', ')}]`)
    .join('\n')
  return [
    `Repository: ${analysis.root}`,
    `Files: ${analysis.totalFiles}, lines: ${analysis.totalLoc}, by ext: ${JSON.stringify(analysis.byExt)}`,
    `Dependency edges: ${analysis.edges.length}`,
    '',
    'Load-bearing modules (by in-degree):',
    moduleLines,
    '',
    'Public surface:',
    coreModules,
    '',
    'Explain the architecture: layers, data flow, risks, and where a new node should plug in.',
  ].join('\n')
}

/** Deterministic fallback architect — no network key needed, still a real report. */
export function localArchitect(analysis: RepoAnalysis): string {
  const ranked = rankModules(analysis)
  const top = ranked.slice(0, 8)
  const leaves = ranked.filter((m) => m.inDegree === 0).slice(0, 5)
  const fanout = analysis.edges.length / Math.max(1, analysis.totalFiles)
  const layers = top.map((m) => `- \`${m.path}\` — ${m.inDegree} dependents, ${m.outDegree} imports`)

  const risks: string[] = []
  if (fanout > 2.5) risks.push('High fan-out: modules import many peers, consider a facade per layer.')
  if (leaves.length > ranked.length / 2) risks.push('Half the modules are leaves — likely orphaned or entrypoints.')
  if (analysis.totalFiles > 120) risks.push('Large surface for one package: split along dependency clusters.')
  if (risks.length === 0) risks.push('No structural red flags detected at this resolution.')

  const shown = analysis.modules.slice(0, 20)
  const shownPaths = new Set(shown.map((m) => m.path))
  const mermaid = [
    '```mermaid',
    toMermaid({
      ...analysis,
      modules: shown,
      edges: analysis.edges.filter(([from, to]) => shownPaths.has(from) && shownPaths.has(to)),
    }),
    '```',
  ].join('\n')

  return [
    '## Architecture (local analysis)',
    '',
    `The repository contains **${analysis.totalFiles} modules** and **${analysis.totalLoc} lines**, wired by **${analysis.edges.length} internal imports**.`,
    '',
    '### Load-bearing modules',
    ...layers,
    '',
    '### Suggested layering',
    '1. **State layer** — pure data modules, imported by many, importing nothing.',
    '2. **Derivation layer** — imports state and exports pure functions.',
    '3. **Effect layer** — entrypoints that perform I/O and are imported by nobody.',
    '',
    '### Risks',
    ...risks.map((r) => `- ${r}`),
    '',
    '### Dependency sketch',
    mermaid,
    '',
  ].join('\n')
}

/** Wrap the model call so injected faults are retried with the same context. */
async function callArchitect(
  options: PipelineOptions,
  prompt: string,
  analysis: RepoAnalysis,
  counters: { retried: number },
  log: (line: string) => void,
): Promise<{ text: string; model: string }> {
  const offline = options.offline ?? !options.client
  let remaining = options.chaos ?? 0

  const attempt = async (): Promise<{ text: string; model: string }> => {
    if (remaining > 0) {
      remaining--
      counters.retried++
      throw new TypeError('fetch failed (injected network fault)')
    }
    if (offline || !options.client) {
      return { text: localArchitect(analysis), model: 'local-architect' }
    }
    const res = await options.client.chat([{ role: 'user', content: prompt }], {
      complexity: 'complex',
      temperature: 0.2,
    })
    return { text: res.content ?? '', model: res.routedModel ?? 'unknown' }
  }

  return withRetry(attempt, {
    maxRetries: Math.max(3, options.chaos ?? 0),
    baseDelayMs: 20,
    maxDelayMs: 200,
    onRetry: (event) => {
      const message = event.error instanceof Error ? event.error.message : String(event.error)
      log(
        `  \u21bb model call failed (${message.slice(0, 64)}); retry #${event.attempt + 1} in ${event.delayMs}ms \u2014 resending the same prompt context`,
      )
    },
  })
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  const tracer = options.tracer ?? createTracer()
  const counters = { trail: [] as string[], retried: 0 }

  const local = isLocalRepo(options.repo)
  const workDir = resolve(options.workDir ?? join(process.cwd(), '.aether-work'))
  const dir = local ? resolve(options.repo) : join(workDir, slug(options.repo))
  const outPath = resolve(options.out)

  // starts empty so the assignment below is a real change and kicks the cascade
  const repo = ref('', { name: 'repo' })
  const targetDir = ref(dir, { name: 'targetDir' })
  const cloned = ref(false, { name: 'cloned' })
  const commit = ref<string | undefined>(undefined, { name: 'commit' })
  const files = ref<Array<{ path: string; bytes: number }>>([], { name: 'files' })
  const sources = ref<SourceFile[]>([], { name: 'sources' })
  const analysis = ref<RepoAnalysis | null>(null, { name: 'analysis' })
  const markdown = ref('', { name: 'markdown' })
  const written = ref<string | null>(null, { name: 'written' })
  let lastModel = 'pending'

  const prompt = computed(
    () => {
      const a = analysis.value
      return a ? buildPrompt(a) : ''
    },
    { name: 'prompt', kind: 'llm' },
  )

  // In-flight async bodies: the scheduler queue alone cannot see an `await`ing
  // node, so settle() also waits for this counter to reach zero.
  const inflight = { count: 0 }
  const step = (id: string, kind: AetherNodeKind, label: string, body: () => Promise<void>) =>
    defineNode(
      id,
      () => {
        inflight.count++
        return (async () => {
          try {
            await body()
          } finally {
            inflight.count--
          }
        })()
      },
      { kind, label, sync: false },
    )

  const cloneNode = step('clone', 'tool', 'clone repository', async () => {
    // read the reactive inputs *before* the first await (the golden rule)
    const source = repo.value
    const dest = targetDir.value
    if (!source) return // first pass: subscribe to repo, do no work yet
    counters.trail.push('clone')
    if (local) {
      await readdir(dest) // a local repo must already exist
    } else {
      await mkdir(dirname(dest), { recursive: true })
      await runTool(cloneRepoTool, { args: { repo: source, dest }, timeoutMs: 120_000, tracer: tracer.emit })
    }
    commit.value = await readCommit(dest)
    cloned.value = true
  })

  const scanNode = step('scan', 'tool', 'scan sources', async () => {
    if (!cloned.value) return
    const root = targetDir.value
    counters.trail.push('scan')
    const record = await runTool(scanRepoTool, {
      args: { root, maxFiles: options.maxFiles ?? 400 },
      timeoutMs: 30_000,
      tracer: tracer.emit,
    })
    files.value = record.result?.output.files ?? []
  })

  const analyzeNode = step('analyze', 'derived', 'parse sources + build graph', async () => {
    const list = files.value
    if (list.length === 0) return
    const root = targetDir.value
    counters.trail.push('analyze')
    const record = await runTool(readSourcesTool, {
      args: { root, files: list.map((f) => f.path) },
      timeoutMs: 60_000,
      tracer: tracer.emit,
    })
    sources.value = record.result?.output.files ?? []
    analysis.value = analyze(root, sources.value)
  })

  const architectNode = step('architect', 'llm', 'generate architecture report', async () => {
    const text = prompt.value
    const a = analysis.value
    if (!text || !a) return
    counters.trail.push('architect')
    const { text: report, model } = await callArchitect(options, text, a, counters, log)
    lastModel = model
    markdown.value = [
      '# Aether architecture report',
      '',
      `> repo \`${options.repo}\` — generated ${new Date().toISOString()}`,
      `> model \`${model}\` · ${a.totalFiles} files · ${a.totalLoc} lines · ${a.edges.length} edges`,
      '',
      report,
      '',
    ].join('\n')
  })

  const writeNode = step('write', 'tool', 'write report', async () => {
    const text = markdown.value
    if (!text) return
    counters.trail.push('write')
    const record = await runTool(writeReportTool, {
      args: { path: outPath, markdown: text },
      timeoutMs: 15_000,
      tracer: tracer.emit,
    })
    written.value = record.status === 'ok' ? (record.result?.output.path ?? outPath) : null
  })

  // The graph is already wired: one assignment cascades through every node.
  repo.value = options.repo
  await settle()

  const a = analysis.value
  if (!a) {
    throw new Error(`pipeline produced no analysis for "${options.repo}" — is it a repository with sources?`)
  }

  return {
    markdown: markdown.value,
    analysis: a,
    commit: commit.value,
    files: files.value.length,
    trail: counters.trail,
    retried: counters.retried,
    model: lastModel,
    trace: tracer.entries,
  }

  async function settle(maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      await nextTick()
      if (pendingJobCount() === 0 && inflight.count === 0) {
        await new Promise<void>((done) => setImmediate(done))
        if (pendingJobCount() === 0 && inflight.count === 0) {
          await nextTick()
          if (pendingJobCount() === 0 && inflight.count === 0) return
        }
      }
    }
    throw new Error('pipeline did not settle — a node keeps re-queueing itself')
  }

  // referenced to keep the ids stable for debugging / graph explain()
  void cloneNode
  void scanNode
  void analyzeNode
  void architectNode
  void writeNode
  void sources
  void written
}

async function readCommit(dir: string): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise<string>((done, fail) => {
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }, (err, stdout) =>
        err ? fail(err) : done(stdout),
      )
    })
    return out.trim()
  } catch {
    return undefined
  }
}
