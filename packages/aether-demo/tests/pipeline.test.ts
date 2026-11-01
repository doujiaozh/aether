import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTracer } from 'aether-core'
import {
  analyze,
  analyzeSource,
  rankModules,
  resolveImport,
  toMermaid,
} from '../src/analyzer.js'
import { buildPrompt, localArchitect, runPipeline } from '../src/pipeline.js'

const SRC_A = `import { b } from './b.js'
import { readFile } from 'node:fs/promises'

export interface Thing { id: string }
export function alpha(x: number): number { return b(x) + 1 }
export class Alpha {}
export const helper = (n: number) => n * 2
`

const SRC_B = `export function b(x: number): number { return x * 2 }
export const B_CONST = 7
`

const SRC_C = `import { alpha } from './a.js'
export const gamma = alpha(1)
`

test('analyzer: extracts imports, symbols and edges', () => {
  const a = analyzeSource('src/a.ts', SRC_A)
  assert.deepEqual(a.imports, ['./b.js', 'node:fs/promises'])
  assert.ok(a.exports.includes('Thing'))
  assert.ok(a.exports.includes('alpha'))
  assert.ok(a.exports.includes('Alpha'))
  assert.ok(a.exports.includes('helper'))
  assert.deepEqual(a.classes, ['Alpha'])
  assert.equal(a.loc, SRC_A.split('\n').length)

  const analysis = analyze('/repo', [
    { path: 'src/a.ts', text: SRC_A },
    { path: 'src/b.ts', text: SRC_B },
    { path: 'src/c.ts', text: SRC_C },
  ])
  assert.equal(analysis.totalFiles, 3)
  assert.ok(analysis.totalLoc > 0)
  assert.deepEqual(
    analysis.edges.sort(),
    [
      ['src/a.ts', 'src/b.ts'],
      ['src/c.ts', 'src/a.ts'],
    ].sort(),
  )
  assert.equal(analysis.byExt.ts, 3)

  const ranked = rankModules(analysis)
  assert.equal(ranked[0].path, 'src/a.ts') // imported by c, imports b
  assert.equal(ranked[0].inDegree, 1)

  const mermaid = toMermaid(analysis)
  assert.ok(mermaid.startsWith('flowchart LR'))
  assert.ok(/src_a_ts\["src\/a\.ts"\]/.test(mermaid))
  assert.ok(mermaid.includes('-->'))
})

test('analyzer: resolves .js specifiers to .ts sources', () => {
  const known = new Set(['src/b.ts', 'src/index.ts'])
  assert.equal(resolveImport('src/a.ts', './b.js', known), 'src/b.ts')
  assert.equal(resolveImport('src/a.ts', './b', known), 'src/b.ts')
  assert.equal(resolveImport('src/a.ts', '../x', known), undefined)
  assert.equal(resolveImport('src/a.ts', 'node:fs', known), undefined)
})

test('analyzer: prompt and local architect describe the real numbers', () => {
  const analysis = analyze('/repo', [
    { path: 'a.ts', text: SRC_A },
    { path: 'b.ts', text: SRC_B },
  ])
  const prompt = buildPrompt(analysis)
  assert.ok(prompt.includes('Load-bearing modules'))
  assert.ok(prompt.includes('a.ts'))
  const report = localArchitect(analysis)
  assert.ok(report.includes('## Architecture (local analysis)'))
  assert.ok(report.includes('**2 modules**'))
  assert.ok(report.includes('```mermaid'))
})

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aether-demo-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), SRC_A)
  await writeFile(join(root, 'src', 'b.ts'), SRC_B)
  await writeFile(join(root, 'src', 'c.ts'), SRC_C)
  await writeFile(join(root, 'README.md'), '# fixture\n')
  return root
}

test('demo: offline pipeline turns a repository into markdown', async (t) => {
  const root = await fixtureRepo()
  const out = join(root, 'report.md')
  const tracer = createTracer()

  t.after(async () => {
    try {
      await readFile(out, 'utf8')
    } catch {
      /* nothing to clean */
    }
  })

  const result = await runPipeline({
    repo: root,
    out,
    offline: true,
    tracer,
    log: () => {},
  })

  assert.deepEqual(result.trail, ['clone', 'scan', 'analyze', 'architect', 'write'])
  assert.equal(result.files, 3)
  assert.equal(result.analysis.totalFiles, 3)
  assert.equal(result.model, 'local-architect')
  assert.equal(result.retried, 0)

  const written = await readFile(out, 'utf8')
  assert.equal(written, result.markdown)
  assert.ok(written.startsWith('# Aether architecture report'))
  assert.ok(written.includes('## Architecture (local analysis)'))
  assert.ok(written.includes('model `local-architect`'))

  // one trace entry per sandboxed tool call, all ok
  assert.equal(tracer.entries.length, 3)
  assert.ok(tracer.entries.every((e) => e.kind === 'tool' && e.status === 'ok'))
  assert.deepEqual(
    tracer.entries.map((e) => e.id),
    ['scan_repo', 'read_sources', 'write_report'],
  )
})

test('demo: injected network faults are retried with the same context', async () => {
  const root = await fixtureRepo()
  const out = join(root, 'report-chaos.md')
  const logger: string[] = []

  const result = await runPipeline({
    repo: root,
    out,
    offline: true,
    chaos: 2,
    tracer: createTracer(),
    log: (line) => logger.push(line),
  })

  assert.equal(result.retried, 2)
  assert.ok(result.markdown.includes('## Architecture (local analysis)'))
  assert.ok(logger.some((line) => line.includes('retry #1')))
  assert.ok(logger.some((line) => line.includes('retry #2')))
  const written = await readFile(out, 'utf8')
  assert.ok(written.includes('model `local-architect`'))
})
