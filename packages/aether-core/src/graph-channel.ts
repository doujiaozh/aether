/**
 * @internal
 * graph-channel keeps `effect.ts` and `graph.ts` cycle-free.
 *
 * `effect.ts` must notify the graph whenever a dependency is tracked, but the
 * graph itself depends on `ReactiveEffect`. This module holds only the pointer
 * to the active graph, so both sides import it without a runtime cycle.
 */
import type { AetherGraph } from './graph.js'

let current: AetherGraph | undefined

export function setActiveGraph(graph: AetherGraph | undefined): void {
  current = graph
}

export function getActiveGraph(): AetherGraph | undefined {
  return current
}
