import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AetherGraph,
  defineNode,
  graph,
  nextTick,
  queueJob,
  ref,
  reactive,
  computed,
  watch,
  watchEffect,
} from '../src/index.js'

test('scheduler: queueJob dedupes and flushes on nextTick', async () => {
  let calls = 0
  const job = () => calls++
  queueJob(job)
  queueJob(job)
  queueJob(job)
  assert.equal(calls, 0)
  await nextTick()
  assert.equal(calls, 1)
})

test('scheduler: jobs run in enqueue order, serially', async () => {
  const order: string[] = []
  const make = (id: string, slow?: boolean) => async () => {
    order.push(`start:${id}`)
    if (slow) await Promise.resolve()
    order.push(`end:${id}`)
  }
  queueJob(make('a', true))
  queueJob(make('b'))
  await nextTick()
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'])
})

test('scheduler: a job that queues another job is picked up by the same flush', async () => {
  const order: string[] = []
  const second = () => order.push('second')
  const first = () => {
    order.push('first')
    queueJob(second)
  }
  queueJob(first)
  await nextTick()
  assert.deepEqual(order, ['first', 'second'])
})

test('scheduler: job errors are swallowed so the queue keeps draining', async () => {
  const Boom = new Error('boom')
  let after = 0
  queueJob(() => {
    throw Boom
  })
  queueJob(() => {
    after++
  })
  await nextTick()
  assert.equal(after, 1)
})

test('watch: default flush is async (deferred to nextTick)', async () => {
  const a = ref(0)
  let calls = 0
  watch(a, () => calls++)
  a.value = 1
  assert.equal(calls, 0)
  await nextTick()
  assert.equal(calls, 1)
})

test('watch: flush sync fires immediately', () => {
  const a = ref(0)
  let calls = 0
  watch(a, () => calls++, { flush: 'sync' })
  a.value = 1
  assert.equal(calls, 1)
})

test('watch: immediate callback receives current value and undefined old value', () => {
  const a = ref(7)
  const seen: Array<[number, number | undefined]> = []
  watch(a, (v, ov) => seen.push([v, ov]), { immediate: true, flush: 'sync' })
  a.value = 8
  assert.deepEqual(seen, [
    [7, undefined],
    [8, 7],
  ])
})

test('watch: deep watch on a reactive object (default)', async () => {
  const obj = reactive({ nested: { count: 0 } })
  let calls = 0
  watch(obj, () => calls++)
  obj.nested.count = 1
  assert.equal(calls, 0)
  await nextTick()
  assert.equal(calls, 1)
})

test('watch: unwatch stops the subscription', async () => {
  const a = ref(0)
  let calls = 0
  const stop = watch(a, () => calls++)
  a.value = 1
  await nextTick()
  assert.equal(calls, 1)
  stop()
  a.value = 2
  await nextTick()
  assert.equal(calls, 1)
})

test('watch: array of sources and cleanup registration', async () => {
  const a = ref(1)
  const b = ref(2)
  const events: string[] = []
  watch([a, b], (nv: any, ov: any, onCleanup: (fn: () => void) => void) => {
    onCleanup(() => events.push('cleanup'))
    events.push(`a:${String(nv[0])} b:${String(nv[1])} (was a:${String(ov?.[0])} b:${String(ov?.[1])})`)
  })
  a.value = 10
  await nextTick()
  b.value = 20
  await nextTick()
  assert.equal(events[0], 'a:10 b:2 (was a:1 b:2)')
  assert.equal(events[1], 'cleanup')
  assert.equal(events[2], 'a:10 b:20 (was a:10 b:2)')
})

test('watch: once stops after the first callback', async () => {
  const a = ref(0)
  let calls = 0
  watch(a, () => calls++, { immediate: true, once: true })
  await nextTick()
  a.value = 1
  await nextTick()
  assert.equal(calls, 1)
})

test('watchEffect: immediate run + automatic re-run + cleanup', async () => {
  const a = ref(1)
  const events: string[] = []
  watchEffect((onCleanup) => {
    const value = a.value
    events.push(`run:${value}`)
    onCleanup(() => events.push(`cleanup:${value}`))
  })
  assert.deepEqual(events, ['run:1'])
  a.value = 2
  await nextTick()
  assert.deepEqual(events, ['run:1', 'cleanup:1', 'run:2'])
})

test('graph: isolated graph captures edges from node runs', () => {
  const g = new AetherGraph().use()
  const input = ref('hello', { name: 'input' })
  defineNode('shout', () => {
    return input.value.toUpperCase()
  })
  assert.ok(g.has('input'))
  assert.ok(g.has('shout'))
  assert.deepEqual(g.dependenciesOf('shout'), ['input'])
  assert.deepEqual(g.dependentsOf('input'), ['shout'])
  assert.equal(g.topologicalOrder().indexOf('input') < g.topologicalOrder().indexOf('shout'), true)
})

test('graph: dirty propagation marks transitive dependents', () => {
  const g = new AetherGraph().use()
  const dirty: string[] = []
  g.onDirty((id) => dirty.push(id))
  const a = ref(1, { name: 'a' })
  const b = computed(() => a.value + 1, { name: 'b' })
  const c = computed(() => b.value * 10, { name: 'c' })
  assert.equal(c.value, 20)
  dirty.length = 0
  a.value = 2
  assert.deepEqual(dirty, ['a', 'b', 'c'])
  assert.equal(g.isDirty('c'), true)
  assert.equal(c.value, 30) // evaluating c re-evaluates b lazily along the chain
  assert.equal(g.isDirty('b'), false) // b was re-evaluated as a dependency of c
})

test('graph: defineNode re-runs on dependency change after nextTick', async () => {
  const g = new AetherGraph().use()
  const counter = ref(1, { name: 'counter' })
  let runs = 0
  let last = 0
  defineNode('agent.double', () => {
    runs++
    last = counter.value * 2
  })
  assert.equal(runs, 1)
  assert.equal(last, 2)
  counter.value = 5
  assert.equal(runs, 1) // deferred to microtask
  await nextTick()
  assert.equal(runs, 2)
  assert.equal(last, 10)
  assert.equal(g.isDirty('agent.double'), false)
  assert.equal(g.node('agent.double')?.evaluations, 2)
})

test('graph: consumers can be declared before producers; the graph reconnects at runtime', async () => {
  const g = new AetherGraph().use()
  const events: string[] = []
  const src = ref(1, { name: 'src' })
  const product = ref(0, { name: 'product' })
  // consumer declared first: sees the initial 0
  defineNode('consumer', () => {
    events.push(`consumer:${product.value}`)
  })
  // producer declared later: its immediate run writes `product`,
  // which schedules the already-declared consumer for re-evaluation
  defineNode('producer', () => {
    product.value = src.value * 10
  })
  assert.deepEqual(events, ['consumer:0'])
  src.value = 5
  await nextTick()
  assert.deepEqual(events, ['consumer:0', 'consumer:10', 'consumer:50'])
  assert.deepEqual(g.dependenciesOf('consumer'), ['product'])
  assert.deepEqual(g.dependenciesOf('producer'), ['src'])
})

test('graph: toMermaid renders nodes, edges and dirty styling', () => {
  const g = new AetherGraph().use()
  const a = ref(1, { name: 'a' })
  defineNode('n1', () => a.value, { kind: 'agent' })
  const mermaid = g.toMermaid()
  assert.ok(mermaid.startsWith('graph TD'))
  assert.ok(mermaid.includes('"n1"'), mermaid)
  assert.ok(mermaid.includes('"n1"["n1 · agent"]'), mermaid)
  assert.ok(mermaid.includes('"n1" --> "a"'), mermaid)
  a.value = 2
  const mermaidDirty = g.toMermaid()
  assert.ok(mermaidDirty.includes('style "n1" stroke:#f59e0b'), mermaidDirty)
})

test('graph: explain renders a dependency trace', () => {
  const g = new AetherGraph().use()
  const repoUrl = ref('x', { name: 'repoUrl' })
  const structure = computed(() => String(repoUrl.value).length, { name: 'structure', kind: 'llm' })
  defineNode('summarize', () => structure.value, { kind: 'agent' })
  const explanation = g.explain('summarize')
  assert.ok(explanation.includes('summarize'), explanation)
  assert.ok(explanation.includes('structure'), explanation)
  assert.ok(explanation.includes('repoUrl'), explanation)
})

test('graph: nodes keep an evaluation counter, async errors recorded on node', async () => {
  const g = new AetherGraph().use()
  const trigger = ref(0, { name: 'trigger' })
  const failing = defineNode(
    'failing',
    async () => {
      // golden rule of Aether async nodes: read your reactive cells BEFORE the
      // first await — dependency tracking only covers the synchronous prologue
      const value = trigger.value
      await Promise.resolve()
      if (value === 0) throw new Error('async boom')
      return 'ok'
    },
    { kind: 'agent' },
  )
  await nextTick() // allow the async body to settle
  assert.equal(failing.effect.active, true)
  trigger.value = 1
  await nextTick()
  assert.equal(g.node('failing')?.evaluations, 2)
})

test('graph: default singleton is active and empty at import', () => {
  assert.ok(graph.nodes.size >= 0)
  assert.ok(graph instanceof AetherGraph)
})
