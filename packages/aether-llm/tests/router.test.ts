import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelRouter } from '../src/router.js'
import type { ChatMessage } from '../src/types.js'

const msg = (content: string): ChatMessage[] => [{ role: 'user', content }]

test('router: trivial and standard tasks use the fast tier', () => {
  const router = new ModelRouter()
  assert.equal(router.pick(msg('hi'), 'trivial'), 'atriadawn')
  assert.equal(router.pick(msg('what is 2+2?')), 'atriadawn')
})

test('router: complex tasks escalate to the strong tier', () => {
  const router = new ModelRouter()
  assert.equal(router.pick(msg('design this'), 'complex'), 'deepseek-v4.1')
  assert.equal(router.pick(msg('请审查这个模块的架构'), 'standard'), 'deepseek-v4.1')
})

test('router: long prompts escalate to the strong tier', () => {
  const router = new ModelRouter({ lengthThreshold: 100 })
  const long = msg('a'.repeat(200))
  assert.equal(router.pick(long), 'deepseek-v4.1')
  assert.equal(router.pick(msg('short')), 'atriadawn')
})

test('router: keyword detection is case-insensitive', () => {
  const router = new ModelRouter()
  assert.equal(router.pick(msg('please REVIEW this diff')), 'deepseek-v4.1')
})

test('router: repeated strong-tier failures degrade to the fast tier', () => {
  const router = new ModelRouter({ fallbackAfter: 2 })
  assert.equal(router.pick(msg('architecture task'), 'complex'), 'deepseek-v4.1')
  router.noteFailure('deepseek-v4.1')
  assert.equal(router.degraded(), false)
  router.noteFailure('deepseek-v4.1')
  assert.equal(router.degraded(), true)
  assert.equal(router.pick(msg('architecture task'), 'complex'), 'atriadawn')
})

test('router: success resets degradation', () => {
  const router = new ModelRouter({ fallbackAfter: 1 })
  router.noteFailure('deepseek-v4.1')
  assert.equal(router.degraded(), true)
  router.noteSuccess('deepseek-v4.1')
  assert.equal(router.degraded(), false)
  assert.equal(router.pick(msg('architecture'), 'complex'), 'deepseek-v4.1')
})

test('router: model ids are configurable', () => {
  const router = new ModelRouter({ fast: 'gpt-4o-mini', strong: 'gpt-4o' })
  assert.equal(router.pick(msg('hi'), 'trivial'), 'gpt-4o-mini')
  assert.equal(router.pick(msg('hi'), 'complex'), 'gpt-4o')
})
