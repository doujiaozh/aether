import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracer } from 'aether-core'
import { LLMClient, LLMTimeoutError } from '../src/client.js'
import { RateLimiter } from '../src/rate-limiter.js'
import type { ChatCompletionResponse } from '../src/types.js'

function completion(content: string, model = 'atriadawn'): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }

/** scripted mock fetch: each entry is either a Response factory or a thrown error */
function mockFetch(script: Array<(init: FetchInit) => Promise<Response> | Response>) {
  let calls = 0
  const seen: { url: string; init: FetchInit }[] = []
  const fetchImpl = async (url: any, init: any): Promise<Response> => {
    calls++
    seen.push({ url, init })
    const step = script[Math.min(calls - 1, script.length - 1)]
    return step(init)
  }
  return {
    fetchImpl,
    calls: () => calls,
    seen: () => seen,
    last: () => seen[seen.length - 1],
  }
}

const ok = (content: string, model?: string) => () =>
  new Response(JSON.stringify(completion(content, model)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const sleep1 = async (): Promise<void> => {}

function makeClient(fetchImpl: (url: any, init: any) => Promise<Response>, extra: Record<string, unknown> = {}): LLMClient {
  return new LLMClient({
    baseURL: 'https://llm.example.com/v1',
    apiKey: 'sk-test',
    fetch: fetchImpl as never,
    retryOptions: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, sleep: sleep1 },
    ...extra,
  })
}

test('client: chat sends an OpenAI-shaped request and returns the assistant content', async () => {
  const m = mockFetch([ok('hello there')])
  const client = makeClient(m.fetchImpl)
  const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.2 })

  assert.equal(result.content, 'hello there')
  assert.equal(result.routedModel, 'atriadawn') // simple prompt → fast tier
  assert.equal(m.calls(), 1)

  const { url, init } = m.last()
  assert.equal(url, 'https://llm.example.com/v1/chat/completions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers?.['Authorization'], 'Bearer sk-test')
  const body = JSON.parse(init.body as string)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
  assert.equal(body.temperature, 0.2)
  assert.equal(body.stream, false)
})

test('client: a pinned model bypasses the router', async () => {
  const m = mockFetch([ok('deep answer', 'deepseek-v4.1')])
  const client = makeClient(m.fetchImpl)
  const result = await client.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-v4.1' })
  assert.equal(result.routedModel, 'deepseek-v4.1')
  const body = JSON.parse(m.last().init.body as string)
  assert.equal(body.model, 'deepseek-v4.1')
})

test('client: 429 is retried with backoff and eventually succeeds', async () => {
  const m = mockFetch([
    () => new Response('{"error":"rate limit","retry_after":0}', { status: 429 }),
    ok('after retry'),
  ])
  const client = makeClient(m.fetchImpl)
  const result = await client.chat([{ role: 'user', content: 'hi' }])
  assert.equal(result.content, 'after retry')
  assert.equal(m.calls(), 2)
})

test('client: non-retryable 4xx fails immediately', async () => {
  const m = mockFetch([() => new Response('{"error":"bad key"}', { status: 401 })])
  const client = makeClient(m.fetchImpl)
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /HTTP 401/)
  assert.equal(m.calls(), 1)
})

test('client: retries exhaust and the last HTTP error surfaces', async () => {
  const m = mockFetch([() => new Response('unavailable', { status: 503 })])
  const client = makeClient(m.fetchImpl)
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /HTTP 503/)
  assert.equal(m.calls(), 4) // 1 attempt + 3 retries
})

test('client: request timeout aborts once, without retries', async () => {
  let calls = 0
  const hanging: typeof fetch = async (_url, init) => {
    calls++
    const signal = (init as FetchInit).signal
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      signal?.addEventListener('abort', () => reject(signal.reason))
    })
  }
  const client = makeClient(hanging, { timeoutMs: 20 })
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), (e: unknown) => e instanceof LLMTimeoutError)
  assert.equal(calls, 1) // timeouts are not retried by default
})

test('client: a short timeout does not break the retry path', async () => {
  const m = mockFetch([
    () => new Response('{"error":"rate limit"}', { status: 429 }),
    ok('second try'),
  ])
  const client = makeClient(m.fetchImpl, { timeoutMs: 5 })
  const result = await client.chat([{ role: 'user', content: 'hi' }])
  assert.equal(result.content, 'second try')
})

test('client: stream parses SSE chunks and reassembles the message', async () => {
  const sse = [
    'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}',
    '',
    'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"}}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  const m = mockFetch([
    () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  ])
  const client = makeClient(m.fetchImpl)

  const gen = client.stream([{ role: 'user', content: 'hi' }], { model: 'm' })
  const { content, chunks, response } = await LLMClient.collectStream(gen)
  assert.equal(content, 'Hello')
  assert.equal(chunks.length, 2)
  assert.equal(response.choices[0].message.content, 'Hello')
  assert.equal(response.model, 'm')
})

test('client: tracer records ok entries, error entries and rerouted model', async () => {
  const tracer = createTracer()
  const m = mockFetch([ok('yes')])
  const client = makeClient(m.fetchImpl, { tracer: tracer.emit })
  await client.chat([{ role: 'user', content: 'hi' }])
  assert.equal(tracer.entries.length, 1)
  assert.equal(tracer.entries[0].kind, 'llm')
  assert.equal(tracer.entries[0].status, 'ok')
  assert.equal(tracer.entries[0].seq, 0)

  const tracer2 = createTracer()
  const m2 = mockFetch([() => new Response('unauthorized', { status: 401 })])
  const client2 = makeClient(m2.fetchImpl, { tracer: tracer2.emit })
  await assert.rejects(() => client2.chat([{ role: 'user', content: 'hi' }]))
  assert.equal(tracer2.entries[0].status, 'error')
  assert.ok(tracer2.entries[0].error?.includes('401'))
  assert.match(tracer2.toNDJSON(), /"status":"error"/)
})

test('client: the rate limiter paces concurrent requests', async () => {
  let t = 0
  const limiter = new RateLimiter({
    rpm: 60,
    windowMs: 1000, // 60 rpm * 1s window = 1 slot per second
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
  })
  const m = mockFetch([ok('one'), ok('two')])
  const client = makeClient(m.fetchImpl, { limiter })

  const order: string[] = []
  const first = client.chat([{ role: 'user', content: 'a' }]).then(() => order.push('a'))
  const second = client.chat([{ role: 'user', content: 'b' }]).then(() => order.push('b'))
  await Promise.all([first, second])
  assert.deepEqual(order, ['a', 'b'])
  assert.ok(t >= 1000, `second request waited for the window (t=${t})`)
})
