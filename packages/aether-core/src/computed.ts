/**
 * computed — a lazy, cached, self-invalidating reactive derivation.
 *
 * A computed reads other reactive cells and remembers the result. When a
 * source cell changes, the computed does **not** recompute immediately: it is
 * only *marked dirty*, and recomputes on the next `.value` read. Combined with
 * the dependency graph this is exactly the Aether contract:
 *
 *   "a state changes → everything depending on it is marked dirty
 *    and is re-evaluated at the next step"
 */
import { Dep } from './dep.js'
import { ReactiveEffect, track, trigger } from './effect.js'
import { getActiveGraph } from './graph-channel.js'
import type { AetherNodeKind } from './graph.js'

export interface ComputedRef<T = any> {
  readonly __v_isRef: true
  readonly name: string
  readonly value: T
}

export interface ComputedOptions {
  /** Human readable graph id, e.g. `prompt`. Defaults to `computed#<n>`. */
  name?: string
  /** Graph node kind, defaults to `derived`. Use `llm` for prompt builders. */
  kind?: AetherNodeKind
  label?: string
  /** Called when the getter throws (the error is still re-thrown). */
  onError?: (error: unknown) => void
}

export interface WritableComputedOptions<T> extends ComputedOptions {
  get: () => T
  set: (value: T) => void
}

let computedSeq = 0

export class ComputedRefImpl<T> implements ComputedRef<T> {
  readonly __v_isRef = true as const
  readonly name: string
  readonly dep: Dep
  private _value: T | undefined = undefined
  private _dirty = true
  private readonly effect: ReactiveEffect<T>

  constructor(
    private readonly getter: () => T,
    private readonly setter: ((value: T) => void) | undefined,
    options: ComputedOptions = {},
  ) {
    this.name = options.name ?? `computed#${++computedSeq}`
    this.dep = new Dep(this.name)
    getActiveGraph()?.register(this.name, options.kind ?? 'derived', options.label)
    this.effect = new ReactiveEffect<T>(getter, {
      scheduler: () => {
        // lazy invalidation: do not recompute now, just mark dirty and
        // notify direct subscribers (watchers / nodes reading this computed)
        if (!this._dirty) {
          this._dirty = true
          trigger(this.dep)
        }
      },
      onError: options.onError,
    })
  }

  get value(): T {
    track(this.dep)
    if (this._dirty) {
      const graph = getActiveGraph()
      const run = () => this.effect.run()
      this._value = graph ? graph.runTracked(this.name, run) : run()
      this._dirty = false
    }
    return this._value as T
  }

  set value(newValue: T) {
    if (this.setter) {
      this.setter(newValue)
    } else {
      console.warn(`[aether] computed "${this.name}" is read-only`)
    }
  }
}

export function computed<T>(getter: () => T, options?: ComputedOptions): ComputedRef<T>
export function computed<T>(options: WritableComputedOptions<T>): ComputedRef<T>
export function computed<T>(
  getterOrOptions: (() => T) | WritableComputedOptions<T>,
  maybeOptions?: ComputedOptions,
): ComputedRef<T> {
  let getter: () => T
  let setter: ((value: T) => void) | undefined
  let options: ComputedOptions = {}
  if (typeof getterOrOptions === 'function') {
    getter = getterOrOptions
    setter = undefined
    options = maybeOptions ?? {}
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
    options = getterOrOptions
  }
  return new ComputedRefImpl<T>(getter, setter, options)
}
