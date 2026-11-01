/**
 * Tool contracts for the Aether sandbox execution layer.
 *
 * A Tool is a *typed capability*: a name, a JSON-Schema description of its
 * input, and an executor that receives a `ToolContext` carrying the
 * AbortSignal, the trace sink and sandbox metadata. Tools never touch the
 * outside world directly through hidden channels — everything they need
 * arrives via the context, so every call can be time-boxed, traced and
 * replayed.
 */

import type { TraceSink } from 'aether-core'

/** JSON-Schema-ish description of a tool's input. */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  /** human hint shown to the model / reader */
  description?: string
}

/** Everything a tool execution receives. */
export interface ToolContext<A = Record<string, unknown>> {
  /** parsed, schema-validated arguments */
  args: A
  /** aborts when the sandbox deadline hits or the parent run cancels */
  signal: AbortSignal
  /** deadline in ms counted from the start of the execution */
  timeoutMs: number
  /** shared trace sink (may be undefined when tracing is off) */
  tracer?: TraceSink
  /** call-scoped scratch pocket for tools that need a handle */
  meta?: Record<string, unknown>
}

export interface ToolResult<O = unknown> {
  /** structured payload — must be JSON-serialisable for replay */
  output: O
  /** free-form补充：mime type, byte sizes, warnings... */
  meta?: Record<string, unknown>
}

/**
 * The Tool contract. `execute` must:
 *   - honour `ctx.signal.aborted` between await points (the sandbox also
 *     rejects the returned promise on timeout),
 *   - return JSON-serialisable output (it lands in the trace).
 */
export interface Tool<A = Record<string, unknown>, O = unknown> {
  name: string
  description: string
  inputSchema: ToolInputSchema
  execute: (ctx: ToolContext<A>) => Promise<ToolResult<O>>
}

/** Structural helpers -------------------------------------------------- */

export function isTool(value: unknown): value is Tool {
  if (value == null || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    t.inputSchema !== null &&
    typeof t.inputSchema === 'object' &&
    typeof t.execute === 'function'
  )
}

/**
 * Validate `args` against the declared schema (subset contract: unknown
 * required keys and wrong basic types are rejected). Returns a list of
 * human readable problems; an empty list means valid.
 */
export function validateArgs(
  args: Record<string, unknown>,
  schema: ToolInputSchema,
): string[] {
  const problems: string[] = []
  if (typeof args !== 'object' || args === null) {
    return ['args must be an object']
  }
  for (const key of schema.required ?? []) {
    if (!(key in args)) problems.push(`missing required argument "${key}"`)
  }
  if (schema.additionalProperties === false) {
    const declared = new Set(Object.keys(schema.properties ?? {}))
    for (const key of Object.keys(args)) {
      if (!declared.has(key)) problems.push(`unexpected argument "${key}"`)
    }
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in args)) continue
    const value = args[key]
    const expected = (spec as { type?: string }).type
    if (!expected) continue
    const jsType = Array.isArray(value) ? 'array' : typeof value
    const ok =
      (expected === 'array' && jsType === 'array') ||
      (expected === 'integer' && jsType === 'number' && Number.isInteger(value)) ||
      (expected === 'number' && jsType === 'number') ||
      (expected === 'string' && jsType === 'string') ||
      (expected === 'boolean' && jsType === 'boolean') ||
      (expected === 'object' && jsType === 'object')
    if (!ok) problems.push(`argument "${key}" must be ${expected}, got ${jsType}`)
  }
  return problems
}
