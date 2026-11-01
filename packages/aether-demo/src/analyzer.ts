/**
 * AST-lite repository analyzer.
 *
 * Zero dependencies on purpose: a full TypeScript program costs hundreds of MB
 * on a 8 GB Win7 box, while the demo only needs imports, exported symbols and a
 * dependency edge set to draw an architecture map. Regex scanning is honest
 * about its limits — it is a structural outline, not a type checker.
 */

export interface SourceFile {
  /** repo-relative path, always POSIX separators */
  path: string
  text: string
}

export interface ModuleInfo {
  path: string
  loc: number
  imports: string[]
  exports: string[]
  classes: string[]
  functions: string[]
}

export interface RepoAnalysis {
  root: string
  modules: ModuleInfo[]
  /** [from, to] repo-relative edges, imports resolved when possible */
  edges: Array<[string, string]>
  byExt: Record<string, number>
  totalLoc: number
  totalFiles: number
}

const IMPORT_RE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
const EXPORT_DECL_RE =
  /export\s+(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g
const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g
const FUNCTION_RE =
  /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\())/g

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function collect(re: RegExp, text: string, group = 1): string[] {
  const out: string[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const value = m[group]
    if (value) out.push(value)
  }
  return out
}

export function stripComments(text: string): string {
  // good enough for sizing + symbol scan; keeps strings untouched on purpose
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export function analyzeSource(path: string, rawText: string): ModuleInfo {
  const text = stripComments(rawText)
  const loc = rawText.length === 0 ? 0 : rawText.split('\n').length

  const exportsList: string[] = []
  EXPORT_LIST_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPORT_LIST_RE.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) exportsList.push(name)
    }
  }

  return {
    path,
    loc,
    imports: unique(collect(IMPORT_RE, text)),
    exports: unique([...collect(EXPORT_DECL_RE, text), ...exportsList]),
    classes: unique(collect(CLASS_RE, text)),
    functions: unique(
      (() => {
        const fn = collect(FUNCTION_RE, text, 1)
        const arrow = collect(FUNCTION_RE, text, 2)
        return [...fn, ...arrow]
      })(),
    ),
  }
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function normalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** Resolve a relative import to a module in the repo, if it lands on one. */
export function resolveImport(fromPath: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = normalize(posixDirname(fromPath) + '/' + spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]
  for (const c of candidates) {
    if (known.has(c)) return c
  }
  // TS ESM sources import './x.js' while the file on disk is './x.ts'
  if (base.endsWith('.js')) {
    const ts = base.slice(0, -3) + '.ts'
    if (known.has(ts)) return ts
    const tsx = base.slice(0, -4) + '.tsx'
    if (known.has(tsx)) return tsx
  }
  return undefined
}

export function analyze(root: string, files: SourceFile[]): RepoAnalysis {
  const modules = files.map((f) => analyzeSource(f.path, f.text))
  const known = new Set(modules.map((m) => m.path))

  const edges: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const mod of modules) {
    for (const spec of mod.imports) {
      const target = resolveImport(mod.path, spec, known)
      if (!target || target === mod.path) continue
      const key = `${mod.path}->${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([mod.path, target])
    }
  }

  const byExt: Record<string, number> = {}
  let totalLoc = 0
  for (const mod of modules) {
    const ext = mod.path.slice(mod.path.lastIndexOf('.') + 1)
    byExt[ext] = (byExt[ext] ?? 0) + 1
    totalLoc += mod.loc
  }

  return { root, modules, edges, byExt, totalLoc, totalFiles: modules.length }
}

/** Degree-ranked modules — the "load-bearing walls" of the repo. */
export function rankModules(analysis: RepoAnalysis): Array<{ path: string; inDegree: number; outDegree: number }> {
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const [from, to] of analysis.edges) {
    outDeg.set(from, (outDeg.get(from) ?? 0) + 1)
    inDeg.set(to, (inDeg.get(to) ?? 0) + 1)
  }
  return analysis.modules
    .map((m) => ({
      path: m.path,
      inDegree: inDeg.get(m.path) ?? 0,
      outDegree: outDeg.get(m.path) ?? 0,
    }))
    .sort((a, b) => b.inDegree - a.inDegree || b.outDegree - a.outDegree || a.path.localeCompare(b.path))
}

export function toMermaid(analysis: RepoAnalysis): string {
  const id = (p: string): string => 'm' + p.replace(/[^A-Za-z0-9]/g, '_')
  const lines = ['flowchart LR']
  for (const mod of analysis.modules) {
    const label = mod.path.replace(/^(\.\.\/)+/, '').replace(/^packages\//, '')
    lines.push(`  ${id(mod.path)}["${label}"]`)
  }
  for (const [from, to] of analysis.edges) {
    lines.push(`  ${id(from)} --> ${id(to)}`)
  }
  return lines.join('\n')
}
