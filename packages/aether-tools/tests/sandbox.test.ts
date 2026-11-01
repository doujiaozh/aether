import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracer } from 'aether-core'
import { runTool, ToolTimeoutError, ToolValidationError } from '../src/sandbox.js'
import { ToolRegistry } from '../src/registry.js'
import { isTool, validateArgs } from '../src/types.js'
import type { Tool } from '../src/types.js'

const echo: Tool<{ text: string }, { text: string }> = {
  name: 'echo',
  description: 'echo the text back',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(ctx) {
    return { output: { text: ctx.args.text } }
  },
}

test('tools: runTool returns output and records an ok trace entry', async () => {
  const tracer = createTracer(() => 1000)
  const record = await runTool(echo, { args: { text: 'hi' }, tracer: tracer.emit, now: () => 1005 })
  assert.equal(record.status, 'ok')
  assert.deepEqual(record.result?.output, { text: 'hi' })
  assert.equal(tracer.entries.length, 1)
  const [entry] = tracer.entries
  assert.equal(entry.kind, 'tool')
  assert.equal(entry.id, 'echo')
  assert.equal(entry.status, 'ok')
  assert.equal(entry.finishedAt, 1005)
  assert.deepEqual(entry.input, { text: 'hi' })
  assert.deepEqual(entry.output, { text: 'hi' })
})

test('tools: a failing tool rethrows, trace marks status error', async () => {
  const tracer = createTracer(() => 0)
  const boom: Tool = {
    name: 'boom',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      throw new Error('nope')
    },
  }
  await assert.rejects(() => runTool(boom, { args: {}, tracer: tracer.emit }), /nope/)
  const [entry] = tracer.entries
  assert.equal(entry.status, 'error')
  assert.ok(entry.error?.includes('nope'))
})

test('tools: timeout aborts the tool and traces status timeout', async () => {
  const tracer = createTracer(() => 0)
  const slow: Tool = {
    name: 'slow',
    description: 'sleeps past the budget',
    inputSchema: { type: 'object', properties: {} },
    async execute(ctx) {
      // honour the abort between await points, like real I/O code should
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(ctx.signal.reason)
        })
      })
      return { output: 'never' }
    },
  }
  await assert.rejects(
    () => runTool(slow, { args: {}, timeoutMs: 20, tracer: tracer.emit }),
    (e: unknown) => e instanceof ToolTimeoutError || (e instanceof Error && e.name === 'AbortError'),
  )
  const [entry] = tracer.entries
  assert.equal(entry.status, 'timeout')
  assert.ok(entry.error)
  assert.equal(entry.meta?.timeoutMs, 20)
})

test('tools: a parent signal cancels the run (status aborted)', async () => {
  const tracer = createTracer(() => 0)
  const parent = new AbortController()
  const blocking: Tool = {
    name: 'blocking',
    description: 'waits on the signal',
    inputSchema: { type: 'object', properties: {} },
    async execute(ctx) {
      await new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) return reject(ctx.signal.reason)
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
      })
      return { output: 'never' }
    },
  }
  const pending = runTool(blocking, {
    args: {},
    timeoutMs: 5000,
    tracer: tracer.emit,
    parentSignal: parent.signal,
  })
  queueMicrotask(() => parent.abort(new Error('agent cancelled')))
  await assert.rejects(() => pending, /agent cancelled/)
  const [entry] = tracer.entries
  assert.equal(entry.status, 'aborted')
})

test('tools: the process is not kept alive by a fast tool deadline', async () => {
  // default 30s watchdog must be cleared after a quick success
  const record = await runTool(echo, { args: { text: 'x' }, timeoutMs: 30_000 })
  assert.equal(record.status, 'ok')
})

test('tools: registry resolves and validates tool calls', () => {
  const registry = new ToolRegistry().registerAll([echo])
  assert.equal(registry.size, 1)
  assert.deepEqual(registry.list(), ['echo'])
  assert.equal(registry.has('echo'), true)

  const resolved = registry.resolve('echo', { text: 'hello' })
  assert.equal(resolved.name, 'echo')

  assert.throws(
    () => registry.resolve('echo', {}),
    (e: unknown) => e instanceof ToolValidationError && /missing required argument/.test(e.message),
  )
  assert.throws(
    () => registry.resolve('nope', {}),
    (e: unknown) => e instanceof ToolValidationError && /unknown tool/.test(e.message),
  )
  assert.throws(() => registry.register(echo), /already registered/)
  assert.equal(isTool(echo), true)
  assert.equal(isTool({ name: 'x' }), false)
})

test('tools: validateArgs checks types and extra properties', () => {
  assert.deepEqual(validateArgs({ text: 'ok' }, echo.inputSchema), [])
  assert.deepEqual(validateArgs({ text: 3 }, echo.inputSchema), [
    'argument "text" must be string, got number',
  ])
  assert.deepEqual(validateArgs({ text: 'a', extra: 1 }, echo.inputSchema), [
    'unexpected argument "extra"',
  ])
  assert.deepEqual(validateArgs({}, { type: 'object', properties: {}, required: ['a'] }), [
    'missing required argument "a"',
  ])
})
