/**
 * RPM pacing via a sliding-window limiter.
 *
 * The Mandate of Heaven for shared LLM endpoints: respect 50 RPM without
 * bleeding. Every request first `await limiter.acquire()`; the limiter keeps
 * timestamps of the last `slots` acquisitions and sleeps exactly long enough
 * for the oldest one to fall out of the window.
 *
 * The clock and the sleeper are injectable so tests run deterministically.
 */

export interface RateLimiterOptions {
  /** requests per minute (default 50 — the shared-tier cap) */
  rpm?: number
  /** window length in ms (default 60_000); shrink it in tests */
  windowMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class RateLimiter {
  readonly rpm: number
  readonly windowMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly stamps: number[] = []
  /** total acquisitions honouring the window (diagnostics / tests) */
  acquired = 0

  constructor(options: RateLimiterOptions = {}) {
    this.rpm = options.rpm ?? 50
    this.windowMs = options.windowMs ?? 60_000
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Number of requests still allowed inside the current window. */
  available(): number {
    this.purge()
    return this.slots() - this.stamps.length
  }

  /** Timestamp when the next slot frees up (now if available). */
  nextSlotAt(): number {
    this.purge()
    if (this.stamps.length < this.slots()) return this.now()
    return this.stamps[0] + this.windowMs
  }

  async acquire(): Promise<void> {
    // loop: after sleeping, re-check — another waiter may have taken the slot
    for (;;) {
      this.purge()
      if (this.stamps.length < this.slots()) {
        this.stamps.push(this.now())
        this.acquired++
        return
      }
      const waitMs = this.stamps[0] + this.windowMs - this.now()
      if (waitMs > 0) await this.sleep(waitMs)
    }
  }

  private slots(): number {
    return Math.max(1, Math.round((this.rpm * this.windowMs) / 60_000))
  }

  private purge(): void {
    const cutoff = this.now() - this.windowMs
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift()
  }
}
