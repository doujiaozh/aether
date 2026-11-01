/**
 * AetherGraph — the dependency graph that sits on top of the reactivity core.
 *
 * Every named ref / computed / reactive object is a **node**; every reactive
 * read an effect performs becomes an **edge**. When a cell changes, the graph
 * marks the node and *all transitive dependents* dirty — so an agent can
 * answer "why did this re-run?" (`explain`) and an operator can render the
 * whole pipeline (`toMermaid`) at any moment.
 *
 * `defineNode(id, run)` is the declarative agent primitive: it registers a
 * runner that re-executes automatically whenever its reactive dependencies
 * change — in declaration order or not, the graph figures out the order.
 */
import { ReactiveEffect, type ReactiveEffectOptions } from './effect.js'
import { getActiveGraph, setActiveGraph } from './graph-channel.js'
import { queueJob } from './scheduler.js'
import { isPromiseLike } from './utils.js'

export type AetherNodeKind = 'state' | 'context' | 'tool' | 'llm' | 'agent' | 'derived'

export interface AetherNode {
  id: string
  kind: AetherNodeKind
  label?: string
  /** how many times this node's runner executed */
  evaluations: number
  /** wall-clock of the last execution */
  lastEvaluatedAt?: number
  /** last recorded error (if the runner threw) */
  error?: unknown
}

export interface AetherEdge {
  /** `from` depends on `to` */
  from: string
  to: string
}

export interface GraphSnapshot {
  nodes: AetherNode[]
  edges: AetherEdge[]
  /** ids currently marked dirty (state changed, re-evaluation pending/not yet read) */
  dirty: string[]
}

export type DirtyListener = (nodeId: string) => void

export class AetherGraph {
  readonly nodes = new Map<string, AetherNode>()
  /** id -> set of ids it depends on */
  private readonly out = new Map<string, Set<string>>()
  /** id -> set of ids that depend on it */
  private readonly in = new Map<string, Set<string>>()
  private readonly dirtySet = new Set<string>()
  private readonly listeners = new Set<DirtyListener>()
  private collector: { owner: string; deps: Set<string> } | undefined

  /** Make this graph the target of automatic node registration. */
  use(): this {
    setActiveGraph(this)
    return this
  }

  has(id: string): boolean {
    return this.nodes.has(id)
  }

  node(id: string): AetherNode | undefined {
    return this.nodes.get(id)
  }

  /** Register (or update) a node. Called automatically by ref/computed/reactive. */
  register(id: string, kind: AetherNodeKind, label?: string): AetherNode {
    const existing = this.nodes.get(id)
    if (existing) {
      existing.kind = kind
      if (label !== undefined) existing.label = label
      return existing
    }
    const node: AetherNode = { id, kind, label, evaluations: 0 }
    this.nodes.set(id, node)
    return node
  }

  removeNode(id: string): void {
    this.nodes.delete(id)
    this.dirtySet.delete(id)
    for (const dep of this.out.get(id) ?? []) this.in.get(dep)?.delete(id)
    for (const dependent of this.in.get(id) ?? []) this.out.get(dependent)?.delete(id)
    this.out.delete(id)
    this.in.delete(id)
  }

  addEdge(from: string, to: string): void {
    if (from === to) return
    let outSet = this.out.get(from)
    if (!outSet) {
      outSet = new Set()
      this.out.set(from, outSet)
    }
    if (outSet.has(to)) return
    outSet.add(to)
    let inSet = this.in.get(to)
    if (!inSet) {
      inSet = new Set()
      this.in.set(to, inSet)
    }
    inSet.add(from)
  }

  /** What does `id` read? */
  dependenciesOf(id: string): string[] {
    return [...(this.out.get(id) ?? [])]
  }

  /** What reads `id`? */
  dependentsOf(id: string): string[] {
    return [...(this.in.get(id) ?? [])]
  }

  /** Subscribe to dirty-marking events (state changed → dependents marked). */
  onDirty(listener: DirtyListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Mark `id` and every transitive dependent dirty, notifying listeners.
   * Called by the reactivity core on every trigger; safe and idempotent.
   */
  markDirty(id: string): void {
    if (!this.nodes.has(id)) return
    const affected = [id]
    const seen = new Set<string>([id])
    const stack = [id]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const dependent of this.in.get(current) ?? []) {
        if (!seen.has(dependent)) {
          seen.add(dependent)
          affected.push(dependent)
          stack.push(dependent)
        }
      }
    }
    for (const nodeId of affected) {
      if (!this.dirtySet.has(nodeId)) {
        this.dirtySet.add(nodeId)
        for (const listener of this.listeners) listener(nodeId)
      }
    }
  }

  isDirty(id: string): boolean {
    return this.dirtySet.has(id)
  }

  clearDirty(id: string): void {
    this.dirtySet.delete(id)
  }

  dirtyNodes(): string[] {
    return [...this.dirtySet]
  }

  reset(): void {
    this.nodes.clear()
    this.out.clear()
    this.in.clear()
    this.dirtySet.clear()
    this.collector = undefined
  }

  /**
   * Execute `fn` as the node `id`: dependency reads during `fn` replace the
   * node's outgoing edges, evaluation counters tick, dirty state clears.
   * Nested calls (computed inside computed, node inside node) restore the
   * previous collector afterwards.
   */
  runTracked<T>(id: string, fn: () => T): T {
    this.registerIfUnknown(id)
    const node = this.nodes.get(id)!
    const previousCollector = this.collector
    this.collector = { owner: id, deps: new Set() }
    node.evaluations++
    node.lastEvaluatedAt = Date.now()
    node.error = undefined
    this.dirtySet.delete(id)
    try {
      return fn()
    } finally {
      this.setOutEdges(id, this.collector.deps)
      this.collector = previousCollector
    }
  }

  /** @internal called from `track()` — record "the running node read `nodeId`". */
  noteDep(nodeId: string): void {
    if (this.collector && nodeId !== this.collector.owner) {
      this.collector.deps.add(nodeId)
    }
  }

  private registerIfUnknown(id: string): void {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, kind: 'derived', evaluations: 0 })
  }

  private setOutEdges(owner: string, deps: Set<string>): void {
    const previous = this.out.get(owner)
    const toRemove: string[] = []
    const toAdd: string[] = []
    for (const dep of previous ?? []) if (!deps.has(dep)) toRemove.push(dep)
    for (const dep of deps) if (!previous?.has(dep)) toAdd.push(dep)
    for (const dep of toRemove) this.in.get(dep)?.delete(owner)
    for (const dep of toAdd) {
      let inSet = this.in.get(dep)
      if (!inSet) {
        inSet = new Set()
        this.in.set(dep, inSet)
      }
      inSet.add(owner)
    }
    this.out.set(owner, deps)
  }

  /**
   * Full dependency-first ordering of every node (Kahn's algorithm).
   * Cycles (which a well-formed reactive graph should not have) are appended.
   */
  topologicalOrder(): string[] {
    const remaining = new Map<string, number>()
    const dependents = new Map<string, string[]>()
    for (const [from, deps] of this.out) {
      remaining.set(from, deps.size)
      for (const to of deps) {
        const list = dependents.get(to)
        if (list) list.push(from)
        else dependents.set(to, [from])
      }
    }
    const order: string[] = []
    const visited = new Set<string>()
    const ready: string[] = []
    for (const id of this.nodes.keys()) {
      if ((remaining.get(id) ?? 0) === 0) {
        ready.push(id)
        visited.add(id)
      }
    }
    while (ready.length > 0) {
      const id = ready.shift()!
      order.push(id)
      for (const dependent of dependents.get(id) ?? []) {
        const left = (remaining.get(dependent) ?? 0) - 1
        remaining.set(dependent, left)
        if (left === 0 && !visited.has(dependent)) {
          visited.add(dependent)
          ready.push(dependent)
        }
      }
    }
    if (order.length < this.nodes.size) {
      for (const id of this.nodes.keys()) if (!visited.has(id)) order.push(id)
    }
    return order
  }

  snapshot(): GraphSnapshot {
    const edges: AetherEdge[] = []
    for (const [from, deps] of this.out) {
      for (const to of deps) edges.push({ from, to })
    }
    return { nodes: [...this.nodes.values()], edges, dirty: [...this.dirtySet] }
  }

  /** Render the graph as a Mermaid flowchart (dependent --> dependency). */
  toMermaid(options: { direction?: 'TD' | 'LR' } = {}): string {
    const direction = options.direction ?? 'TD'
    const lines: string[] = [`graph ${direction}`]
    for (const node of this.nodes.values()) {
      const label = `${node.id} · ${node.kind}`
      lines.push(`  "${node.id}"["${label.replace(/"/g, "'")}"]`)
    }
    for (const [from, deps] of this.out) {
      for (const to of deps) lines.push(`  "${from}" --> "${to}"`)
    }
    for (const id of this.dirtySet) {
      if (this.nodes.has(id)) lines.push(`  style "${id}" stroke:#f59e0b,stroke-width:3px`)
    }
    return lines.join('\n')
  }

  /** Human readable "why would this re-run?" trace for one node. */
  explain(id: string, depth = 0, seen: Set<string> = new Set()): string {
    if (this.nodes.has(id)) this.registerIfUnknown(id)
    const node = this.nodes.get(id)
    const indent = '  '.repeat(depth)
    if (seen.has(id)) return `${indent}${id}${node ? ` (${node.kind})` : ''} ↩︎(cycle)`
    seen.add(id)
    const head = `${indent}${id}${node ? ` (${node.kind})` : ''}`
    const deps = this.out.get(id)
    if (!deps || deps.size === 0) return head
    const children = [...deps]
      .sort()
      .map((dep) => this.explain(dep, depth + 1, seen))
      .join('\n')
    return `${head}\n${children}`
  }
}

/** The default graph, active from the moment aether-core is imported. */
export const graph = new AetherGraph().use()

export function getGraph(): AetherGraph {
  return getActiveGraph() ?? graph
}

// ---- defineNode: declarative reactive agent nodes --------------------------

export interface DefineNodeOptions<T = any> extends ReactiveEffectOptions<T> {
  kind?: AetherNodeKind
  label?: string
  /** run immediately at definition (default true). */
  immediate?: boolean
  /**
   * Re-evaluate synchronously on dependency change (default false — the node
   * re-evaluates on the next microtask tick, matching "evaluate at next step").
   */
  sync?: boolean
}

export interface AetherNodeHandle<T = any> {
  readonly id: string
  readonly kind: AetherNodeKind
  readonly effect: ReactiveEffect<T>
  /** Trigger a manual re-run (regardless of dirty state). */
  run(): T
  /** Stop the node: unsubscribe it from the reactive graph. */
  stop(): void
}

function defaultNodeErrorHandler(id: string): (error: unknown) => void {
  return (error: unknown) => {
    const node = getGraph().node(id)
    if (node) node.error = error
    console.error(`[aether] node "${id}" failed:`, error)
  }
}

/**
 * Define a named node of the reactive pipeline.
 *
 * @example
 *   const repoUrl = ref('…', { name: 'repoUrl' })
 *   defineNode('agent.clone', () => { /* read repoUrl.value, clone repo *\/ })
 *   repoUrl.value = '…'   // agent.clone is marked dirty, re-runs next tick
 */
export function defineNode<T>(
  id: string,
  runner: () => T,
  options: DefineNodeOptions<T> = {},
): AetherNodeHandle<T> {
  const g = getGraph()
  g.register(id, options.kind ?? 'agent', options.label)
  const handleError = options.onError ?? defaultNodeErrorHandler(id)

  const wrapped: () => T = () => {
    return g.runTracked(id, () => {
      const result = runner()
      // async runners (agent steps that await) are hooked for error reporting;
      // the golden rule still applies: read your refs *before* the first await.
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch(handleError)
      }
      return result
    })
  }

  const effect = new ReactiveEffect<T>(wrapped, {
    ...options,
    scheduler:
      options.scheduler ??
      (options.sync === true
        ? undefined
        : (job) => {
            queueJob(job)
          }),
  })

  const handle: AetherNodeHandle<T> = {
    id,
    kind: options.kind ?? 'agent',
    effect,
    run: () => effect.run(),
    stop: () => effect.stop(),
  }

  if (options.immediate !== false) effect.run()
  return handle
}
