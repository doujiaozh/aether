/**
 * The microtask scheduler.
 *
 * Effects that opt into deferred re-evaluation (the default for `defineNode`
 * and `watch`) are queued here instead of running synchronously. Benefits:
 *
 *  1. dedupe — several mutations of the same tick collapse into one run;
 *  2. ordering — jobs run strictly in queue order, awaited serially, so
 *     async agent steps compose deterministically;
 *  3. no stack explosion — long reactive chains cannot blow the stack.
 */
import { isPromiseLike } from './utils.js'

export type Job = () => unknown

const queue: Job[] = []
const queued = new Set<Job>()
let flushPromise: Promise<void> | undefined

let errorHandler: ((error: unknown, job: Job) => void) | undefined

/**
 * Enqueue a deferred job. Duplicate enqueues of the same function reference
 * collapse into one — this is the dedupe that makes batched mutations cheap.
 */
export function queueJob(job: Job): void {
  if (queued.has(job)) return
  queued.add(job)
  queue.push(job)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (!flushPromise) {
    flushPromise = Promise.resolve().then(flushJobs)
  }
}

/**
 * Flush the queue. Jobs are awaited one by one; jobs enqueued by other jobs
 * (a reactive chain!) are picked up by the same flush, so an entire cascade
 * settles within one `nextTick()`.
 */
async function flushJobs(): Promise<void> {
  try {
    while (queue.length > 0) {
      const job = queue.shift()!
      queued.delete(job)
      try {
        await job()
      } catch (error) {
        if (errorHandler) errorHandler(error, job)
        else console.error('[aether] unhandled error in scheduled job:', error)
      }
    }
  } finally {
    flushPromise = undefined
  }
}

/**
 * Resolves after the current reactive cascade has fully settled.
 * The primary synchronization primitive for tests and for demos that want
 * "wait until everything re-evaluated".
 */
export function nextTick(): Promise<void> {
  scheduleFlush()
  return flushPromise ?? Promise.resolve()
}

/** Override the default (console.error) handler for job errors. */
export function setErrorHandler(handler: (error: unknown, job: Job) => void): void {
  errorHandler = handler
}

export function getErrorHandler(): ((error: unknown, job: Job) => void) | undefined {
  return errorHandler
}

/** Wait for a value if it is promise-like — used by the scheduler callers. */
export function maybeAwait<T>(value: T): T | Promise<T> {
  return isPromiseLike(value) ? Promise.resolve(value) : value
}
