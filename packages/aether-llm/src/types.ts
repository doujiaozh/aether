/** Shared types for the Aether LLM layer. */

import type { TraceSink } from 'aether-core'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallRequest {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  name?: string
  tool_calls?: ToolCallRequest[]
  tool_call_id?: string
}

export interface ChatCompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: string | null
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: TokenUsage
}

export interface ChatCompletionChunkDelta {
  role?: ChatRole
  content?: string | null
}

export interface ChatCompletionChunkChoice {
  index: number
  delta: ChatCompletionChunkDelta
  finish_reason: string | null
}

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
}

/**
 * Complexity hint consumed by the model router.
 * - trivial   → greetings, one-line answers      → fast model
 * - standard  → default Q&A, extraction          → fast model
 * - complex   → architecture, refactoring, reasoning → strong model
 */
export type TaskComplexity = 'trivial' | 'standard' | 'complex'

export interface ModelInfo {
  id: string
  tier: 'fast' | 'strong'
  /** soft cap this client enforces through the rate limiter (requests/min) */
  rpm?: number
}

/** Options accepted by `client.chat()` / `client.stream()`. */
export interface LLMRequestOptions {
  /** pin a model id; bypasses the router when set */
  model?: string
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  /** hint for the router (ignored when `model` is pinned) */
  complexity?: TaskComplexity
  /** override the client-level retry count for this call */
  maxRetries?: number
  /** per-call trace sink */
  tracer?: TraceSink
}
