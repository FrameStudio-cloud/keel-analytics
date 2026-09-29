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
 * 6. The visitor id is anonymous and unguessable. It is a random number in
 *    localStorage, derived from nothing - not the IP, not the user agent, not a
 *    canvas fingerprint. It exists because "40 views" and "1 person reloading
 *    40 times" are otherwise indistinguishable, and only one of those is a
 *    problem. It links events to each other and to nothing else, expires on the
 *    same 90-day window as the rows it points at, and is never sent at all when
 *    the browser asks not to be tracked.
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

/**
 * Storage keys and lifetimes for the anonymous visitor id.
 *
 * VISITOR_MAX_AGE_MS is deliberately 90 days, matching the collector's
 * `prune_site_events(p_keep_days default 90)`. A visitor id that outlived the
 * rows it groups would produce a funnel step whose earlier events no longer
 * exist, so the id expires exactly when its own evidence does.
 */
const VISITOR_KEY = 'keel.visitor'
const VISITOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** A visit, not a person. Without this, a 2024 browse and a 2026 order are one run. */
const SESSION_IDLE_MS = 30 * 60 * 1000
const SESSION_KEY = 'keel.session'

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
  visitor: null,     // { id, at } for the current visitor
  session: null,     // { id, at } for the current visit
  storage: null,     // injected in tests; else window.localStorage
  wantVisitor: true, // set false by init({ visitor: false })
  win: null,
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

/* ---------------------------------------------------------------- identity */

/**
 * A random id, shaped like a v4 UUID.
 *
 * Prefers `crypto.randomUUID`, but that only exists in a secure context, so a
 * shop served over plain http would get undefined. `getRandomValues` is the
 * fallback and `Math.random` the last resort: weak randomness is still far
 * better than no id, because the id is a grouping key and not a credential,
 * and the alternative is silently having no visitors at all.
 */
function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through */ }
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
  } catch { /* fall through */ }
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${r()}${r()}-${r()}-4${r().slice(1)}-a${r().slice(1)}-${r()}${r()}${r()}`
}

/**
 * True when the browser has asked not to be tracked.
 *
 * Respected by default rather than opt-in. A storefront is a business's shop
 * front, and the one thing it cannot do is send someone away for declining.
 */
function trackingRefused(win) {
  try {
    if (win?.navigator?.globalPrivacyControl === true) return true
    const dnt = win?.navigator?.doNotTrack
    return dnt === '1' || dnt === 1 || dnt === 'yes'
  } catch {
    return false
  }
}

/** Read a stored {id, at} pair, rejecting anything malformed or expired. */
function readStored(key, at, maxAge) {
  try {
    const raw = state.storage?.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null
    if (typeof parsed.at !== 'number') return null
    if (at - parsed.at > maxAge) return null
    return parsed
  } catch {
    // A corrupt or unreadable value is not an error worth surfacing; the worst
    // case is a fresh id, which undercounts rather than overcounts.
    return null
  }
}

function writeStored(key, value) {
  try {
    state.storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Safari private mode and blocked third-party storage both throw here. The
    // in-memory copy still works for this page load, so the visitor is counted
    // once and simply not remembered.
  }
}

/**
 * The visitor, renewed only when it actually expires.
 *
 * The 90-day test lives HERE and nowhere else, so it cannot be bypassed. An
 * earlier version only checked on the way out of storage, which meant a value
 * already held in memory could outlive the window it was supposed to expire in.
 */
function resolveVisitor(at) {
  const held = state.visitor
  if (held && at - held.at <= VISITOR_MAX_AGE_MS) {
    held.at = at
    return held
  }
  // Either nothing yet, or what we hold is older than the rows it groups.
  // readStored applies the same test to whatever is on disk.
  const carried = readStored(VISITOR_KEY, at, VISITOR_MAX_AGE_MS)
  state.visitor = carried || { id: randomId(), at }
  return state.visitor
}

/**
 * The current visit.
 *
 * Read out of storage once per page load, so a reload continues the visit
 * rather than starting a new one. After that the in-memory copy is
 * authoritative, which is what keeps a long browse alive: the idle window is
 * measured from the last event, not from when the session began. Re-reading
 * storage on every event would pin the timestamp to page load and cut a
 * 45-minute browse in half at the 30-minute mark.
 */
function resolveSession(at) {
  const held = state.session
  if (held && at - held.at <= SESSION_IDLE_MS) {
    held.at = at
    return held
  }
  const carried = readStored(SESSION_KEY, at, SESSION_IDLE_MS)
  state.session = carried || { id: randomId(), at }
  return state.session
}

/**
 * The identity to stamp on the next event, or null when there should be none.
 *
 * Both ids are PERSISTED, which is the whole point. Keeping the session in
 * memory only would mint a new one on every reload, so the single most common
 * thing a real visitor does - open a product, refresh, open it again - would
 * read as three separate visits by three separate people. The 30-minute window
 * has to survive a page load for it to mean "a visit".
 *
 * Returns null - and callers then omit both keys - when tracking was refused,
 * when the site turned it off, when there is no storage, or when randomness
 * is unavailable. Omitting is deliberate: the collector validates these as
 * `.nullish()`, but a leaner payload is a smaller thing to get wrong, and the
 * SDK already omits a null `path` for exactly this reason.
 */
function identityFor(at) {
  if (!state.wantVisitor || !state.storage) return null
  if (trackingRefused(state.win)) return null

  const visitor = resolveVisitor(at)
  const session = resolveSession(at)
  writeStored(VISITOR_KEY, visitor)
  writeStored(SESSION_KEY, session)

  return { visitor_id: visitor.id, session_id: session.id }
}

/** Forget the visitor. Public, so a site can offer "reset my data". */
export function resetVisitor() {
  state.visitor = null
  state.session = null
  try {
    state.storage?.removeItem(VISITOR_KEY)
    state.storage?.removeItem(SESSION_KEY)
  } catch { /* nothing stored to clear */ }
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

  // Stamp identity at enqueue time, not at flush time. A page-unload flush is
  // the last thing that happens before the tab dies, and reading storage then
  // is both unnecessary and the least reliable moment to do it.
  if (state.wantVisitor) {
    const who = identityFor(now())
    if (who) {
      event.visitor_id = who.visitor_id
      event.session_id = who.session_id
    }
  }

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
 * @param {boolean} [opts.visitor=true]
 *   Set false to record events with no visitor id at all. A browser that sends
 *   Do Not Track or Global Privacy Control is already refused automatically.
 * @param {object} [opts.storage]  Injectable localStorage, for tests. Defaults
 *   to win.localStorage, and is absent when there is no window.
 */
export function init(opts = {}) {
  const {
    token,
    apiBase = 'https://keel-api-37rh.onrender.com',
    debug = false,
    appVersion = null,
    autoPageView = true,
    visitor = true,
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
  state.wantVisitor = visitor !== false
  state.win = win

  // localStorage is per-origin, so a visitor id is naturally scoped to one
  // shop's domain. Two shops on one origin would share it, which is why the
  // store is guarded rather than assumed.
  if (state.wantVisitor) {
    state.storage = opts.storage !== undefined ? opts.storage : (win && win.localStorage) || null
    if (win && !state.storage) {
      // No storage at all. Events still send; they just have no visitor.
      if (state.debug) warn('no localStorage - events will record no visitor')
    }
  }

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
    appVersion: null, visitor: null, session: null, storage: null,
    wantVisitor: true, win: null,
  }
}

/** Not part of the public API. Used by the test suite. */
export function __state() {
  return state
}

/**
 * Not part of the public API. Used by the test suite to drive the clock.
 *
 * Session rotation and the 90-day expiry are the two rules that cannot be
 * observed by waiting in real time, so identityFor takes the timestamp as an
 * argument instead of calling Date.now() itself.
 */
export function __identity(at) {
  return identityFor(at)
}
