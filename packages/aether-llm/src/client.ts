/**
 * OpenAI-compatible chat client with:
 *   - sliding-window RPM pacing (acquire before every wire call)
 *   - 429 / 5xx exponential backoff with `Retry-After` honoured
 *   - AbortController timeout per request
 *   - optional SSE streaming (`stream()`)
 *
 * Zero dependencies — Node's global `fetch`, `AbortSignal`, `TextDecoder` and
 * web `ReadableStream` are all that is needed. `fetch` is injectable so tests
 * never touch the network.
 */

import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js'
import {
  RetryExhaustedError,
  defaultShouldRetry,
  withRetry,
  type RetryOptions,
} from './retry.js'
import { ModelRouter, type ModelRouterOptions } from './router.js'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  LLMRequestOptions,
} from './types.js'
import type { TraceEntry, TraceSink } from 'aether-core'

export class LLMHttpError extends Error {
  status: number
  retryable: boolean
  retryAfterMs?: number
  body?: string
  constructor(status: number, body: string | undefined) {
    super(`LLM endpoint returned HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'LLMHttpError'
    this.status = status
    this.retryable = status === 429 || (status >= 500 && status <= 599)
    const match = body?.match(/"retry_after"\s*:\s*(\d+)/)
    this.retryAfterMs = match ? Number(match[1]) * 1000 : undefined
  }
}

export class LLMTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`)
    this.name = 'LLMTimeoutError'
  }
}

export interface LLMClientOptions {
  /** base URL of an OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  baseURL: string
  apiKey?: string
  /** requests per minute cap (default 50) */
  rpm?: number
  /** per-request timeout (default 120s) */
  timeoutMs?: number
  /** default model used when neither the router nor the caller picks one */
  defaultModel?: string
  fetch?: typeof fetch
  limiter?: RateLimiter
  limiterOptions?: RateLimiterOptions
  router?: ModelRouter
  routerOptions?: ModelRouterOptions
  retryOptions?: RetryOptions
  extraHeaders?: Record<string, string>
  /** global trace sink, sees every LLM call as one 'llm' entry */
  tracer?: TraceSink
}

export interface ChatResult extends ChatCompletionResponse {
  /** convenience: the assistant text of the first choice */
  content: string
  /** which model actually served this call (router output) */
  routedModel: string
}

export class LLMClient {
  readonly baseURL: string
  readonly limiter: RateLimiter
  readonly router: ModelRouter
  private readonly apiKey?: string
  private readonly timeoutMs: number
  private readonly defaultModel?: string
  private readonly fetchImpl: typeof fetch
  private readonly retryOptions: RetryOptions
  private readonly extraHeaders: Record<string, string>
  private readonly tracer?: TraceSink
  /** monotonic call counter, used for trace ids */
  private callSeq = 0

  constructor(options: LLMClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.defaultModel = options.defaultModel
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.limiter = options.limiter ?? new RateLimiter({ rpm: options.rpm ?? 50, ...options.limiterOptions })
    this.router = options.router ?? new ModelRouter(options.routerOptions)
    this.retryOptions = options.retryOptions ?? {}
    this.extraHeaders = options.extraHeaders ?? {}
    this.tracer = options.tracer
  }

  /** Non-streaming chat completion. Returns the full response. */
  async chat(
    messages: ChatMessage[],
    options: LLMRequestOptions = {},
  ): Promise<ChatResult> {
    const model = this.resolveModel(messages, options)
    const tracerSink = options.tracer ?? this.tracer
    const pending: Omit<TraceEntry, 'seq'> = {
      kind: 'llm',
      id: `llm#${this.callSeq++}`,
      name: model,
      status: 'ok',
      startedAt: Date.now(),
      input: messages,
      meta: { temperature: options.temperature },
    }
    tracerSink?.(pending)
    const entry = pending as TraceEntry & { seq: number }

    try {
      const response = await this.callEndpoint(messages, model, false, options)
      const body = (await response.json()) as ChatCompletionResponse
      const content = body.choices[0]?.message?.content ?? ''
      const result: ChatResult = { ...body, content, routedModel: model }
      this.router.noteSuccess(model)
      if (tracerSink) {
        Object.assign(entry, {
          finishedAt: Date.now(),
          status: 'ok' as const,
          output: result,
          meta: { ...entry.meta, usage: body.usage },
        })
      }
      return result
    } catch (error) {
      this.router.noteFailure(model)
      if (tracerSink) {
        Object.assign(entry, {
          finishedAt: Date.now(),
          status: error instanceof LLMTimeoutError ? ('timeout' as const) : ('error' as const),
          error: describe(error),
        })
      }
      throw error
    }
  }

  /**
   * Streaming chat completion. Yields each SSE chunk as it arrives and
   * *returns* the assembled response when the generator finishes:
   *
   * ```ts
   * const gen = client.stream(messages)
   * for await (const chunk of gen) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
   * const { content } = await LLMClient.collectStream(client.stream(messages))
   * ```
   */
  async *stream(
    messages: ChatMessage[],
    options: LLMRequestOptions = {},
  ): AsyncGenerator<ChatCompletionChunk, ChatCompletionResponse, void> {
    const model = this.resolveModel(messages, options)
    const response = await this.callEndpoint(messages, model, true, options)
    if (!response.body) throw new Error('streaming response has no body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const assembled: ChatCompletionResponse = {
      id: `chatcmpl-aether-${Date.now()}`,
      object: 'chat.completion',
      created: Date.now() / 1000 | 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          assembled.choices[0].finish_reason = assembled.choices[0].finish_reason ?? 'stop'
          return assembled
        }
        if (!payload) continue
        try {
          const chunk = JSON.parse(payload) as ChatCompletionChunk
          const delta = chunk.choices[0]?.delta?.content
          if (typeof delta === 'string') assembled.choices[0].message.content += delta
          if (chunk.choices[0]?.finish_reason) {
            assembled.choices[0].finish_reason = chunk.choices[0].finish_reason
          }
          yield chunk
        } catch {
          // keep the stream alive on malformed lines; the gateway may emit comments
        }
      }
    }
    return assembled
  }

  /** Drain a `stream()` generator into `{ content, chunks }`. */
  static async collectStream(
    gen: AsyncGenerator<ChatCompletionChunk, ChatCompletionResponse, void>,
  ): Promise<{ content: string; chunks: ChatCompletionChunk[]; response: ChatCompletionResponse }> {
    const chunks: ChatCompletionChunk[] = []
    let content = ''
    for (;;) {
      const { done, value } = await gen.next()
      if (done) {
        const response = value as ChatCompletionResponse
        return { content: response.choices[0]?.message?.content ?? content, chunks, response }
      }
      const delta = value!.choices[0]?.delta?.content
      if (typeof delta === 'string') content += delta
      chunks.push(value!)
    }
  }

  resolveModel(messages: ChatMessage[], options: LLMRequestOptions): string {
    if (options.model) return options.model
    if (this.defaultModel) return this.defaultModel
    return this.router.pick(messages, options.complexity)
  }

  /** One rate-limited, retried, time-boxed HTTP call to the endpoint. */
  private async callEndpoint(
    messages: ChatMessage[],
    model: string,
    stream: boolean,
    options: LLMRequestOptions,
  ): Promise<Response> {
    const url = `${this.baseURL}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    }
    const body = JSON.stringify({
      model,
      messages,
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.top_p != null ? { top_p: options.top_p } : {}),
      ...(options.max_tokens != null ? { max_tokens: options.max_tokens } : {}),
      ...(options.stop != null ? { stop: options.stop } : {}),
      stream,
    })

    const maxRetries = options.maxRetries ?? this.retryOptions.maxRetries ?? 4

    const attempt = async (_attemptIndex: number): Promise<Response> => {
      await this.limiter.acquire()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('aether-llm-timeout')), this.timeoutMs)
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text().catch(() => undefined)
          throw new LLMHttpError(response.status, text)
        }
        return response
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new LLMTimeoutError(this.timeoutMs)
        }
        // Node's abort passes the reason we set above
        if (error instanceof Error && error.message === 'aether-llm-timeout') {
          throw new LLMTimeoutError(this.timeoutMs)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    try {
      return await withRetry(attempt, {
        ...this.retryOptions,
        maxRetries,
        shouldRetry: (error) => {
          // a timeout is not worth retrying blindly — the app can decide
          if (error instanceof LLMTimeoutError) return false
          return this.retryOptions.shouldRetry?.(error, 0) ?? defaultShouldRetry(error)
        },
      })
    } catch (error) {
      if (error instanceof RetryExhaustedError && error.lastError) throw error.lastError
      throw error
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** True when an error is a transient LLM/HTTP failure worth a retry. */
export function isTransient(error: unknown): boolean {
  return defaultShouldRetry(error)
}
