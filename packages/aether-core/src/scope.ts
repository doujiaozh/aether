/**
 * EffectScope — a lifetime boundary for effects.
 *
 * Agent steps, watchers and subscriptions created inside `scope.run(fn)` are
 * remembered; `scope.stop()` tears them all down at once. The natural unit of
 * "one agent run" or "one reactive session" in Aether.
 */
import { getActiveScope, setActiveScope } from './effect.js'
import type { ReactiveEffect } from './effect.js'

export class EffectScope {
  readonly effects: ReactiveEffect[] = []
  readonly cleanups: Array<() => void> = []
  readonly children: EffectScope[] = []
  private _active = true
  private readonly parent: EffectScope | undefined

  get active(): boolean {
    return this._active
  }

  constructor(detached = false) {
    if (!detached) {
      this.parent = getActiveScope()
      this.parent?.children.push(this)
    }
  }

  /** Run `fn` with this scope active — effects created inside register here. */
  run<T>(fn: () => T): T | undefined {
    if (!this._active) return undefined
    const prev = getActiveScope()
    setActiveScope(this)
    try {
      return fn()
    } finally {
      setActiveScope(prev)
    }
  }

  /** Stop every effect in this scope (and its children), run disposables. */
  stop(): void {
    if (!this._active) return
    this._active = false
    for (const child of this.children) child.stop()
    for (const effect of this.effects) effect.stop()
    const cleanups = this.cleanups.splice(0)
    for (const fn of cleanups) {
      try {
        fn()
      } catch (error) {
        console.error('[aether] scope cleanup threw:', error)
      }
    }
    if (this.parent) {
      const index = this.parent.children.indexOf(this)
      if (index >= 0) this.parent.children.splice(index, 1)
    }
  }
}

/** Register a disposal callback on the currently active scope. */
export function onScopeDispose(fn: () => void): void {
  const scope = getActiveScope()
  if (scope) scope.cleanups.push(fn)
  else console.warn('[aether] onScopeDispose called without an active scope')
}
