/**
 * reactive — deep reactive Proxy for plain objects (and arrays).
 *
 * Reading any key inside a proxy is tracked; writing any key notifies
 * subscribers. Nested objects become proxies lazily on first read.
 *
 * Unlike `ref`, a `reactive` object is *the* object — no `.value` indirection.
 * Pass `{ name: 'ctx' }` to make the object (and each of its keys) visible in
 * the Aether dependency graph as `<name>.<key>` cells.
 */
import { Dep } from './dep.js'
import { track, trigger } from './effect.js'
import { getActiveGraph } from './graph-channel.js'
import { isRef } from './ref.js'
import type { Ref } from './ref.js'
import { builtInSymbols, hasChanged, isObject } from './utils.js'
import type { AetherNodeKind } from './graph.js'

export const enum ReactiveFlags {
  IS_REACTIVE = '__v_isReactive',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw',
  SKIP = '__v_skip',
}

export interface ReactiveOptions {
  /** Graph id for this object; each key becomes cell `<name>.<key>`. */
  name?: string
  /** Graph node kind, defaults to `context`. */
  kind?: AetherNodeKind
  label?: string
}

const reactiveMap = new WeakMap<object, object>()
const shallowMap = new WeakMap<object, object>()
const targetNameMap = new WeakMap<object, string>()
const targetDepMap = new WeakMap<object, Map<PropertyKey, Dep>>()

const ITERATE_KEY = Symbol('aether-iterate')

export function reactive<T extends object>(target: T, options: ReactiveOptions = {}): T {
  return createReactiveObject(target, false, reactiveMap, options)
}

export function shallowReactive<T extends object>(target: T, options: ReactiveOptions = {}): T {
  return createReactiveObject(target, true, shallowMap, options)
}

function createReactiveObject<T extends object>(
  target: T,
  shallow: boolean,
  proxyMap: WeakMap<object, object>,
  options: ReactiveOptions,
): T {
  if (!isObject(target)) return target
  // an already-proxied target is returned as-is (same shallowness or not,
  // we never double-wrap)
  if ((target as any)[ReactiveFlags.IS_REACTIVE] || (target as any)[ReactiveFlags.IS_SHALLOW]) {
    return target
  }
  // explicitly marked raw / skipped
  if ((target as any)[ReactiveFlags.SKIP]) return target
  const existing = proxyMap.get(target)
  if (existing) return existing as T

  if (options.name !== undefined) {
    targetNameMap.set(target, options.name)
    getActiveGraph()?.register(options.name, options.kind ?? 'context', options.label)
  }

  const proxy = new Proxy(target, makeHandlers(shallow))
  proxyMap.set(target, proxy)
  return proxy as T
}

function makeHandlers(shallow: boolean): ProxyHandler<object> {
  const get = (target: object, key: PropertyKey, receiver: unknown): unknown => {
    if (key === ReactiveFlags.IS_REACTIVE) return !shallow
    if (key === ReactiveFlags.IS_SHALLOW) return shallow
    if (key === ReactiveFlags.RAW) return target

    const res = Reflect.get(target, key, receiver)
    if (typeof key === 'symbol' && builtInSymbols.has(key)) return res

    // refs are unwrapped when read from a reactive object (Vue semantics)
    if (isRef(res)) return res.value

    track(getDep(target, key))

    if (isObject(res)) {
      return shallow ? res : reactive(res as object, { name: childName(target, key) })
    }
    return res
  }

  const set = (
    target: object,
    key: PropertyKey,
    value: unknown,
    receiver: unknown,
  ): boolean => {
    const oldValue = Reflect.get(target, key, receiver)
    if (!shallow) {
      // assigning to a ref-wrapped key writes through the ref
      if (isRef(oldValue) && !isRef(value)) {
        ;(oldValue as Ref).value = value
        return true
      }
    }
    const hadKey = Object.prototype.hasOwnProperty.call(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // ignore writes that bubble up a prototype chain
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(getDep(target, key))
        trigger(getDep(target, ITERATE_KEY))
      } else if (hasChanged(value, oldValue)) {
        trigger(getDep(target, key))
      }
    }
    return result
  }

  const deleteProperty = (target: object, key: PropertyKey): boolean => {
    const hadKey = Object.prototype.hasOwnProperty.call(target, key)
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(getDep(target, key))
      trigger(getDep(target, ITERATE_KEY))
    }
    return result
  }

  const has = (target: object, key: PropertyKey): boolean => {
    const result = Reflect.has(target, key)
    if (typeof key !== 'symbol' || !builtInSymbols.has(key)) {
      track(getDep(target, key))
    }
    return result
  }

  const ownKeys = (target: object): ArrayLike<string | symbol> => {
    track(getDep(target, ITERATE_KEY))
    return Reflect.ownKeys(target) as ArrayLike<string | symbol>
  }

  return { get, set, deleteProperty, has, ownKeys }
}

function childName(target: object, key: PropertyKey): string | undefined {
  const name = targetNameMap.get(target)
  return name ? `${name}.${String(key)}` : undefined
}

function getDep(target: object, key: PropertyKey): Dep {
  let map = targetDepMap.get(target)
  if (!map) {
    map = new Map()
    targetDepMap.set(target, map)
  }
  let dep = map.get(key)
  if (!dep) {
    const name = targetNameMap.get(target)
    const nodeId =
      key === ITERATE_KEY
        ? name !== undefined
          ? `${name}.<iterate>`
          : undefined
        : name !== undefined
          ? `${name}.${String(key)}`
          : undefined
    dep = new Dep(nodeId)
    map.set(key, dep)
    if (nodeId !== undefined) {
      // each reactive key is a first-class node in the Aether graph
      getActiveGraph()?.register(nodeId, 'state')
    }
  }
  return dep
}

export function isReactive(value: unknown): boolean {
  return !!(value && (value as any)[ReactiveFlags.IS_REACTIVE])
}

export function isShallow(value: unknown): boolean {
  return !!(value && (value as any)[ReactiveFlags.IS_SHALLOW])
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isShallow(value)
}

/** Unwrap a reactive Proxy back to the raw object (recursively). */
export function toRaw<T>(observed: T): T {
  const raw = observed && (observed as any)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

/** Mark an object as permanently non-reactive (never proxied). */
export function markRaw<T extends object>(value: T): T {
  Object.defineProperty(value, ReactiveFlags.SKIP, {
    configurable: true,
    enumerable: false,
    value: true,
  })
  return value
}
