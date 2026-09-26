/**
 * Build a fixture for the visual check.
 *
 * Live-first: if the database has real sites with real events, capture those.
 * Otherwise synthesise a realistic spread, because the console needs to be seen
 * in all three states — healthy, broken, silent — and production currently has
 * exactly one site with no events (the SDK is not deployed to kikoi yet).
 *
 * Synthesised data is never written to the database. The visual check
 * intercepts the RPCs in the browser, so production stays untouched.
 */
import fs from 'node:fs'
import path from 'node:path'

const env = {}
for (const line of fs.readFileSync('C:/Users/Administrator/projects/framestudio/framestudio-dashboard/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const url = env.VITE_KEEL_SUPABASE_URL
const key = env.VITE_KEEL_SUPABASE_ANON_KEY
const token = env.VITE_KEEL_DOCS_ADMIN_TOKEN

async function rpc(fn, args) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, p_token: token }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${fn} -> ${res.status} ${body.slice(0, 300)}`)
  return JSON.parse(body)
}

const vocabulary = await rpc('admin_site_vocabulary', {})
const liveSites = await rpc('admin_sites', { p_hours: 24 })
const liveHasData = liveSites.some((s) => (s.summary?.events ?? 0) > 0)

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString()
const health = (entries) => Object.fromEntries(
  Object.entries(entries).map(([k, [state, mins, detail]]) => [
    k, { state, at: iso(mins), detail: detail ?? null },
  ]),
)

/** Three states, so the lamp strip and the filters can all be seen working. */
function synthesise() {
  const sites = [
    {
      site_id: 'a1111111-1111-4111-8111-111111111111',
      shop_id: 's1111111-1111-4111-8111-111111111111',
      shop_name: 'Kikoi', name: 'Kikoi', url: 'https://kikoi-opal.vercel.app/',
      kind: 'catalogue', active: true, created_at: iso(60 * 24 * 40),
      summary: {
        health: health({
          settings: ['ok', 6], catalogue: ['ok', 6], product: ['ok', 9],
          banners: ['ok', 22], page_content: ['ok', 22],
        }),
        broken: 0, last_event_at: iso(6), events: 148, errors: 0, failures: 0,
        page_views: 96, commerce: 31, feature_uses: 21, attributed: true,
      },
    },
    {
      site_id: 'a2222222-2222-4222-8222-222222222222',
      shop_id: 's2222222-2222-4222-8222-222222222222',
      shop_name: 'Zuri Fashion', name: 'Zuri Fashion', url: 'https://zuri.vercel.app/',
      kind: 'catalogue', active: true, created_at: iso(60 * 24 * 12),
      summary: {
        health: health({
          settings: ['ok', 51], catalogue: ['fail', 44, 'API error: 500'],
          product: ['fail', 41, 'API error: 500'], banners: ['ok', 51], page_content: ['ok', 51],
        }),
        broken: 2, last_event_at: iso(19), events: 61, errors: 4, failures: 2,
        page_views: 44, commerce: 6, feature_uses: 7, attributed: true,
      },
    },
    {
      site_id: 'a3333333-3333-4333-8333-333333333333',
      shop_id: 's3333333-3333-4333-8333-333333333333',
      shop_name: 'Clamzy', name: 'Clamzy', url: 'https://clamzy.vercel.app/',
      kind: 'catalogue', active: true, created_at: iso(60 * 24 * 6),
      summary: {
        health: health({ settings: ['ok', 40] }),
        broken: 0, last_event_at: iso(40), events: 3, errors: 0, failures: 0,
        page_views: 3, commerce: 0, feature_uses: 0, attributed: true,
      },
    },
    {
      site_id: 'a4444444-4444-4444-8444-444444444444',
      shop_id: 's4444444-4444-4444-8444-444444444444',
      shop_name: 'Tumaini Grocers', name: 'Tumaini Grocers', url: '',
      kind: 'catalogue', active: true, created_at: iso(60 * 24 * 2),
      summary: {
        health: {}, broken: 0, last_event_at: null, events: 0, errors: 0, failures: 0,
        page_views: 0, commerce: 0, feature_uses: 0, attributed: true,
      },
    },
  ]

  const events = [
    { occurred_at: iso(6), name: 'health_ok', properties: { resource: 'catalogue' }, path: '/shop' },
    { occurred_at: iso(6), name: 'health_ok', properties: { resource: 'settings' }, path: '/' },
    { occurred_at: iso(19), name: 'health_fail', properties: { resource: 'catalogue', detail: 'API error: 500' }, path: '/shop' },
    { occurred_at: iso(20), name: 'error', properties: { message: 'TypeError: Cannot read properties of null (reading "map")' }, path: '/shop' },
    { occurred_at: iso(28), name: 'page_view', properties: {}, path: '/product/iphone-16' },
    { occurred_at: iso(31), name: 'product_viewed', properties: { name: 'iphone 16' }, path: '/product/iphone-16' },
    { occurred_at: iso(34), name: 'add_to_cart', properties: { name: 'AirPods Pro', quantity: 1 }, path: '/product/airpods' },
    { occurred_at: iso(41), name: 'health_fail', properties: { resource: 'product', detail: 'API error: 500' }, path: '/product/2' },
    { occurred_at: iso(44), name: 'health_fail', properties: { resource: 'catalogue', detail: 'API error: 500' }, path: '/shop' },
    { occurred_at: iso(52), name: 'feature_used', properties: { feature: 'back_to_top' }, path: '/shop' },
    { occurred_at: iso(96), name: 'page_view', properties: {}, path: '/' },
  ].map((e) => ({ site_id: null, shop_id: null, shop_name: '', ...e }))

  return { sites, events }
}

let sites = liveSites
let events = []
let inventory = null
let source = 'live database'

if (liveHasData) {
  const withData = sites.find((s) => (s.summary?.events ?? 0) > 0)
  inventory = await rpc('admin_site_inventory', { p_shop_id: withData.shop_id })
  events = await rpc('admin_site_events', { p_site_id: withData.site_id, p_limit: 100 })
} else {
  const fake = synthesise()
  sites = fake.sites
  events = fake.events
  inventory = {
    products: 22, catalogue: 12, banners: 4, page_content: 1, has_settings: true,
    last_sale_at: iso(60 * 5),
    sample_products: [
      { id: 'p1', name: 'iphone 16', price: 120000, stock: 6, image: null },
      { id: 'p2', name: 'AirPods Pro', price: 24000, stock: 14, image: null },
      { id: 'p3', name: 'Samsung A15', price: 32000, stock: 3, image: null },
      { id: 'p4', name: 'Tecno Spark 20', price: 18500, stock: 21, image: null },
    ],
  }
  source = 'SYNTHESIS (live db has sites but no events yet)'
}

const fixture = { vocabulary, sites, inventory, events }
const out = path.join(process.cwd(), 'test', 'fixtures', 'health.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(fixture, null, 2))

console.log('  source:', source)
console.log('  vocabulary:', vocabulary.events.length, 'events,', vocabulary.resources.length, 'resources')
console.log('  sites:', sites.length, '| broken:', sites.filter((s) => s.summary?.broken > 0).length,
  '| silent:', sites.filter((s) => !Object.keys(s.summary?.health || {}).length).length)
console.log('  events:', events.length, '| inventory products:', inventory?.products ?? 'none')
console.log('  written:', out)

// The token gate is the access control for this page, so prove it over HTTP.
const bad = await fetch(`${url}/rest/v1/rpc/admin_site_vocabulary`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_token: 'wrong' }),
})
console.log('  wrong token over HTTP ->', bad.status, bad.status === 200 ? '*** NOT GATED ***' : '(rejected)')
