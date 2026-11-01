/**
 * InkStone (Intern's OpenAI-compatible gateway) presets.
 *
 * InkStone speaks the OpenAI chat-completions protocol, so it is just a
 * `createLLM()` with the right base URL, a generous default RPM of 50 and the
 * Atria-Dawn / deepseek-v4.1 fleet wired into the router.
 *
 * Set `AETHER_INKSTONE_API_KEY` (or pass `apiKey`) to authenticate.
 */

import { LLMClient, type LLMClientOptions } from './client.js'
import { ModelRouter } from './router.js'
import { RateLimiter } from './rate-limiter.js'

export const INKSTONE_BASE_URL = 'https://api.inkstone.ilight.io/v1'

/** The demo fleet: fast tier = Atria-Dawn (free), strong tier = deepseek-v4.1. */
export const INKSTONE_FLEET = {
  fast: 'atriadawn',
  strong: 'deepseek-v4.1',
} as const

export interface InkStoneOptions extends Partial<Omit<LLMClientOptions, 'baseURL' | 'router'>> {
  /** override the base URL for self-hosted / proxy deployments */
  baseURL?: string
  /** API key; defaults to the AETHER_INKSTONE_API_KEY env var */
  apiKey?: string
  /** requests per minute (InkStone shared tier default: 50) */
  rpm?: number
}

export function createInkStoneClient(options: InkStoneOptions = {}): LLMClient {
  const apiKey = options.apiKey ?? process.env.AETHER_INKSTONE_API_KEY
  return new LLMClient({
    baseURL: options.baseURL ?? INKSTONE_BASE_URL,
    apiKey,
    rpm: options.rpm ?? 50,
    defaultModel: undefined,
    router: new ModelRouter({
      fast: INKSTONE_FLEET.fast,
      strong: INKSTONE_FLEET.strong,
    }),
    ...options,
  })
}

/**
 * OpenAI preset — the same client against the canonical OpenAI endpoint.
 * Uses OPENAI_API_KEY by default.
 */
export function createOpenAIClient(options: InkStoneOptions = {}): LLMClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  return new LLMClient({
    baseURL: options.baseURL ?? 'https://api.openai.com/v1',
    apiKey,
    rpm: options.rpm ?? 50,
    ...options,
  })
}

/** A client pinned to whatever `AETHER_LLM_BASE_URL` says (operator override). */
export function createEnvClient(options: InkStoneOptions = {}): LLMClient {
  const baseURL = process.env.AETHER_LLM_BASE_URL
  if (!baseURL) return createInkStoneClient(options)
  return new LLMClient({ baseURL, rpm: 50, ...options })
}

export { LLMClient, ModelRouter, RateLimiter }
