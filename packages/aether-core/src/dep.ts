/**
 * Dep — a reactive subscription slot.
 *
 * Every reactive cell — a `ref`'s value, a single key of a `reactive` object,
 * or a `computed` itself — owns exactly one `Dep`. Effects that read the cell
 * while running are recorded in `subscribers`; when the cell changes, the
 * engine notifies them.
 *
 * This is the Vue 3 minimal reactivity model, ported one-to-one to a
 * dependency-free TypeScript/ESM runtime for the server.
 */
import type { ReactiveEffect } from './effect.js'

export class Dep {
  /** Effects (watchers, computed, agent nodes) that currently depend on this cell. */
  readonly subscribers = new Set<ReactiveEffect>()

  /**
   * Optional id of this cell inside the Aether dependency graph.
   * When set, the graph records an edge from the currently running
   * graph-tracked node to this cell, so Aether can answer
   * "who depends on whom" — for traces, dirty-marking and re-evaluation.
   */
  readonly nodeId?: string

  constructor(nodeId?: string) {
    this.nodeId = nodeId
  }
}
