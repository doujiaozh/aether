/**
 * The reactive glue: turn an LLM call into a *node of the dependency graph*.
 *
 * `llmNode(client, 'architect', () => [...prompt built from refs...])`
 *
 * The prompt builder is a reactive getter — it must read its source refs
 * synchronously (Aether's golden rule for async nodes: read before the first
 * await). Whenever a source ref changes, the graph marks the node dirty and
 * the scheduler re-runs it, updating `output`.
 *
 * Failure policy: transient errors (429 / 5xx) are already retried inside the
 * client; a throw after that leaves the previous `output` untouched and the
 * node re-runs on the next dependency change — the graph self-heals instead
 * of wedging the pipeline.
 */

import { defineNode, ref, type AetherNodeHandle, type Ref } from 'aether-core'
import { LLMClient, type ChatResult } from './client.js'
import type { ChatMessage, LLMRequestOptions } from './types.js'

export interface LLMNodeOptions extends LLMRequestOptions {
  /** node kind in the graph, defaults to 'llm' */
  kind?: 'llm' | 'agent'
  /** re-run immediately on creation (default true, matching defineNode) */
  immediate?: boolean
  onError?: (error: unknown, node: AetherNodeHandle) => void
}

export interface LLMNode {
  /** live result of the latest successful run */
  output: Ref<string>
  /** raw ChatResult (usage, routed model...) of the latest run */
  result: Ref<ChatResult | null>
  /** the underlying graph node handle */
  node: AetherNodeHandle
}

export function llmNode(
  client: LLMClient,
  id: string,
  buildPrompt: () => ChatMessage[],
  options: LLMNodeOptions = {},
): LLMNode {
  const output = ref('', { name: `${id}.output` })
  const result = ref<ChatResult | null>(null, { name: `${id}.result` })
  let node: AetherNodeHandle

  node = defineNode(
    id,
    async () => {
      // synchronous dependency collection happens inside buildPrompt()
      const messages = buildPrompt()
      const res = await client.chat(messages, options)
      output.value = res.content
      result.value = res
    },
    {
      kind: options.kind ?? 'llm',
      immediate: options.immediate,
      onError: options.onError
        ? (error: unknown) => options.onError!(error, node)
        : undefined,
    },
  )

  return { output, result, node }
}
