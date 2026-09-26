/**
 * Render the real /sites page in a real browser and screenshot it.
 *
 * Auth is bypassed by injecting a throwaway localStorage session, and the four
 * Supabase RPC calls are intercepted with a fixture captured from the live
 * database (test/build-fixture.mjs). That exercises the actual components, the
 * actual data shapes and the actual layout, without needing production auth
 * credentials and without writing anything to a real auth table.
 *
 * Usage: node test/shoot.mjs <playwright-core path> <devUrl>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const [, , pwPath, devUrl] = process.argv
if (!pwPath || !devUrl) { console.error('usage: node test/shoot.mjs <pw> <devUrl>'); process.exit(2) }

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)

const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'health.json'), 'utf8'),
)

const env = {}
for (const line of fs.readFileSync('C:/Users/Administrator/projects/framestudio/framestudio-dashboard/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]

// A session that will never be used - the page is behind ProtectedRoute, and
// getSession only checks the stored value has not expired.
const session = {
  access_token: 'x',
  refresh_token: 'x',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'local-visual-check', aud: 'authenticated', role: 'authenticated', email: 'check@local' },
}

const calls = []
const unstubbed = []
let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
// serviceWorkers: 'block' matters here. This app registers a PWA service worker,
// and a request served through it does not go through page.route - so the stubs
// below were silently bypassed and the app's data layer hit the real API with a
// fake token, which parked the whole app on "Loading data...".
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 2,
  serviceWorkers: 'block',
})
const page = await context.newPage()

const errors = []
const allConsole = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)))
page.on('console', (m) => {
  allConsole.push(`[${m.type()}] ${m.text().slice(0, 200)}`)
  if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 240))
})

// Surface any non-2xx with its URL, so a failed stub is nameable instead of
// showing up as three anonymous "401 ()" lines.
const bad = []
page.on('response', (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`)
})

await page.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  [`sb-${ref}-auth-token`, JSON.stringify(session)],
)

// Stub the entire Supabase host. The dashboard's own DataProvider runs a dozen
// queries before it will render anything, and it is gated on all of them
// settling - so an unstubbed request with a fake token leaves the whole app on
// "Loading data..." and the page under test never mounts.
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

await page.route('**/rest/v1/rpc/**', async (route) => {
  const raw = route.request().url().split('/rpc/')[1]
  const name = raw.split('?')[0]
  const map = {
    admin_site_vocabulary: fixture.vocabulary,
    admin_sites: fixture.sites,
    admin_site_inventory: fixture.inventory,
    admin_site_events: fixture.events,
  }
  if (name in map) {
    calls.push(`${name} (raw="${raw}") -> ${JSON.stringify(map[name]).length} bytes`)
    return json(route, map[name])
  }
  unstubbed.push(name)
  return route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'unstubbed in visual check: ' + name }),
  })
})

// auth: a valid-looking user so getSession/getUser settle instead of 401ing
await page.route('**/auth/v1/**', async (route) => {
  const u = route.request().url()
  if (u.includes('/token')) {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...session, user: session.user }),
    })
  }
  return json(route, session.user)
})

// any other PostgREST read (table selects made by the app's own data layer) -
// these are all lists, and the app guards them with length checks
await page.route('**/rest/v1/**', (route) => json(route, []))

// Anything left hanging is what keeps the app's ready gate closed, so report it.
const allReqs = []
page.on('request', (r) => allReqs.push(r.method() + ' ' + r.url().slice(0, 130)))
const pending = new Map()
page.on('request', (r) => pending.set(r, Date.now()))
page.on('requestfinished', (r) => pending.delete(r))
page.on('requestfailed', (r) => pending.delete(r))

console.log('  loading ' + devUrl + '/sites')
await page.goto(devUrl + '/sites', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1500)

const out = path.join(process.cwd(), 'sites-console.png')
await page.screenshot({ path: out, fullPage: true })
console.log('  screenshot: ' + out)

const text = await page.innerText('body')
console.log('\n  RPC calls the page actually made:')
calls.forEach((c) => console.log('    STUBBED  ' + c))
console.log('    unstubbed RPCs: ' + (unstubbed.join(', ') || 'none'))
console.log('    ALL requests:'); allReqs.forEach((r) => console.log('      ' + r))
console.log('\n  --- raw DOM probe ---')
console.log('    non-2xx responses:')
if (bad.length === 0) console.log('      (none)')
bad.slice(0, 12).forEach((b) => console.log('      ' + b))
console.log('    still-pending requests:')
const stuck = [...pending.entries()].filter(([, t]) => Date.now() - t > 2500)
if (stuck.length === 0) console.log('      (none)')
stuck.slice(0, 10).forEach(([r]) => console.log('      ' + r.method() + ' ' + r.url().slice(0, 140)))
const probe = await page.evaluate(() => {
  const rail = document.querySelector('nav[aria-label="Sites"]')
  return {
    railRows: rail ? rail.querySelectorAll('li').length : -1,
    filterCounts: Array.from(document.querySelectorAll('button[aria-pressed]')).map((b) => b.textContent.trim()),
    panels: Array.from(document.querySelectorAll('section h2')).map((h) => h.textContent.trim()),
    notFound: document.body.innerText.includes('No sites yet'),
  }
})
console.log('    ' + JSON.stringify(probe, null, 2).split('\n').join('\n    '))

console.log('\n  --- assertions ---')
check('page rendered the Sites heading', /Sites/.test(text))
check('rail lists every site', fixture.sites.every((s) => text.includes(s.shop_name)),
  `${fixture.sites.length} sites`)
check('a broken site is shown as broken', /broken/i.test(text))
check('"no signal" is distinct from healthy', /no signal/i.test(text))
check('vocabulary-driven resource keys appear', fixture.vocabulary.resources.every((r) => text.includes(r.key)))
check('vocabulary-driven event labels appear',
  fixture.events.some((e) => text.includes(fixture.vocabulary.events.find((v) => v.name === e.name)?.label || e.name)))
check('inventory counts rendered', text.includes(String(fixture.inventory.products)))
check('lamp strips rendered (dots)', (await page.locator('span.rounded-full').count()) > 20)
check('no unhandled page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

// Mobile: the rail stacks above the detail, so it must not collapse to nothing.
await page.setViewportSize({ width: 390, height: 900 })
await page.waitForTimeout(600)
await page.screenshot({ path: out.replace('.png', '-mobile.png'), fullPage: true })
const mobileText = await page.innerText('body')
check('mobile still lists sites', mobileText.includes(fixture.sites[0].shop_name))
console.log('  mobile screenshot: ' + out.replace('.png', '-mobile.png'))

console.log('\n  --- visible text ---')
console.log(text.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'))

console.log('\n  --- every console message ---')
allConsole.slice(0, 20).forEach((m) => console.log('    ' + m))

await browser.close()
console.log(fail === 0 ? '\nVISUAL: all checks passed' : `\nVISUAL: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
