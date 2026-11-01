/**
 * Aether Core — a dependency-free reactive engine for AI agent orchestration.
 *
 * Everything an agent works with — State, Context, Tool Results, Prompts —
 * is a reactive node in a dependency graph. Change a state, and everything
 * downstream is marked dirty and re-evaluates at the next step.
 *
 * @example
 *   import { ref, computed, defineNode } from 'aether-core'
 *
 *   const repoUrl = ref('https://github.com/sindresorhus/is-odd', { name: 'repoUrl' })
 *   const structure = computed(() => analyze(repoUrl.value), { name: 'structure', kind: 'tool' })
 *
 *   defineNode('agent.summarize', () => {
 *     console.log('re-evaluating with', structure.value)
 *   })
 *
 *   repoUrl.value = 'https://github.com/expressjs/express' // chain re-runs
 */
export * from './ref.js'
export * from './reactive.js'
export * from './computed.js'
export * from './effect.js'
export * from './scope.js'
export * from './watch.js'
export * from './scheduler.js'
export * from './graph.js'
export * from './trace.js'
export { getActiveGraph, setActiveGraph } from './graph-channel.js'

export const version: string = '0.1.0'
