/**
 * Trace model — shared by every Aether layer.
 *
 * The LLM client, the tool sandbox and the reactive graph all speak the same
 * `TraceEntry` shape, so a demo can replay "what the agent did" end to end:
 * which cell changed, which node re-ran, which tool was invoked with which
 * arguments, which LLM call returned what. Keep this file dependency-free.
 */

export type TraceEntryKind = 'llm' | 'tool' | 'graph' | 'state'

export type TraceEntryStatus = 'ok' | 'error' | 'timeout' | 'aborted'

export interface TraceEntry {
  /** kind of the traceable unit: an LLM call, a tool execution, a graph event */
  kind: TraceEntryKind
  /** monotonically increasing sequence number within the tracer */
  seq: number
  /** stable id of the traced unit (node id, tool name, llm call id) */
  id: string
  /** human readable label (tool title, model id, message...) */
  name: string
  startedAt: number
  finishedAt?: number
  status: TraceEntryStatus
  /** request / trigger data (arguments, prompt, changed cell) */
  input?: unknown
  /** response / result data (tool output, LLM content) */
  output?: unknown
  error?: string
  /** free-form extras: model, temperature, duration, attempt index... */
  meta?: Record<string, unknown>
}

/** A sink receives one entry per traced event and returns the stored entry. */
export type TraceSink = (entry: Omit<TraceEntry, 'seq'>) => TraceEntry

export interface Tracer {
  emit: (entry: Omit<TraceEntry, 'seq'>) => TraceEntry
  entries: TraceEntry[]
  /** convert the whole trace into newline-delimited JSON (the replay format) */
  toNDJSON(): string
  clear(): void
}

/**
 * Create an in-memory tracer. Every Aether subsystem accepts a `tracer`
 * option; `createTracer()` gives you one that doubles as the replay log.
 *
 * Contract: the sink stores the *same object* it received and stamps `seq`,
 * `startedAt` and `status` defaults onto it in place. Mutating the entry a
 * call site keeps a reference to (e.g. `Object.assign(entry, {...})` after
 * the awaited work finishes) updates the recorded trace.
 */
export function createTracer(now: () => number = Date.now): Tracer {
  const entries: TraceEntry[] = []
  let seq = 0
  const emit: Tracer['emit'] = (partial) => {
    const entry = partial as TraceEntry
    entry.seq = seq++
    entry.startedAt = now()
    entry.status ??= 'ok'
    entries.push(entry)
    return entry
  }
  return {
    emit,
    entries,
    toNDJSON: () => entries.map((e) => JSON.stringify(e)).join('\n'),
    clear: () => {
      entries.length = 0
      seq = 0
    },
  }
}

/** Finish an entry opened by `tracer.emit(...)` (status defaults to 'ok'). */
export function finishTrace(
  entry: TraceEntry,
  now: () => number = Date.now,
  patch?: Partial<TraceEntry>,
): TraceEntry {
  entry.finishedAt = now()
  if (patch) Object.assign(entry, patch)
  return entry
}
