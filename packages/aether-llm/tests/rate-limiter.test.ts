import test from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../src/rate-limiter.js'

/** virtual clock: `t` only advances when the injected sleep is awaited */
function makeClock() {
  let t = 1000
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
    get t() {
      return t
    },
  }
}

test('rate limiter: allows `rpm` acquisitions inside one window', async () => {
  const clock = makeClock()
  const limiter = new RateLimiter({ rpm: 600, windowMs: 1000, now: clock.now, sleep: clock.sleep })
  // 600 rpm * 1000ms window = 10 slots per second
  for (let i = 0; i < 10; i++) await limiter.acquire()
  assert.equal(limiter.acquired, 10)
  assert.equal(limiter.available(), 0)
})

test('rate limiter: the next acquisition waits for the window to slide', async () => {
  const clock = makeClock()
  const limiter = new RateLimiter({ rpm: 600, windowMs: 1000, now: clock.now, sleep: clock.sleep })
  for (let i = 0; i < 10; i++) await limiter.acquire()

  const startedAt = clock.t
  await limiter.acquire()
  assert.ok(clock.t >= startedAt + 1000, `advanced ${clock.t - startedAt}ms, expected >= 1000ms`)
  assert.equal(limiter.acquired, 11)
})

test('rate limiter: nextSlotAt reports when capacity returns', async () => {
  const clock = makeClock()
  const limiter = new RateLimiter({ rpm: 600, windowMs: 1000, now: clock.now, sleep: clock.sleep })
  await limiter.acquire()
  // 10 slots per window: one consumed, capacity still available right now
  assert.equal(limiter.available(), 9)
  assert.equal(limiter.nextSlotAt(), clock.t)
  clock.advance(1000)
  assert.equal(limiter.available(), 10)
})

test('rate limiter: default config targets 50 RPM', () => {
  const limiter = new RateLimiter()
  assert.equal(limiter.rpm, 50)
  assert.equal(limiter.windowMs, 60_000)
})
