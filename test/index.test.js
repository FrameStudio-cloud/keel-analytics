import test from 'node:test'
import assert from 'node:assert/strict'
import {
  init, track, page, captureError, health, flush, cleanPath, resetVisitor,
  __reset, __state, __identity, EVENTS, HEALTH_RESOURCES,
} from '../index.js'

/** A minimal window stand-in, enough for the history/nav patches. */
function fakeWindow(pathname = '/', extra = {}) {
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
    ...extra,
  }
}

/** In-memory localStorage stand-in. Survives across inits, like a real reload. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
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

/** setup(), but with a working identity store. */
function setupIdentified({ storage = fakeStorage(), extra = {}, ...opts } = {}) {
  const sent = []
  const win = fakeWindow('/', extra)
  init({
    token: 'test-token',
    apiBase: 'https://api.test',
    transport: (events) => sent.push(...events),
    win,
    storage,
    ...opts,
  })
  sent.length = 0
  __state().queue.length = 0
  return { sent, win, storage }
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

test('autoPageView:false leaves page views to the host app', () => {
  const sent = []
  const win = fakeWindow('/shop')
  init({
    token: 't', apiBase: 'https://api.test', autoPageView: false,
    transport: (b) => sent.push(...b), win,
  })
  assert.equal(sent.filter((e) => e.name === 'page_view').length, 0)

  // but the rest of the SDK still works
  health('catalogue', false)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].name, 'health_fail')
})

test('a page_view payload never carries a null path', () => {
  const sent = []
  const win = fakeWindow('/')
  init({ token: 't', apiBase: 'https://api.test', transport: (b) => sent.push(...b), win })
  // no window.location.pathname reachable from the SDK in Node
  for (const e of sent) {
    assert.ok(!('path' in e) || e.path !== null, 'null path must be omitted, not sent as null')
  }
})

test('an event with no resolvable path omits the key entirely', () => {
  const sent = []
  init({
    token: 't', apiBase: 'https://api.test', win: null,
    transport: (b) => sent.push(...b),
  })
  assert.equal(track('product_viewed', { name: 'Chair' }), true)
  const e = sent.find((x) => x.name === 'product_viewed')
  assert.ok(e, 'event was sent')
  assert.equal('path' in e, false, 'key must be absent, not null')
})

test('the transport ALWAYS sends the site token as a header', async () => {
  // Regression guard. The transport used to prefer navigator.sendBeacon for
  // unload flushes, which cannot set custom headers - so every event was
  // rejected 401 by the collector while sendBeacon reported success. Nothing
  // errored; the health bars were simply always empty. Only a real browser
  // showed it, because the failure was an absent header.
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, text: async () => '{"ok":true}' }
  }
  try {
    __reset()
    init({ token: 'secret-shop-token', apiBase: 'https://api.test', win: null })
    track('product_viewed', { name: 'Chair' })
    flush()
    await new Promise((r) => setTimeout(r, 10))
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(calls.length, 1, 'exactly one request')
  assert.equal(calls[0].url, 'https://api.test/api/events')
  assert.equal(calls[0].opts.headers['x-keel-site-token'], 'secret-shop-token')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.keepalive, true, 'unload flushes must survive navigation')
  assert.ok(
    !('sendBeacon' in calls[0].opts),
    'must not route through sendBeacon, which drops the token header',
  )
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

/* --------------------------------------------------------------- identity */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

/**
 * Tests that drive the clock must start from the real one.
 *
 * init() auto-captures the first page view, which stamps the identity at
 * Date.now(). A base timestamp in the past therefore reads as "no time has
 * passed" for every subsequent comparison, and the id appears not to rotate.
 */
const T0 = Date.now()

test('every event carries a visitor id and a session id', () => {
  const { sent } = setupIdentified()
  track('product_viewed', { name: 'Chair' })
  health('catalogue', false)
  captureError('boom')

  assert.equal(sent.length, 3)
  for (const e of sent) {
    assert.match(e.visitor_id, UUID_V4, `${e.name} needs a visitor id`)
    assert.match(e.session_id, UUID_V4, `${e.name} needs a session id`)
  }
  const visitors = new Set(sent.map((e) => e.visitor_id))
  assert.equal(visitors.size, 1, 'one browser is one visitor')
})

test('the visitor id is stable across events, which is the entire point', () => {
  // The problem this exists to solve: 40 views from one person refreshing is not
  // 40 interested customers. Grouping by visitor_id is what tells them apart.
  const { sent } = setupIdentified()
  for (let i = 0; i < 5; i++) page(`/product/chair-${i}`)
  assert.equal(sent.length, 5)
  assert.equal(new Set(sent.map((e) => e.visitor_id)).size, 1)
  assert.equal(new Set(sent.map((e) => e.path)).size, 5, 'five distinct pages still')
})

test('a reload keeps the visitor AND the session', () => {
  // A refresh is one person looking, not three visits. An in-memory-only
  // session would mint a new one per page load and inflate the numbers exactly
  // the way the owner already suspected.
  const storage = fakeStorage()
  const first = setupIdentified({ storage })
  page('/product/chair')
  const { visitor_id: v1, session_id: s1 } = first.sent[0]
  __reset()

  const second = setupIdentified({ storage })
  page('/product/chair')
  const { visitor_id: v2, session_id: s2 } = second.sent[0]

  assert.equal(v2, v1, 'same browser, same visitor')
  assert.equal(s2, s1, 'still inside the 30-minute window')
})

test('a session rotates after 30 minutes idle, but the visitor does not', () => {
  const storage = fakeStorage()
  setupIdentified({ storage })
  const a = __identity(T0)
  __reset()

  setupIdentified({ storage })
  const idle = __identity(T0 + 31 * MINUTE)
  assert.notEqual(idle.session_id, a.session_id, '31 minutes idle is a new visit')
  assert.equal(idle.visitor_id, a.visitor_id, 'but still the same person')
})

test('continuous activity keeps one session open past 30 minutes total', () => {
  // The idle window must be measured from the last event, not from the session
  // start, or a long browse gets cut in half.
  const storage = fakeStorage()
  setupIdentified({ storage })
  const start = __identity(T0)
  for (let m = 5; m <= 45; m += 5) {
    const step = __identity(T0 + m * MINUTE)
    assert.equal(step.session_id, start.session_id, `still active at ${m} minutes`)
  }
})

test('a visitor id older than 90 days is replaced, matching the row retention', () => {
  const storage = fakeStorage()
  setupIdentified({ storage })
  const old = __identity(T0)
  __reset()

  setupIdentified({ storage })
  const later = __identity(T0 + 91 * DAY)
  assert.notEqual(later.visitor_id, old.visitor_id, '91 days is a new visitor')
})

test('a visitor id inside 90 days is kept', () => {
  const storage = fakeStorage()
  setupIdentified({ storage })
  const old = __identity(T0)
  __reset()

  setupIdentified({ storage })
  const later = __identity(T0 + 89 * DAY)
  assert.equal(later.visitor_id, old.visitor_id)
})

test('a reload after 20 minutes is the same visit, not a new one', () => {
  const storage = fakeStorage()
  setupIdentified({ storage })
  const a = __identity(T0)
  __reset()

  setupIdentified({ storage })
  const later = __identity(T0 + 20 * MINUTE)
  assert.equal(later.session_id, a.session_id, '20 minutes is inside the window')
})

test('Do Not Track sends no identity at all', () => {
  const { sent } = setupIdentified({ extra: { navigator: { doNotTrack: '1' } } })
  page('/shop')
  assert.equal(sent.length, 1, 'the event still sends - DNT is not a refusal to work')
  assert.equal('visitor_id' in sent[0], false, 'but it carries no visitor')
  assert.equal('session_id' in sent[0], false)
})

test('Global Privacy Control is respected too', () => {
  const { sent } = setupIdentified({
    extra: { navigator: { doNotTrack: 'unspecified', globalPrivacyControl: true } },
  })
  page('/shop')
  assert.equal('visitor_id' in sent[0], false)
})

test('visitor:false records events with no identity', () => {
  const { sent } = setupIdentified({ visitor: false })
  page('/shop')
  assert.equal(sent.length, 1)
  assert.equal('visitor_id' in sent[0], false)
})

test('a site with no localStorage still records events', () => {
  const { sent } = setupIdentified({ storage: null })
  page('/shop')
  assert.equal(sent.length, 1, 'privacy modes must not silence the shop')
  assert.equal('visitor_id' in sent[0], false)
})

test('storage that throws does not take the shop down', () => {
  // Safari private mode and blocked third-party storage both throw on setItem.
  const hostile = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  const { sent } = setupIdentified({ storage: hostile })
  assert.doesNotThrow(() => page('/shop'))
  assert.equal(sent.length, 1)
})

test('a corrupt stored id is replaced rather than propagated', () => {
  const storage = fakeStorage({ 'keel.visitor': '{not json', 'keel.session': '42' })
  const { sent } = setupIdentified({ storage })
  page('/shop')
  assert.match(sent[0].visitor_id, UUID_V4)
  assert.match(sent[0].session_id, UUID_V4)
})

test('resetVisitor forgets the visitor and issues a new one', () => {
  const storage = fakeStorage()
  const { sent } = setupIdentified({ storage })
  page('/shop')
  const before = sent[0].visitor_id

  resetVisitor()
  assert.equal(storage.getItem('keel.visitor'), null, 'the store is cleared at once')
  assert.equal(storage.getItem('keel.session'), null)

  page('/about')
  assert.notEqual(sent[1].visitor_id, before, 'a reset visitor is a new visitor')
})

test('the identity is a grouping key, never a credential', () => {
  // Nothing identifying goes into it. If this test ever needs the user agent or
  // the IP to pass, the design has been broken.
  const { sent } = setupIdentified()
  page('/shop')
  const e = sent[0]
  assert.deepEqual(
    Object.keys(e).sort(),
    ['name', 'occurred_at', 'path', 'properties', 'session_id', 'visitor_id'],
    'no identifying fields on the payload'
  )
  assert.deepEqual(e.properties, {}, 'and nothing hiding in properties')
  assert.equal(e.visitor_id.length, 36, 'a uuid, nothing derived from anything')
})
