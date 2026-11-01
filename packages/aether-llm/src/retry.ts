/**
 * Exponential backoff with jitter for transient LLM failures.
 *
 * Retry policy (mirrors what serious gateways expect):
 *   - HTTP 429 (rate limit) → honor `Retry-After` when present, else backoff
 *   - HTTP 5xx / network error → exponential backoff with jitter
 *   - 4xx (other) / parse errors → fail fast, no retry
 */

export interface RetryEvent {
  attempt: number       // 0-based index of the attempt that just failed
  delayMs: number       // backoff that will be slept before the next attempt
  error: unknown
}

export interface RetryOptions {
  /** retry count after the first attempt (default 4 → 5 attempts total) */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** override the retry decision (defaults to `defaultShouldRetry`) */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  onRetry?: (event: RetryEvent) => void
}

export class RetryExhaustedError extends Error {
  attempts: number
  lastError: unknown
  constructor(attempts: number, lastError: unknown) {
    super(`all ${attempts} attempt(s) failed; last error: ${describe(lastError)}`)
    this.name = 'RetryExhaustedError'
    this.attempts = attempts
    this.lastError = lastError
  }
}

/** Errors carry these hints; `LLMHttpError` below implements them. */
export interface RetryableError extends Error {
  retryable?: boolean
  retryAfterMs?: number
}

export function defaultShouldRetry(error: unknown): boolean {
  if (error == null) return false
  const e = error as RetryableError
  if (typeof e.retryable === 'boolean') return e.retryable
  // plain TypeError from fetch (DNS / connection) is transient
  if (error instanceof TypeError) return true
  const status = (error as { status?: number }).status
  if (typeof status === 'number') return status === 429 || (status >= 500 && status <= 599)
  return false
}

/** Exponential backoff scaled by 2^attempt, capped, with full jitter. */
export function retryDelay(attempt: number, baseDelayMs = 500, maxDelayMs = 20_000): number {
  const expo = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  const jitter = Math.random() * (expo / 2)
  return Math.min(maxDelayMs, expo / 2 + jitter + baseDelayMs / 2)
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4
  const base = options.baseDelayMs ?? 500
  const max = options.maxDelayMs ?? 20_000
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry

  let attempt = 0
  let lastError: unknown
  for (;;) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) {
        throw error
      }
      let delay = retryDelay(attempt, base, max)
      const retryAfter = (error as RetryableError).retryAfterMs
      if (typeof retryAfter === 'number' && retryAfter > 0) delay = Math.max(delay, retryAfter)
      options.onRetry?.({ attempt, delayMs: delay, error })
      await sleep(delay)
      attempt++
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
