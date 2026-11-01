/**
 * @internal
 * Tiny runtime helpers shared across the reactivity implementation.
 * No external dependencies — Aether core must remain pure TypeScript/ESM.
 */

export const isObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object'

export const isFunction = (value: unknown): value is Function =>
  typeof value === 'function'

export const isArray = Array.isArray

export function hasChanged(value: unknown, oldValue: unknown): boolean {
  return !Object.is(value, oldValue)
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && isFunction((value as PromiseLike<unknown>).then)
}

/**
 * Well-known symbols are never treated as reactive keys —
 * intercepting `Symbol.iterator` etc. would break native iteration.
 */
export const builtInSymbols = new Set<symbol>([
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.species,
  Symbol.split,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
])

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[aether] ${message}`)
}
