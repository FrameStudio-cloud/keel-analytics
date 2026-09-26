/**
 * @framestudio/keel-analytics
 *
 * Analytics and data-health for Keel storefronts.
 *
 *   import * as analytics from '@framestudio/keel-analytics'
 *   analytics.init({ token: import.meta.env.VITE_KEEL_SITE_TOKEN })
 *
 * After init(), page views and uncaught errors report themselves. You add the
 * two things that actually matter for a shop: what the visitor did, and whether
 * the shop's data is loading.
 *
 *   analytics.track('add_to_cart', { name: 'Chair', quantity: 2 })
 *   analytics.health('catalogue', false, 'request timed out')
 *
 * Design rules this file will not break:
 *
 * 1. The event vocabulary is CLOSED. Anything not in EVENTS is refused locally,
 *    before a request is made. This is the line between a tool and a product
 *    you have to maintain forever.
 * 2. Never throw into the host app. A failed analytics call must not break a
 *    shop's page.
 * 3. Never send customer contact details. A storefront has contact forms and a
 *    chat widget, so track('product_viewed', { name, phone, message }) is the
 *    obvious future mistake. Keys like that are dropped here and again by the
 *    collector, and warned about in development.
 * 4. Health fires on TRANSITIONS only. A shop with a dead catalogue should
 *    produce one event per change of state, not one per page view.
 * 5. Query strings never leave the browser. /shop?email=... and
 *    /shop?token=... would otherwise write customer data into the event table.
 */

export const EVENTS = [
  'page_view',
  'health_ok',
  'health_fail',
  'error',
  'product_viewed',
  'add_to_cart',
  'feature_used',
]

/** Resources the console knows how to show a bar for. */
export const HEALTH_RESOURCES = [
  'settings',
  'catalogue',
  'product',
  'banners',
  'page_content',
]

/** Must match the collector's deny-list. */
const PII_KEY = /(^|_)(phone|email|address|message|notes|note|body|comment|contact)$/i

const MAX_BATCH = 20
const FLUSH_INTERVAL_MS = 30_000
const MAX_QUEUE = 200
const MAX_PROP_STRING = 300

let state = {
  token: null,
  apiBase: null,
  debug: false,
  queue: [],
  health: {},        // resource -> last known ok
  initialised: false,
  timer: null,
  transport: null,   // injected in tests
  lastPath: null,
  appVersion: null,
}

/* ------------------------------------------------------------------ utils */

function now() {
  return Date.now()
}

function isDev() {
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
  } catch {
    return false
  }
}

function warn(...args) {
  if (state.debug || isDev()) console.warn('[keel-analytics]', ...args)
}

/**
 * Strip query string and hash.
 *
 * This is a privacy control, not cosmetics. A catalogue URL can legitimately
 * be /product?name=John&phone=07... or carry a share token, and none of that
 * belongs in an analytics table.
 */
export function cleanPath(input) {
  if (typeof input !== 'string' || !input) return null
  let out = input
  const q = out.search(/[?#]/)
  if (q !== -1) out = out.slice(0, q)
  if (out.length > 300) out = out.slice(0, 300)
  return out || null
}

function scrub(value, depth = 0) {
  if (depth > 4) return undefined
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    return value.length > MAX_PROP_STRING ? value.slice(0, MAX_PROP_STRING) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => scrub(v, depth + 1)).filter((v) => v !== undefined)
  }
  if (typeof value === 'object') {
    const out = {}
    let kept = 0
    for (const [k, v] of Object.entries(value)) {
      if (kept >= 20) break
      if (PII_KEY.test(k)) {
        warn(`dropped "${k}" - customer contact details never leave the browser`)
        continue
      }
      const s = scrub(v, depth + 1)
      if (s !== undefined) {
        out[k] = s
        kept += 1
      }
    }
    return out
  }
  return undefined
}

/* ------------------------------------------------------------- transport */

/**
 * Send over HTTP.
 *
 * `keepalive` rather than `navigator.sendBeacon`, deliberately.
 *
 * sendBeacon looks like the right tool for a flush during page unload - it is
 * the classic "last event" escape hatch - but it CANNOT SET CUSTOM HEADERS. The
 * site token travels in `x-keel-site-token`, so every beacon was a request with
 * no token, the collector answered 401, and sendBeacon had already returned
 * `true` so the SDK reported success. The result was a health bar that stayed
 * empty forever with nothing in any log to explain it. This was found by
 * loading the real site in a real browser, because no test can see a header
 * that was never attached.
 *
 * `fetch(..., { keepalive: true })` survives the page unloading AND carries the
 * header, so it is strictly better here. Payloads are a few hundred bytes, well
 * under the keepalive body limit.
 */
function defaultTransport(events, useBeacon) {
  const url = `${state.apiBase}/api/events`
  const body = JSON.stringify(events)

  if (typeof fetch !== 'function') return
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-keel-site-token': state.token,
    },
    body,
    keepalive: useBeacon,
  })
    .then(async (res) => {
      if (!state.debug && res.ok) return
      const text = await res.text().catch(() => '')
      warn(`collector responded ${res.status}`, text.slice(0, 200))
    })
    .catch((err) => {
      // Deliberately quiet in production. Losing an analytics event must never
      // surface to a shop owner mid-sale - but when debugging, "my data is not
      // showing up" needs an answer, so debug mode surfaces it.
      if (state.debug) warn('collector unreachable:', err?.message || err)
    })
}

/* ---------------------------------------------------------------- queueing */

function enqueue(event) {
  if (!state.initialised) return
  // Omit keys we do not have rather than sending null. The collector accepts
  // null path, but a leaner payload is a smaller thing to get wrong, and it
  // keeps the two sides from disagreeing about what "unknown" looks like.
  if (event.path === null || event.path === undefined) delete event.path
  if (state.queue.length >= MAX_QUEUE) state.queue.shift()
  state.queue.push(event)
  if (state.queue.length >= MAX_BATCH) flush()
}

/** Send whatever is queued. Never throws. */
export function flush() {
  if (!state.initialised || !state.queue.length) return
  const batch = state.queue.splice(0, MAX_BATCH)
  try {
    state.transport(batch, true)
  } catch {
    // transport threw; events are already dequeued, which is intentional -
    // re-queueing a payload the host app rejected would just loop
  }
}

/* ------------------------------------------------------------------- init */

/**
 * @param {object} opts
 * @param {string} opts.token      Site write token (public per-shop credential)
 * @param {string} opts.apiBase    e.g. https://keel-api-37rh.onrender.com
 * @param {boolean} [opts.debug]   Log what is queued and why things are dropped
 * @param {string} [opts.appVersion]
 * @param {boolean} [opts.autoPageView=true] Patch the History API to report
 *   page views. Set false when a site already writes page views somewhere else.
 *
 *   Not a workaround. A site may legitimately serve two audiences from one
 *   storefront: kikoi writes `page_views` for the shop owner's Keel card, and
 *   uses site_events for health. That is a settled decision, not an open
 *   question - two audiences, two tables, one event vocabulary, and neither can
 *   break the other. Turning both on would double-count every navigation, so the
 *   option exists to let a site opt out, not to defer a decision.
 * @param {object} [opts.win]      Injectable window, for tests
 */
export function init(opts = {}) {
  const {
    token,
    apiBase = 'https://keel-api-37rh.onrender.com',
    debug = false,
    appVersion = null,
    autoPageView = true,
    win = typeof window !== 'undefined' ? window : null,
  } = opts

  if (state.initialised) return
  if (!token) {
    warn('init() called without a token - no events will be sent')
    return
  }

  state.token = token
  state.apiBase = String(apiBase).replace(/\/+$/, '')
  state.debug = debug
  state.appVersion = appVersion
  state.transport = opts.transport || defaultTransport
  state.initialised = true

  if (state.debug) warn('initialised against', state.apiBase)

  if (win) {
    if (autoPageView) patchHistory(win)
    watchNavigation(win)
    watchErrors(win)
  }

  state.timer = setInterval(flush, FLUSH_INTERVAL_MS)
  // Do not hold a Node process open just for the flush timer
  if (state.timer && typeof state.timer.unref === 'function') state.timer.unref()
}

/* ------------------------------------------------------- automatic capture */

function patchHistory(win) {
  const fire = () => {
    if (!state.initialised) return
    const p = cleanPath(win.location?.pathname)
    if (p && p !== state.lastPath) {
      state.lastPath = p
      enqueue({ name: 'page_view', path: p, occurred_at: now() })
      if (state.queue.length < MAX_BATCH) flush()
    }
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = win.history?.[method]
    if (typeof original !== 'function') continue
    win.history[method] = function patched(...args) {
      const result = original.apply(this, args)
      // Let the router commit before reading location
      setTimeout(fire, 0)
      return result
    }
  }
  win.addEventListener?.('popstate', fire)
  fire() // the initial page
}

function watchNavigation(win) {
  // last chance to deliver the queue
  const send = () => flush()
  win.addEventListener?.('pagehide', send)
  win.addEventListener?.('beforeunload', send)
  if (win.document) {
    win.document.addEventListener?.('visibilitychange', () => {
      if (win.document.visibilityState === 'hidden') send()
    })
  }
}

function watchErrors(win) {
  win.addEventListener?.('error', (e) => {
    captureError(e?.error || e?.message || 'unknown error', { source: 'window.onerror' })
  })
  win.addEventListener?.('unhandledrejection', (e) => {
    captureError(e?.reason || 'unhandled rejection', { source: 'unhandledrejection' })
  })
}

/* --------------------------------------------------------------- public API */

/**
 * Record a named event. Refuses anything outside the closed vocabulary.
 */
export function track(name, properties = {}) {
  if (!state.initialised) return false
  if (!EVENTS.includes(name)) {
    warn(`"${name}" is not in the event vocabulary - dropped. Allowed: ${EVENTS.join(', ')}`)
    return false
  }
  const scrubbed = scrub(properties) ?? {}
  if (state.appVersion) scrubbed.app_version = state.appVersion
  enqueue({ name, properties: scrubbed, path: cleanPath(currentPath()), occurred_at: now() })
  if (state.queue.length < MAX_BATCH) flush()
  return true
}

/** Record a page view explicitly. Auto-captured already; use for virtual routes. */
export function page(path, properties = {}) {
  if (!state.initialised) return false
  const p = cleanPath(path)
  if (!p) return false
  enqueue({ name: 'page_view', path: p, properties: scrub(properties) ?? {}, occurred_at: now() })
  if (state.queue.length < MAX_BATCH) flush()
  return true
}

/** Record an error. Safe to call from a catch block. */
export function captureError(error, context = {}) {
  if (!state.initialised) return false
  const message =
    error instanceof Error ? error.message
    : typeof error === 'string' ? error
    : (() => { try { return JSON.stringify(error) } catch { return 'unserialisable error' } })()

  enqueue({
    name: 'error',
    path: cleanPath(currentPath()),
    properties: {
      message: String(message).slice(0, MAX_PROP_STRING),
      ...(error?.stack ? { stack: String(error.stack).slice(0, MAX_PROP_STRING) } : {}),
      ...(scrub(context) ?? {}),
    },
    occurred_at: now(),
  })
  if (state.queue.length < MAX_BATCH) flush()
  return true
}

/**
 * Report whether a part of the shop's data is working.
 *
 * Fires only when the state CHANGES, so a catalogue that stays broken across
 * twenty page views produces one health_fail, not twenty. Pass the same status
 * repeatedly and nothing is sent.
 *
 *   analytics.health('catalogue', false, 'request timed out')
 */
export function health(resource, ok, detail) {
  if (!state.initialised) return false
  if (!HEALTH_RESOURCES.includes(resource)) {
    warn(`"${resource}" is not a known health resource. Allowed: ${HEALTH_RESOURCES.join(', ')}`)
    return false
  }
  const previous = state.health[resource]
  if (previous === ok) return false

  state.health[resource] = ok
  enqueue({
    name: ok ? 'health_ok' : 'health_fail',
    path: cleanPath(currentPath()),
    properties: {
      resource,
      ...(detail ? { detail: String(detail).slice(0, MAX_PROP_STRING) } : {}),
      // how long it was in the previous state, so the console can show
      // "broken for 14 minutes" without a second table
      ...(previous === undefined ? {} : { since: now() }),
    },
    occurred_at: now(),
  })
  if (state.queue.length < MAX_BATCH) flush()
  return true
}

function currentPath() {
  if (typeof window === 'undefined') return null
  return window.location?.pathname ?? null
}

/* ------------------------------------------------------------- test hooks */

/** Not part of the public API. Used by the test suite. */
export function __reset() {
  if (state.timer) clearInterval(state.timer)
  state = {
    token: null, apiBase: null, debug: false, queue: [], health: {},
    initialised: false, timer: null, transport: null, lastPath: null,
    appVersion: null,
  }
}

/** Not part of the public API. Used by the test suite. */
export function __state() {
  return state
}
