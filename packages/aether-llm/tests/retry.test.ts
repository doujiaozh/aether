import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultShouldRetry, retryDelay, withRetry } from '../src/retry.js'
import { LLMHttpError } from '../src/client.js'

const sleeps: number[] = []
const fakeSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms)
}

function makeFailing(failTimes: number, failWith: () => unknown = () => new TypeError('fetch failed')) {
  let calls = 0
  return {
    calls: () => calls,
    run: async (_attempt: number) => {
      calls++
      if (calls <= failTimes) throw failWith()
      return 'recovered'
    },
  }
}

test('retry: transient failures are retried, later attempts succeed', async () => {
  sleeps.length = 0
  const flaky = makeFailing(2)
  const result = await withRetry(flaky.run, { maxRetries: 4, baseDelayMs: 1, sleep: fakeSleep })
  assert.equal(result, 'recovered')
  assert.equal(flaky.calls(), 3)
  assert.equal(sleeps.length, 2)
})

test('retry: exhausted attempts throw the original error', async () => {
  const flaky = makeFailing(99)
  await assert.rejects(
    () => withRetry(flaky.run, { maxRetries: 2, baseDelayMs: 1, sleep: fakeSleep }),
    /fetch failed/,
  )
  assert.equal(flaky.calls(), 3) // 1 attempt + 2 retries
})

test('retry: non-retryable errors fail immediately', async () => {
  const bad = new LLMHttpError(400, 'invalid api key')
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++
        throw bad
      }, { maxRetries: 4, sleep: fakeSleep }),
    /HTTP 400/,
  )
  assert.equal(calls, 1)
})

test('retry: 429 is retryable, 5xx is retryable, 4xx is not', () => {
  assert.equal(defaultShouldRetry(new LLMHttpError(429, 'rate limit')), true)
  assert.equal(defaultShouldRetry(new LLMHttpError(503, 'unavailable')), true)
  assert.equal(defaultShouldRetry(new LLMHttpError(401, 'unauthorized')), false)
  assert.equal(defaultShouldRetry(new TypeError('fetch failed')), true)
  assert.equal(defaultShouldRetry(new Error('parse')), false)
})

test('retry: backoff is exponential, capped and jitted', () => {
  const delays = Array.from({ length: 8 }, (_, attempt) => retryDelay(attempt, 100, 5000))
  // base 100ms: floor grows 100*2^attempt / 2 + base/2 ... never exceeds cap
  for (const d of delays) assert.ok(d >= 100 && d <= 5000, `delay ${d} out of bounds`)
  assert.equal(Math.max(...delays) <= 5000, true)
  assert.equal(Math.min(...delays) < 1000, true) // early attempts stay tame
})

test('retry: Retry-After overrides the computed backoff', async () => {
  sleeps.length = 0
  const err = new LLMHttpError(429, '{"retry_after": 2}')
  assert.equal(err.retryAfterMs, 2000)
  let calls = 0
  const result = await withRetry(
    async () => {
      calls++
      if (calls === 1) throw err
      return 'ok'
    },
    { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 100, sleep: fakeSleep },
  )
  assert.equal(result, 'ok')
  assert.ok(sleeps[0] >= 2000, `honored Retry-After: slept ${sleeps[0]}ms`)
})
