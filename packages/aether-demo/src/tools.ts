/**
 * The demo's tool belt: every entry is a real `Tool` from aether-tools, so each
 * call gets an AbortController deadline, arg validation and a replayable trace
 * record. Nothing here shells out except `git clone`, and that child process is
 * killed when the sandbox signal aborts.
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Tool } from 'aether-tools'
import type { SourceFile } from './analyzer.js'

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.pnpm-store',
  '.cache',
  'vendor',
])

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const DEFAULT_LIMITS = { maxFiles: 400, maxFileBytes: 200 * 1024, maxTotalBytes: 4 * 1024 * 1024 }

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function run(cmd: string, args: string[], cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim()
        rejectPromise(new Error(`${cmd} ${args.join(' ')} failed: ${detail}`))
        return
      }
      resolvePromise(stdout)
    })
    if (signal) {
      const onAbort = (): void => {
        child.kill()
        rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export interface CloneArgs {
  repo: string
  dest: string
  depth?: number
}
export interface CloneOutput {
  dest: string
  commit: string
}

/** `git clone --depth 1`, aborted (and the child killed) when the sandbox dies. */
export const cloneRepoTool: Tool<CloneArgs, CloneOutput> = {
  name: 'clone_repo',
  description: 'Shallow-clone a git repository into a local destination directory.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'https URL or local path of the repository' },
      dest: { type: 'string', description: 'absolute destination directory' },
      depth: { type: 'integer', minimum: 1 },
    },
    required: ['repo', 'dest'],
    additionalProperties: false,
  },
  async execute(ctx) {
    const depth = ctx.args.depth ?? 1
    await run('git', ['clone', '--depth', String(depth), '--quiet', ctx.args.repo, ctx.args.dest], undefined, ctx.signal)
    const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], ctx.args.dest, ctx.signal)).trim()
    return { output: { dest: ctx.args.dest, commit } }
  },
}

export interface ScanArgs {
  root: string
  maxFiles?: number
}
export interface ScanOutput {
  root: string
  files: Array<{ path: string; bytes: number }>
  skipped: number
}

/** Walk the repo, keep source files, stop before a Win7 netbook runs out of RAM. */
export const scanRepoTool: Tool<ScanArgs, ScanOutput> = {
  name: 'scan_repo',
  description: 'List source files of a repository, ignoring build and dependency directories.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      maxFiles: { type: 'integer', minimum: 1 },
    },
    required: ['root'],
    additionalProperties: false,
  },
  async execute(ctx) {
    const root = resolve(ctx.args.root)
    const maxFiles = ctx.args.maxFiles ?? DEFAULT_LIMITS.maxFiles
    const files: Array<{ path: string; bytes: number }> = []
    let skipped = 0

    const walk = async (dir: string): Promise<void> => {
      if (signalAborted(ctx.signal)) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (signalAborted(ctx.signal)) return
        if (entry.name.startsWith('.') && entry.name !== '.env.example') {
          if (entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
        }
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) {
            skipped++
            continue
          }
          await walk(full)
          continue
        }
        if (!entry.isFile() || !SOURCE_EXTS.has(extname(entry.name))) continue
        if (files.length >= maxFiles) {
          skipped++
          continue
        }
        try {
          const info = await stat(full)
          if (info.size > DEFAULT_LIMITS.maxFileBytes) {
            skipped++
            continue
          }
          files.push({ path: toPosix(relative(root, full)), bytes: info.size })
        } catch {
          skipped++
        }
      }
    }

    await walk(root)
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { output: { root, files, skipped } }
  },
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

export interface ReadArgs {
  root: string
  files: string[]
}
export interface ReadOutput {
  files: SourceFile[]
  skipped: string[]
}

/** Read the selected sources with a total-byte ceiling. */
export const readSourcesTool: Tool<ReadArgs, ReadOutput> = {
  name: 'read_sources',
  description: 'Read the text of selected source files under a repository root.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['root', 'files'],
    additionalProperties: false,
  },
  async execute(ctx) {
    const root = resolve(ctx.args.root)
    const out: SourceFile[] = []
    const skipped: string[] = []
    let total = 0
    for (const rel of ctx.args.files) {
      if (signalAborted(ctx.signal)) break
      const full = resolve(root, rel)
      if (!full.startsWith(root)) {
        skipped.push(rel)
        continue
      }
      try {
        const info = await stat(full)
        if (info.size > DEFAULT_LIMITS.maxFileBytes || total + info.size > DEFAULT_LIMITS.maxTotalBytes) {
          skipped.push(rel)
          continue
        }
        const text = await readFile(full, 'utf8')
        total += info.size
        out.push({ path: rel, text })
      } catch {
        skipped.push(rel)
      }
    }
    return { output: { files: out, skipped } }
  },
}

export interface WriteReportArgs {
  path: string
  markdown: string
}
export interface WriteReportOutput {
  path: string
  bytes: number
}

/** Write the generated architecture report to disk. */
export const writeReportTool: Tool<WriteReportArgs, WriteReportOutput> = {
  name: 'write_report',
  description: 'Write the generated markdown report to a local path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      markdown: { type: 'string' },
    },
    required: ['path', 'markdown'],
    additionalProperties: false,
  },
  async execute(ctx) {
    const target = resolve(ctx.args.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, ctx.args.markdown, 'utf8')
    return { output: { path: target, bytes: Buffer.byteLength(ctx.args.markdown) } }
  },
}

export const demoTools = [cloneRepoTool, scanRepoTool, readSourcesTool, writeReportTool]
