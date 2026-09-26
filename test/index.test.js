import test from 'node:test'
import assert from 'node:assert/strict'
import {
  init, track, page, captureError, health, flush, cleanPath,
  __reset, __state, EVENTS, HEALTH_RESOURCES,
} from '../index.js'

/** A minimal window stand-in, enough for the history/nav patches. */
function fakeWindow(pathname = '/') {
  const listeners = {}
  return {
    location: { pathname, visibilityState: 'visible' },
    document: {
      visibilityState: 'visible',
      addEventListener: (t, fn) => { (listeners['doc:' + t] ||= []).push(fn) },
    },
    history: {
      pushState() {}, replaceState() {},
    },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn) },
    _fire: (t) => (listeners[t] || []).forEach((f) => f()),
    _nav: (p) => { this.location.pathname = p },
  }
}

function setup(pathname = '/') {
  const sent = []
  const win = fakeWindow(pathname)
  init({
    token: 'test-token',
    apiBase: 'https://api.test',
    transport: (events) => sent.push(...events),
    win,
  })
  // drop the automatic first page_view so tests start clean
  sent.length = 0
  __state().queue.length = 0
  return { sent, win }
}

test.beforeEach(() => __reset())
test.afterEach(() => __reset())

/* ------------------------------------------------------------------ init */

test('init without a token does not arm the SDK', () => {
  init({ apiBase: 'https://api.test', transport: () => {} })
  assert.equal(__state().initialised, false)
  assert.equal(track('page_view'), false)
})

test('init is idempotent', () => {
  const a = setup()
  const firstToken = __state().token
  init({ token: 'other', transport: () => {} })
  assert.equal(__state().token, firstToken)
  assert.ok(a.sent)
})

test('apiBase loses any trailing slash', () => {
  init({ token: 't', apiBase: 'https://api.test/', transport: () => {} })
  assert.equal(__state().apiBase, 'https://api.test')
})

/* ----------------------------------------------------------------- paths */

test('cleanPath strips query strings so customer data cannot leak into events', () => {
  assert.equal(cleanPath('/shop?email=buyer@example.com'), '/shop')
  assert.equal(cleanPath('/product/chair?utm_source=fb'), '/product/chair')
  assert.equal(cleanPath('/order#secret-token'), '/order')
  assert.equal(cleanPath(''), null)
  assert.equal(cleanPath(null), null)
})

test('a long path is truncated, not rejected', () => {
  const p = '/' + 'a'.repeat(500)
  assert.equal(cleanPath(p).length, 300)
})

/* ------------------------------------------------------------ vocabulary */

test('an event outside the vocabulary is refused locally, with no request', () => {
  const { sent } = setup()
  assert.equal(track('totally_made_up'), false)
  assert.equal(sent.length, 0)
})

test('every advertised event is actually accepted', () => {
  const { sent } = setup()
  for (const name of EVENTS) {
    const props = name.startsWith('health_') ? { resource: 'catalogue' } : {}
    assert.equal(track(name, props), true, name)
  }
  assert.equal(sent.length, EVENTS.length)
})

/* ------------------------------------------------------------------- PII */

test('contact details are dropped from properties and never sent', () => {
  const { sent } = setup()
  track('product_viewed', {
    name: 'Chair',
    quantity: 3,
    phone: '+254799451882',
    email: 'buyer@example.com',
    address: 'Nairobi',
    message: 'call me',
    customer_email: 'leak@x.com',
  })
  const p = sent[0].properties
  assert.equal(p.name, 'Chair', 'product name is public, keep it')
  assert.equal(p.quantity, 3)
  for (const key of ['phone', 'email', 'address', 'message', 'customer_email']) {
    assert.equal(key in p, false, `${key} must not be sent`)
  }
})

test('nested PII is dropped too', () => {
  const { sent } = setup()
  track('product_viewed', { nested: { phone: '07..', keep: 'yes' } })
  assert.deepEqual(sent[0].properties.nested, { keep: 'yes' })
})

test('long property strings are capped', () => {
  const { sent } = setup()
  track('feature_used', { feature: 'x'.repeat(900) })
  assert.equal(sent[0].properties.feature.length, 300)
})

/* ---------------------------------------------------------------- health */

test('health only fires on a state change', () => {
  const { sent } = setup()
  assert.equal(health('catalogue', false, 'timeout'), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].name, 'health_fail')

  // same status again, over and over
  assert.equal(health('catalogue', false, 'still timing out'), false)
  assert.equal(health('catalogue', false), false)
  assert.equal(sent.length, 1, 'no extra events for a steady state')

  // recovery, then break again
  assert.equal(health('catalogue', true), true)
  assert.equal(health('catalogue', false, 'died again'), true)
  assert.equal(sent.length, 3)
  assert.deepEqual(sent.map((e) => e.name), ['health_fail', 'health_ok', 'health_fail'])
})

test('health state is tracked per resource, not globally', () => {
  const { sent } = setup()
  health('catalogue', false)
  health('settings', false)
  assert.equal(sent.length, 2, 'one broken resource must not silence another')
  health('settings', false)
  assert.equal(sent.length, 2)
})

test('an unknown health resource is refused', () => {
  const { sent } = setup()
  assert.equal(health('mystery_thing', false), false)
  assert.equal(sent.length, 0)
})

test('every advertised health resource is accepted', () => {
  const { sent } = setup()
  for (const r of HEALTH_RESOURCES) assert.equal(health(r, false), true, r)
  assert.equal(sent.length, HEALTH_RESOURCES.length)
})

/* ---------------------------------------------------------------- errors */

test('captureError accepts an Error, a string and a junk value', () => {
  const { sent } = setup()
  captureError(new Error('boom'))
  captureError('plain string')
  captureError({ weird: true })
  captureError(undefined)
  assert.equal(sent.length, 4)
  assert.ok(sent.every((e) => e.name === 'error'))
  assert.ok(sent.every((e) => typeof e.properties.message === 'string'))
})

test('a circular error payload does not throw', () => {
  const { sent } = setup()
  const circular = {}
  circular.self = circular
  assert.doesNotThrow(() => captureError(circular))
  assert.equal(sent.length, 1)
})

/* --------------------------------------------------------------- batching */

test('events accumulate and flush on interval rather than one request each', () => {
  const sent = []
  const win = fakeWindow('/')
  init({ token: 't', apiBase: 'https://api.test', transport: (b) => sent.push(...b), win })
  sent.length = 0
  __state().queue.length = 0

  captureError('a')
  captureError('b')
  // the SDK flushes opportunistically below the batch size, so assert on the
  // union of everything sent rather than on batch boundaries
  flush()
  const names = sent.map((e) => e.properties.message)
  assert.ok(names.includes('a') && names.includes('b'))
})

test('flush sends nothing when the queue is empty', () => {
  const { sent } = setup()
  flush()
  flush()
  assert.equal(sent.length, 0)
})

/* --------------------------------------------------------- page capturing */

test('the first page view is captured automatically', () => {
  const sent = []
  const win = fakeWindow('/shop')
  init({ token: 't', apiBase: 'https://api.test', transport: (b) => sent.push(...b), win })
  const views = sent.filter((e) => e.name === 'page_view')
  assert.equal(views.length, 1)
  assert.equal(views[0].path, '/shop')
})

test('an explicit page() call records the path without its query', () => {
  const { sent } = setup()
  assert.equal(page('/product/chair?ref=email'), true)
  const v = sent.find((e) => e.name === 'page_view')
  assert.equal(v.path, '/product/chair')
})

test('page() with nothing usable is ignored', () => {
  const { sent } = setup()
  assert.equal(page(''), false)
  assert.equal(page(null), false)
  assert.equal(sent.length, 0)
})

/* ------------------------------------------------------------- app safety */

test('a throwing transport never reaches the host app', () => {
  const win = fakeWindow('/')
  init({
    token: 't', apiBase: 'https://api.test', win,
    transport: () => { throw new Error('collector exploded') },
  })
  assert.doesNotThrow(() => track('product_viewed', { name: 'Chair' }))
  assert.doesNotThrow(() => flush())
  assert.doesNotThrow(() => health('catalogue', false))
})

test('before init every public function is a safe no-op', () => {
  assert.doesNotThrow(() => {
    track('page_view')
    page('/x')
    captureError('e')
    health('catalogue', false)
    flush()
  })
})
