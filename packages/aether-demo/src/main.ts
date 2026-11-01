#!/usr/bin/env node
/**
 * aether-demo CLI
 *
 *   aether-demo --repo https://github.com/user/project --out report.md
 *   aether-demo --repo . --offline                 # analyse this repo
 *   aether-demo --repo . --offline --chaos 3       # prove the retry path
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createEnvClient } from 'aether-llm'
import { createTracer, getGraph } from 'aether-core'
import { runPipeline } from './pipeline.js'

interface CliOptions {
  repo: string
  out: string
  offline: boolean
  chaos: number
  maxFiles?: number
  workDir?: string
  json: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    repo: '.',
    out: 'aether-report.md',
    offline: false,
    chaos: 0,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--repo':
      case '-r':
        opts.repo = next()
        break
      case '--out':
      case '-o':
        opts.out = next()
        break
      case '--offline':
        opts.offline = true
        break
      case '--chaos':
        opts.chaos = Number(next())
        break
      case '--max-files':
        opts.maxFiles = Number(next())
        break
      case '--work-dir':
        opts.workDir = next()
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`aether-demo — repo in, architecture report out

  -r, --repo <url|path>   repository to analyse (default: .)
  -o, --out <file>        markdown output path (default: aether-report.md)
      --offline           skip the model call, use the local architect
      --chaos <n>         inject n transient network faults (retry demo)
      --max-files <n>     cap on scanned source files (default: 400)
      --work-dir <dir>    where remote clones land (default: ./.aether-work)
      --json              print a machine-readable summary
  -h, --help              show this help`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const hasKey = Boolean(process.env.AETHER_INKSTONE_API_KEY ?? process.env.OPENAI_API_KEY)
  const offline = opts.offline || !hasKey
  const tracer = createTracer()

  console.log('Aether — reactive AI agent framework')
  console.log(`  repo    ${opts.repo}`)
  console.log(`  mode    ${offline ? 'offline (local architect)' : 'live (model router)'}`)
  if (opts.chaos > 0) console.log(`  chaos   ${opts.chaos} injected network fault(s)`)
  console.log('')

  const started = Date.now()
  const result = await runPipeline({
    repo: opts.repo,
    out: resolve(opts.out),
    offline,
    chaos: opts.chaos,
    maxFiles: opts.maxFiles,
    workDir: opts.workDir,
    client: offline ? undefined : createEnvClient(),
    tracer,
    log: (line) => console.log(line),
  })
  const elapsed = Date.now() - started

  // trace log — the replayable audit trail
  const traceDir = resolve('.aether-trace')
  await mkdir(traceDir, { recursive: true })
  const tracePath = resolve(traceDir, 'trace.ndjson')
  await writeFile(tracePath, tracer.toNDJSON(), 'utf8')

  const ok = result.trace.filter((t) => t.status === 'ok').length
  const failed = result.trace.length - ok
  const lines = [
    '',
    `✔ report written   ${resolve(opts.out)}`,
    `  nodes evaluated  ${result.trail.join(' → ')}`,
    `  files / lines    ${result.analysis.totalFiles} / ${result.analysis.totalLoc}`,
    `  edges            ${result.analysis.edges.length}`,
    `  model            ${result.model}`,
    `  retries          ${result.retried}`,
    `  trace entries    ${result.trace.length} (ok ${ok}, failed ${failed})`,
    `  elapsed          ${elapsed}ms`,
    `  trace log        ${tracePath}`,
  ]

  if (!opts.json) {
    console.log(lines.join('\n'))
    console.log('')
    const mermaid = getGraph().toMermaid().split('\n')
    console.log('reactive dependency graph (aether-core graph.toMermaid):')
    console.log(mermaid.slice(0, 200).join('\n'))
    if (mermaid.length > 200) console.log(`  … ${mermaid.length - 200} more lines`)
  } else {
    console.log(
      JSON.stringify(
        {
          out: resolve(opts.out),
          trail: result.trail,
          files: result.analysis.totalFiles,
          lines: result.analysis.totalLoc,
          edges: result.analysis.edges.length,
          model: result.model,
          retries: result.retried,
          traceEntries: result.trace.length,
          elapsedMs: elapsed,
        },
        null,
        2,
      ),
    )
  }
}

main().catch((error: unknown) => {
  console.error('aether-demo failed:', error instanceof Error ? error.message : error)
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'))
  process.exitCode = 1
})
