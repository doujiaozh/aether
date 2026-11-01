/**
 * ref — the atomic reactive cell.
 *
 * `ref(value)` wraps any value; `.value` reads are tracked, `.value` writes
 * notify. Every ref is automatically registered in the Aether dependency
 * graph under its name (auto-generated like `ref#1` if not provided), so a
 * change marks every downstream prompt / agent node dirty.
 */
import { Dep } from './dep.js'
import { track, trigger } from './effect.js'
import { getActiveGraph } from './graph-channel.js'
import { reactive, toRaw } from './reactive.js'
import { hasChanged, isObject } from './utils.js'
import type { AetherNodeKind } from './graph.js'

export interface Ref<T = any> {
  readonly __v_isRef: true
  /** Stable id of this cell inside the dependency graph. */
  readonly name: string
  value: T
}

export interface RefOptions {
  /** Human readable graph id, e.g. `repoUrl`. Defaults to `ref#<n>`. */
  name?: string
  /** Graph node kind, defaults to `state`. */
  kind?: AetherNodeKind
  /** Optional label shown in graph exports / traces. */
  label?: string
  /** Do not deep-reactive-wrap object values. */
  shallow?: boolean
}

export type ShallowRef<T> = Ref<T>

let refSeq = 0

export class RefImpl<T> implements Ref<T> {
  readonly __v_isRef = true as const
  readonly name: string
  readonly dep: Dep
  private _rawValue: T
  private _value: T
  readonly shallow: boolean

  constructor(value: T, options: RefOptions = {}) {
    this.shallow = options.shallow === true
    this.name = options.name ?? `ref#${++refSeq}`
    this.dep = new Dep(this.name)
    this._rawValue = this.shallow ? value : toRaw(value)
    this._value = this.shallow ? value : toReactive(value)
    registerInGraph(this.name, options)
  }

  get value(): T {
    track(this.dep)
    return this._value
  }

  set value(newValue: T) {
    const nextRaw = this.shallow ? newValue : toRaw(newValue)
    if (hasChanged(nextRaw, this._rawValue)) {
      this._rawValue = nextRaw
      this._value = this.shallow ? newValue : toReactive(newValue)
      trigger(this.dep)
    }
  }
}

function registerInGraph(name: string, options: RefOptions): void {
  const graph = getActiveGraph()
  if (graph) graph.register(name, options.kind ?? 'state', options.label)
}

/**
 * Create a reactive reference.
 *
 * @example
 *   const repoUrl = ref('https://github.com/sindresorhus/is-odd', { name: 'repoUrl' })
 *   repoUrl.value = 'https://github.com/expressjs/express'  // downstream nodes re-run
 */
export function ref<T>(value: T, options?: RefOptions): Ref<T> {
  return new RefImpl<T>(value, options)
}

/** A ref whose object value stays a raw object (no deep Proxy). */
export function shallowRef<T>(value: T, options?: Omit<RefOptions, 'shallow'>): ShallowRef<T> {
  return new RefImpl<T>(value, { ...options, shallow: true })
}

export function isRef(value: unknown): value is Ref {
  return !!(value && (value as Ref).__v_isRef === true)
}

export function unref<T>(value: T | Ref<T>): T {
  return isRef(value) ? (value as unknown as Ref<T>).value : (value as T)
}

/** Resolve refs, getter functions and plain values to a plain value. */
export function toValue<T>(source: T | Ref<T> | (() => T)): T {
  if (isRef(source)) return source.value
  if (typeof source === 'function') return (source as () => T)()
  return source
}

/** Force subscribers to re-run even if the value did not change. */
export function triggerRef(ref: Ref): void {
  const impl = ref as unknown as RefImpl<unknown>
  trigger(impl.dep)
  getActiveGraph()?.markDirty(impl.name)
}

/** Wrap an object value with a reactive Proxy; pass through non-objects. */
export function toReactive<T>(value: T): T {
  return isObject(value) ? (reactive(value as object) as unknown as T) : value
}
