/**
 * The sandbox: one function that runs a Tool inside a time-boxed,
 * abort-aware, fully traced envelope.
 *
 * Guarantees:
 *   1. `signal` inside the tool aborts at `timeoutMs` (AbortController).
 *   2. A parent signal can cancel the run early; both signals are merged.
 *   3. Regardless of outcome (ok / error / timeout / aborted) exactly one
 *      trace entry is emitted with the arguments and the result or error,
 *      so the whole run is replayable from the trace alone.
 *   4. The sandbox never swallows the tool's error — it tags it with
 *      `status` and re-throws so the caller can react.
 */

import type { TraceEntry, TraceSink } from 'aether-core'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class ToolTimeoutError extends Error {
  tool: string
  timeoutMs: number
  constructor(tool: string, timeoutMs: number) {
    super(`tool "${tool}" exceeded its ${timeoutMs}ms sandbox budget`)
    this.name = 'ToolTimeoutError'
    this.tool = tool
    this.timeoutMs = timeoutMs
  }
}

export class ToolValidationError extends Error {
  tool: string
  problems: string[]
  constructor(tool: string, problems: string[]) {
    super(`arguments for tool "${tool}" are invalid: ${problems.join('; ')}`)
    this.name = 'ToolValidationError'
    this.tool = tool
    this.problems = problems
  }
}

export interface RunToolOptions<A> {
  args: A
  /** hard deadline (ms). Default 30_000. `Infinity` disables the watchdog. */
  timeoutMs?: number
  /** cancel this run from the outside (agent cancelled, graph torn down) */
  parentSignal?: AbortSignal
  /** trace sink; when present the run is recorded */
  tracer?: TraceSink
  /** extra sandbox metadata merged into the trace entry's `meta` */
  meta?: Record<string, unknown>
  /** now()-ish clock for deterministic tests */
  now?: () => number
}

export interface RunToolRecord<O> {
  tool: string
  status: TraceEntry['status']
  result?: ToolResult<O>
  error?: string
  durationMs: number
  entry?: TraceEntry
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    const signals = [a, b].filter((s): s is AbortSignal => s != null)
    if (signals.length === 0) return new AbortController().signal
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals)
  }
  // Node 18 fallback: manual controller listening to both parents
  const controller = new AbortController()
  for (const parent of [a, b]) {
    if (!parent) continue
    if (parent.aborted) {
      controller.abort(parent.reason)
      break
    }
    parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true })
  }
  return controller.signal
}

/**
 * Run a tool inside the sandbox. Resolves with a record describing the
 * outcome; rejects only when the tool itself fails (error/timeout/abort),
 * so callers that want the trace can inspect via the injected `tracer`.
 */
export async function runTool<A, O>(
  tool: Tool<A, O>,
  options: RunToolOptions<A>,
): Promise<RunToolRecord<O>> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = options.now ?? Date.now
  const startedAt = now()

  const tracerSink = options.tracer
  const pending: Omit<TraceEntry, 'seq'> = {
    kind: 'tool',
    id: tool.name,
    name: tool.name,
    startedAt,
    status: 'ok',
    input: options.args,
    meta: { ...(options.meta ?? {}), timeoutMs },
  }
  const entry = tracerSink ? tracerSink(pending) : (pending as TraceEntry)

  const controller = new AbortController()
  const signal = mergeSignals(controller.signal, options.parentSignal)
  const ctx: ToolContext<A> = {
    args: options.args,
    signal,
    timeoutMs,
    tracer: tracerSink,
  }

  // deadline watcher: aborts exactly once, always cancelled afterwards so a
  // short-lived tool never leaves a dangling 30s timer in the event loop
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs !== Number.POSITIVE_INFINITY) {
    timer = setTimeout(
      () => {
        timedOut = true
        controller.abort(new ToolTimeoutError(tool.name, timeoutMs))
      },
      Math.max(0, timeoutMs),
    )
  }

  let result: ToolResult<O> | undefined
  let error: unknown
  try {
    result = await tool.execute(ctx)
  } catch (e) {
    error = e
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const finishedAt = now()
  const durationMs = finishedAt - startedAt

  if (error == null && result !== undefined) {
    const record: RunToolRecord<O> = {
      tool: tool.name,
      status: 'ok',
      result,
      durationMs,
      entry,
    }
    if (tracerSink) {
      Object.assign(entry, {
        finishedAt,
        status: 'ok' as const,
        output: result.output,
      })
    }
    return record
  }

  const isTimeout =
    timedOut ||
    error instanceof ToolTimeoutError ||
    (error instanceof DOMException && error.name === 'TimeoutError')
  const isAbort = !isTimeout && signal.aborted
  const status: TraceEntry['status'] = isTimeout ? 'timeout' : isAbort ? 'aborted' : 'error'
  const message = describe(error)

  if (tracerSink) {
    Object.assign(entry, {
      finishedAt,
      status,
      error: message,
      output: result?.output,
    })
  }

  // rethrow so callers see the failure; tag the error for the trace reader
  if (error != null) {
    const e = error as Error & { aetherStatus?: TraceEntry['status'] }
    e.aetherStatus = status
    throw error
  }
  // tool rejected without an error value (should not happen) — still trace
  const fallback = new Error(`tool "${tool.name}" rejected without an error`)
  ;(fallback as Error & { aetherStatus?: TraceEntry['status'] }).aetherStatus = status
  throw fallback
}

function describe(error: unknown): string {
  if (error == null) return 'unknown error'
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
