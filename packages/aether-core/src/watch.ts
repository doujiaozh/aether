/**
 * watch / watchEffect — the imperative window into the reactive world.
 *
 * `watch(source, cb)` re-invokes `cb` whenever `source` (a ref, a computed, a
 * getter, a reactive object, or an array of those) produces a new value.
 * `watchEffect(fn)` re-runs `fn` whenever anything it read changes.
 *
 * By default both are scheduled on the microtask queue (flush: 'async'), which
 * collapses bursts of mutations into single runs; use flush: 'sync' for
 * immediate callback invocation.
 */
import { ReactiveEffect } from './effect.js'
import { queueJob } from './scheduler.js'
import { isRef } from './ref.js'
import { isReactive } from './reactive.js'
import { hasChanged, isArray, isFunction, isObject } from './utils.js'
import type { ComputedRef } from './computed.js'
import type { Ref } from './ref.js'

export type WatchSource<T> = ComputedRef<T> | Ref<T> | (() => T) | object

export type CleanupRegister = (fn: () => void) => void

export type WatchCallback<Value, OldValue> = (
  value: Value,
  oldValue: OldValue,
  onCleanup: CleanupRegister,
) => unknown

export interface WatchOptions {
  /** invoke the callback immediately with the initial value */
  immediate?: boolean
  /** also fire when nested members of a reactive source change */
  deep?: boolean
  /** 'async' (default) defers via the microtask queue, 'sync' runs inline */
  flush?: 'async' | 'sync'
  /** stop watching after the callback ran once */
  once?: boolean
  /** error handler for the callback body */
  onError?: (error: unknown) => void
}

export interface WatchEffectOptions {
  flush?: 'async' | 'sync'
  onError?: (error: unknown) => void
}

function toGetter<T extends object>(source: WatchSource<T>): () => T {
  if (isRef(source)) return () => source.value
  if (isFunction(source)) return source as () => T
  // reactive object: return the proxy itself (deep watch unwraps below)
  return () => source as T
}

/**
 * Walk a value, touching every nested reactive cell so that `deep` watchers
 * subscribe to all of them. Cycles and repeated references are safe (`seen`).
 */
export function traverse(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (!isObject(value) || seen.has(value)) return value
  seen.add(value)
  if (isRef(value)) {
    traverse((value as Ref).value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) traverse(value[i], seen)
  } else {
    for (const key of Object.keys(value)) {
      traverse((value as Record<string, unknown>)[key], seen)
    }
  }
  return value
}

export function watch<T extends WatchSource<any>>(
  source: T | T[],
  callback: WatchCallback<
    T extends Ref<infer V> ? V : T extends ComputedRef<infer V> ? V : T extends () => infer V ? V : T,
    T extends Ref<infer V> ? V : T extends ComputedRef<infer V> ? V : T extends () => infer V ? V : T
  >,
  options: WatchOptions = {},
): () => void {
  const sources = isArray(source) ? source : [source]
  const getters = sources.map((s) => toGetter(s))
  // deep by default when the source is a (reactive) object, like Vue
  const deepDefault = sources.some((s) => isObject(s) && !isRef(s) && !isFunction(s))
  const deep = options.deep === true || (options.deep !== false && deepDefault)

  let cleanups: Array<() => void> = []
  const registerCleanup: CleanupRegister = (fn) => {
    cleanups.push(fn)
  }
  const runCleanups = (): void => {
    const fns = cleanups
    cleanups = []
    for (const fn of fns) {
      try {
        fn()
      } catch (error) {
        console.error('[aether] watch cleanup threw:', error)
      }
    }
  }

  let oldValue: any

  const job = (): void => {
    if (!effect.active) return
    runCleanups()
    const newValue = effect.run()
    const previousValue = oldValue
    const changed = options.immediate || deep || hasChanged(newValue, oldValue)
    if (changed) {
      try {
        callback(newValue, previousValue, registerCleanup)
      } catch (error) {
        if (options.onError) options.onError(error)
        else console.error('[aether] watch callback threw:', error)
      } finally {
        if (options.once === true) unwatch()
      }
    }
    oldValue = newValue
  }

  const effect = new ReactiveEffect(
    () => {
      const values = getters.map((g) => g())
      const value = values.length === 1 ? values[0] : values
      return deep ? (traverse(value) as any) : value
    },
    // flush 'sync' runs the whole job (getter + callback) on the trigger call
    { scheduler: options.flush === 'sync' ? () => job() : () => queueJob(job) },
  )

  const unwatch = (): void => {
    runCleanups()
    effect.stop()
  }

  if (options.immediate) {
    job()
  } else {
    oldValue = effect.run()
  }
  return unwatch
}

/**
 * Run `effect` immediately, then re-run it whenever any reactive cell it read
 * changes. Use the `onCleanup` argument to release the previous run's
 * resources (timers, AbortControllers, sockets...).
 */
export function watchEffect(
  effect: (onCleanup: CleanupRegister) => void | Promise<void>,
  options: WatchEffectOptions = {},
): () => void {
  let cleanups: Array<() => void> = []
  const registerCleanup: CleanupRegister = (fn) => {
    cleanups.push(fn)
  }
  const runCleanups = (): void => {
    const fns = cleanups
    cleanups = []
    for (const fn of fns) {
      try {
        fn()
      } catch (error) {
        console.error('[aether] watchEffect cleanup threw:', error)
      }
    }
  }

  const e = new ReactiveEffect(
    () => {
      runCleanups()
      return effect(registerCleanup)
    },
    { scheduler: options.flush === 'sync' ? () => job() : () => queueJob(job) },
  )
  const job = (): void => {
    if (!e.active) return
    e.run()
  }

  const stop = (): void => {
    runCleanups()
    e.stop()
  }

  e.run()
  return stop
}
