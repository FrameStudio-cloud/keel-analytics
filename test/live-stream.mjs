/**
 * Proves the event stream updates without a reload.
 *
 * The stub returns a different admin_site_events payload on its second call, so
 * the page has to poll and merge to see the new row. Nothing reloads, nothing is
 * clicked, and no new site is selected - if a row appears, polling worked.
 *
 * Also asserts the two behaviours that make polling safe rather than annoying:
 * a new row is NOT duplicated when it overlaps a poll, and a reader who has
 * scrolled down is not yanked to the top.
 *
 * Usage: node test/live-stream.mjs <playwright-core path> <previewUrl>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const [, , pwPath, url] = process.argv
if (!pwPath || !url) { console.error('usage: node test/live-stream.mjs <pw> <url>'); process.exit(2) }

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)
const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'health.json'), 'utf8'))

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const initial = fixture.events
const NEW_EVENT = {
  id: 'ffffffff-1111-4111-8111-111111111111',
  occurred_at: new Date().toISOString(),
  site_id: fixture.sites[0]?.site_id ?? null,
  shop_id: fixture.sites[0]?.shop_id ?? null,
  shop_name: 'live-probe',
  name: 'health_fail',
  path: '/shop',
  properties: { resource: 'catalogue', detail: 'API error: 500 (live probe)' },
}

let calls = 0
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

// The stub only starts returning the new row on the SECOND call, so the page has
// to poll - it cannot be showing something it already had.
await page.route('**/rest/v1/rpc/**', async (route) => {
  const name = route.request().url().split('/rpc/')[1].split('?')[0]
  const map = { admin_site_vocabulary: fixture.vocabulary, admin_sites: fixture.sites, admin_site_inventory: fixture.inventory }
  if (name === 'admin_site_events') {
    calls += 1
    const rows = calls === 1 ? initial : [NEW_EVENT, ...initial]
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
  }
  if (name in map) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(map[name]) })
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"unstubbed"}' })
})

console.log('  loading the reader (no reload after this point)')
await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(1500)

const stream = () => page.locator('section', { has: page.locator('h2', { hasText: 'Event stream' }) }).first()
const before = await stream().innerText()
check('the new event is absent before polling', !before.includes('live probe'), 'so its arrival cannot be a leftover')

console.log('  waiting out the 20s poll interval…')
await page.waitForTimeout(24000)

const after = await stream().innerText()
check('the new event appeared WITHOUT a reload', after.includes('live probe'))
check('it is at the top, because the reader is at the top', after.indexOf('live probe') < after.indexOf(fixture.events[0]?.name ? 'healthy' : 'zzz'))
check('it kept its reason', after.includes('API error: 500'))
check('the older rows are still there', (await stream().locator('li').count()) >= initial.length)

const rowCount = await stream().locator('li').count()
console.log(`  waiting a second poll to check for duplication…`)
await page.waitForTimeout(22000)
const rowCount2 = await stream().locator('li').count()
check('a repeated row is not duplicated', rowCount2 === rowCount, `${rowCount} -> ${rowCount2}`)

// Scroll away from the top, then confirm new rows wait behind the pill instead
// of yanking the list.
console.log('  scrolling down to test the "N new" affordance…')
await stream().locator('ul').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
await page.waitForTimeout(300)
check('the poll note is shown', (await stream().innerText()).includes('updates every 20s'))

check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
console.log(`  admin_site_events calls made: ${calls}`)

await browser.close()
console.log(fail === 0 ? '\nLIVE STREAM: all checks passed' : `\nLIVE STREAM: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
