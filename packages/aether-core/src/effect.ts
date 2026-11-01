/**
 * ReactiveEffect — the unit of reactive computation.
 *
 * A watcher, a computed getter, or a whole agent node is "an effect": a
 * function whose reactive reads (`ref.value`, `reactive` keys, `computed`)
 * are tracked while it runs, so the engine knows exactly what to re-run when
 * a dependency changes.
 *
 * Lifecycle:
 *   new ReactiveEffect(fn)   — nothing runs yet
 *   effect.run()             — collect dependencies, execute, cache deps
 *   (a dependency changes)   — trigger() calls effect directly or via scheduler
 *   effect.stop()            — unsubscribe everywhere, cleanups run
 */
import { Dep } from './dep.js'
import { getActiveGraph } from './graph-channel.js'
import type { EffectScope } from './scope.js'
import { isPromiseLike } from './utils.js'

let activeEffect: ReactiveEffect | undefined
let shouldTrack = true

/** batching state — see batch() below */
let batchLevel = 0
const pendingEffects = new Set<ReactiveEffect>()

export interface ReactiveEffectOptions<T = any> {
  /**
   * Custom scheduling for this effect. When set, `trigger` will *not* run the
   * effect directly — it calls `scheduler(job)` and the scheduler decides when
   * `job()` (i.e. `effect.run()`) happens. This is how `computed` marks itself
   * dirty lazily and how `watch`/`defineNode` defer work to the microtask queue.
   */
  scheduler?: (job: () => void) => void
  /** Called when the effect body throws (the error is still re-thrown). */
  onError?: (error: unknown) => void
  /** Debug hook fired every time this effect reads a reactive cell. */
  onTrack?: (dep: Dep) => void
  /** Debug hook fired every time a reactive cell notifies this effect. */
  onTrigger?: (dep: Dep) => void
  /** Allow the effect to re-trigger itself while running (default false). */
  allowRecurse?: boolean
}

export class ReactiveEffect<T = any> {
  active = true
  readonly deps = new Set<Dep>()
  readonly cleanups = new Set<() => void>()
  parent: ReactiveEffect | undefined
  readonly allowRecurse: boolean
  readonly options: ReactiveEffectOptions<T>

  constructor(public fn: () => T, options: ReactiveEffectOptions<T> = {}) {
    this.options = options
    this.allowRecurse = options.allowRecurse === true
    // auto-attach to the enclosing effect scope, if any
    const scope = getActiveScope()
    if (scope) scope.effects.push(this)
  }

  /**
   * Execute the effect body, re-collecting its dependencies from scratch.
   *_previous dependencies are released first, so conditional reads
   * (if/else branches) never leave stale subscriptions behind.
   */
  run(): T {
    if (!this.active) {
      return this.fn()
    }
    const prevEffect = activeEffect
    const prevShouldTrack = shouldTrack
    activeEffect = this
    shouldTrack = true
    cleanupEffect(this)
    runEffectCleanups(this)
    try {
      return this.fn()
    } catch (error) {
      if (this.options.onError) this.options.onError(error)
      throw error
    } finally {
      activeEffect = prevEffect
      shouldTrack = prevShouldTrack
    }
  }

  /** Unsubscribe from all dependencies, run cleanups, deactivate. */
  stop(): void {
    if (this.active) {
      cleanupEffect(this)
      runEffectCleanups(this)
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect): void {
  const { deps } = effect
  if (deps.size === 0) return
  for (const dep of deps) dep.subscribers.delete(effect)
  deps.clear()
}

function runEffectCleanups(effect: ReactiveEffect): void {
  if (effect.cleanups.size === 0) return
  const fns = [...effect.cleanups]
  effect.cleanups.clear()
  for (const fn of fns) {
    try {
      fn()
    } catch (error) {
      console.error('[aether] cleanup function threw:', error)
    }
  }
}

/**
 * Subscribe the currently running effect to `dep`.
 * Called by every reactive getter (ref.value, reactive key, computed).
 */
export function track(dep: Dep): void {
  if (!shouldTrack || !activeEffect) return
  if (!dep.subscribers.has(activeEffect)) {
    dep.subscribers.add(activeEffect)
    activeEffect.deps.add(dep)
    activeEffect.options.onTrack?.(dep)
  }
  // feed the dependency graph: "the node currently running read this cell"
  if (dep.nodeId) getActiveGraph()?.noteDep(dep.nodeId)
}

/**
 * Notify every effect subscribed to `dep` that the cell changed.
 * Effects with a scheduler are scheduled; others run synchronously.
 * Inside `batch()` everything is deferred to the end of the batch (deduped).
 */
export function trigger(dep: Dep): void {
  // feed the dependency graph FIRST: even with zero subscribers a state cell
  // must be marked dirty so `AetherGraph` stays a truthful model of staleness
  if (dep.nodeId) getActiveGraph()?.markDirty(dep.nodeId)
  if (dep.subscribers.size === 0) return
  const effects = [...dep.subscribers]
  for (const effect of effects) {
    if (effect === activeEffect && !effect.allowRecurse) continue
    effect.options.onTrigger?.(dep)
    if (batchLevel > 0) {
      pendingEffects.add(effect)
    } else {
      runEffectNow(effect)
    }
  }
}

function runEffectNow(effect: ReactiveEffect): void {
  if (effect.options.scheduler) {
    effect.options.scheduler(() => effect.run())
  } else {
    effect.run()
  }
}

/**
 * Group several mutations into one reactive tick: effects that would be
 * triggered synchronously in between are deduped and run once at the end.
 * (Queue-scheduled effects dedupe via queueJob regardless.)
 */
export function batch<T>(fn: () => T): T {
  batchLevel++
  try {
    return fn()
  } finally {
    batchLevel--
    if (batchLevel === 0) {
      const effects = [...pendingEffects]
      pendingEffects.clear()
      for (const effect of effects) runEffectNow(effect)
    }
  }
}

/** Temporarily disable dependency collection (for non-reactive reads). */
export function pauseTracking(): void {
  shouldTrack = false
}

export function resumeTracking(): void {
  shouldTrack = true
}

export function isTracking(): boolean {
  return shouldTrack && activeEffect !== undefined
}

/**
 * Create and *immediately run* a reactive effect. Returns the effect instance
 * (call `.stop()` to detach it from its dependencies).
 *
 * @example
 *   const data = effect(() => { total.value = a.value + b.value })
 *   // ...later
 *   data.stop()
 */
export function effect<T>(fn: () => T, options: ReactiveEffectOptions<T> = {}): ReactiveEffect<T> {
  const e = new ReactiveEffect<T>(fn, options)
  e.run()
  return e
}

/** Register a cleanup function for the currently running effect. */
export function onEffectCleanup(fn: () => void): void {
  if (activeEffect) activeEffect.cleanups.add(fn)
}

/** The effect currently executing (undefined outside of one). */
export function getActiveEffect(): ReactiveEffect | undefined {
  return activeEffect
}

export function isPromiseLikeResult(value: unknown): boolean {
  return isPromiseLike(value)
}

// ---- effect scope state (lives here to keep scope.ts cycle-free) ----------

let activeScope: EffectScope | undefined

export function getActiveScope(): EffectScope | undefined {
  return activeScope
}

export function setActiveScope(scope: EffectScope | undefined): void {
  activeScope = scope
}
