import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AetherGraph,
  EffectScope,
  computed,
  effect,
  isReactive,
  isRef,
  markRaw,
  onScopeDispose,
  pauseTracking,
  reactive,
  ref,
  resumeTracking,
  shallowRef,
  toRaw,
  toValue,
  triggerRef,
  unref,
  batch,
} from '../src/index.js'

test('ref: holds value, is tracked by effects', () => {
  const a = ref(1)
  let dummy = 0
  effect(() => {
    dummy = a.value
  })
  assert.equal(dummy, 1)
  a.value = 2
  assert.equal(dummy, 2)
})

test('ref: same value does not trigger', () => {
  const a = ref(1)
  let runs = 0
  effect(() => {
    a.value
    runs++
  })
  assert.equal(runs, 1)
  a.value = 1
  assert.equal(runs, 1)
  a.value = 2
  assert.equal(runs, 2)
})

test('ref: object values become deeply reactive', () => {
  const a = ref({ nested: { count: 0 } })
  assert.ok(isReactive(a.value))
  let dummy = 0
  effect(() => {
    dummy = a.value.nested.count
  })
  a.value.nested.count = 5
  assert.equal(dummy, 5)
})

test('shallowRef: keeps raw objects; triggerRef forces notification', () => {
  const a = shallowRef({ foo: 1 })
  assert.ok(!isReactive(a.value))
  let runs = 0
  effect(() => {
    a.value
    runs++
  })
  a.value.foo = 2 // not tracked (shallow)
  assert.equal(runs, 1)
  triggerRef(a)
  assert.equal(runs, 2)
})

test('ref helpers: isRef / unref / toValue', () => {
  const a = ref(1)
  assert.equal(isRef(a), true)
  assert.equal(isRef(1), false)
  assert.equal(unref(a), 1)
  assert.equal(unref(2), 2)
  assert.equal(toValue(() => 3), 3)
  assert.equal(toValue(a), 1)
})

test('reactive: independent keys are tracked independently', () => {
  const obj = reactive({ foo: 1, bar: 'x' })
  let dummyFoo = 0
  let dummyBar = ''
  effect(() => {
    dummyFoo = obj.foo
  })
  effect(() => {
    dummyBar = obj.bar
  })
  obj.foo = 10
  assert.equal(dummyFoo, 10)
  assert.equal(dummyBar, 'x')
  obj.bar = 'y'
  assert.equal(dummyBar, 'y')
})

test('reactive: nested objects become reactive on read', () => {
  const obj = reactive({ nested: { count: 0 } })
  assert.ok(isReactive(obj.nested))
  let dummy = 0
  effect(() => {
    dummy = obj.nested.count
  })
  obj.nested.count = 42
  assert.equal(dummy, 42)
})

test('reactive: delete triggers subscribers', () => {
  const obj = reactive({ foo: 1 } as Record<string, number | undefined>)
  let dummy: number | undefined = 0
  effect(() => {
    dummy = obj.foo
  })
  delete obj.foo
  assert.equal(dummy, undefined)
})

test('reactive: iterate (ownKeys / Object.keys) is tracked', () => {
  const obj: Record<string, number> = reactive({ a: 1 })
  let keyCount = 0
  effect(() => {
    keyCount = Object.keys(obj).length
  })
  obj.b = 2
  assert.equal(keyCount, 2)
  delete obj.b
  assert.equal(keyCount, 1)
})

test('reactive: has operator is tracked', () => {
  const obj: Record<string, number> = reactive({})
  let exists = false
  effect(() => {
    exists = 'a' in obj
  })
  obj.a = 1
  assert.equal(exists, true)
  delete obj.a
  assert.equal(exists, false)
})

test('reactive: identity helpers (isProxy / toRaw / markRaw / caching)', () => {
  const raw = { foo: 1 }
  const obj = reactive(raw)
  assert.ok(isReactive(obj))
  assert.ok(!isReactive(raw))
  assert.equal(toRaw(obj), raw)
  const skipped = markRaw({ bar: 2 })
  assert.equal(reactive(skipped), skipped)
  const sameProxy = reactive(raw)
  assert.equal(sameProxy, obj)
})

test('reactive: a named object surfaces each key in the graph', () => {
  const g = new AetherGraph().use()
  const ctx = reactive({ repo: 'a/b', stars: 0 }, { name: 'ctx' })
  assert.ok(g.has('ctx'))
  void ctx
  ctx.repo = 'c/d'
  assert.equal(g.isDirty('ctx.repo'), true)
})

test('computed: lazy + cached, invalidates on change', () => {
  const a = ref(1)
  let computes = 0
  const doubled = computed(() => {
    computes++
    return a.value * 2
  })
  assert.equal(computes, 0) // not evaluated until read
  assert.equal(doubled.value, 2)
  assert.equal(doubled.value, 2) // cached
  assert.equal(computes, 1)
  a.value = 3
  assert.equal(doubled.value, 6) // re-evaluated on demand
  assert.equal(computes, 2)
})

test('computed: chains invalidate transitively', () => {
  const a = ref(1)
  const b = computed(() => a.value + 1)
  const c = computed(() => b.value * 10)
  assert.equal(c.value, 20)
  a.value = 2
  assert.equal(b.value, 3)
  assert.equal(c.value, 30)
})

test('computed: writable computed', () => {
  const base = ref(10)
  const writable = computed({
    get: () => base.value,
    set: (v: number) => {
      base.value = v * 2
    },
  })
  ;(writable as any).value = 6 // ComputedRef.value is typed readonly; write through to verify the setter
  assert.equal(base.value, 12)
  assert.equal(writable.value, 12)
})

test('effect: conditional branches do not leave stale subscriptions', () => {
  const flag = ref(true)
  const left = ref('L1')
  const right = ref('R1')
  let dummy = ''
  effect(() => {
    dummy = flag.value ? left.value : right.value
  })
  assert.equal(dummy, 'L1')
  flag.value = false
  assert.equal(dummy, 'R1')
  left.value = 'L2' // no longer subscribed after branch switch
  assert.equal(dummy, 'R1')
  right.value = 'R2'
  assert.equal(dummy, 'R2')
})

test('effect: stop detaches from dependencies', () => {
  const a = ref(1)
  let dummy = 0
  const e = effect(() => {
    dummy = a.value
  })
  e.stop()
  a.value = 9
  assert.equal(dummy, 1)
})

test('pauseTracking / resumeTracking gate dependency collection', () => {
  const a = ref(1)
  let dummy = 0
  effect(() => {
    pauseTracking()
    dummy = a.value
    resumeTracking()
  })
  assert.equal(dummy, 1)
  a.value = 5
  assert.equal(dummy, 1) // read happened while tracking was paused
})

test('batch: multiple mutations collapse into one run', () => {
  const a = ref(1)
  const b = ref(1)
  let runs = 0
  effect(() => {
    a.value
    b.value
    runs++
  })
  assert.equal(runs, 1)
  batch(() => {
    a.value = 2
    b.value = 2
    a.value = 3
  })
  assert.equal(runs, 2)
})

test('scope: stop kills every nested effect and runs disposables', () => {
  const a = ref(1)
  let dummy = 0
  let disposed = 0
  const scope = new EffectScope()
  scope.run(() => {
    onScopeDispose(() => disposed++)
    effect(() => {
      dummy = a.value
    })
  })
  a.value = 2
  assert.equal(dummy, 2)
  scope.stop()
  a.value = 3
  assert.equal(dummy, 2) // stopped
  assert.equal(disposed, 1)
})
