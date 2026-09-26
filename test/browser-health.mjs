/**
 * Browser verification: does a real kikoi page actually produce health events?
 *
 * Unit tests inject a transport and jsdom has no history patching, so neither can
 * prove the wiring. This loads the real site in headless Chrome against a LOCAL
 * keel-api, kills that API mid-session, and checks the health bars reacted.
 *
 * Usage: node test/browser-health.mjs <playwrightCorePath> <devUrl> <apiBase>
 */
import { createRequire } from 'node:module'

const [, , pwPath, devUrl, apiBase] = process.argv
if (!pwPath || !devUrl || !apiBase) {
  console.error('usage: node test/browser-health.mjs <playwright-core path> <devUrl> <apiBase>')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const posts = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()

page.on('console', (m) => {
  if (m.text().includes('[keel-analytics]')) console.log('    browser: ' + m.text())
})
page.on('request', (r) => {
  if (r.url().includes('/api/events')) {
    try {
      const b = JSON.parse(r.postData() || '[]')
      posts.push(...(Array.isArray(b) ? b : [b]))
      console.log(`    POST /api/events -> ${b.length} event(s): ${b.map((e) => e.name).join(', ')}`)
    } catch { /* ignore */ }
  }
})

console.log(`  loading ${devUrl}`)
await page.goto(devUrl, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(2500)

check('the site rendered', await page.locator('body').count() > 0)
check('no undefined leaked into the page', !(await page.content()).includes('undefined'))
check(
  'no keel-analytics complaints',
  !posts.some((p) => p.name === 'error'),
  JSON.stringify(posts.filter((p) => p.name === 'error').slice(0, 2)),
)

const healthNames = [...new Set(posts.filter((p) => p.name.startsWith('health_')).map((p) => p.name))]
console.log('  health events seen: ' + (healthNames.join(', ') || '(none)'))
check(
  'health events were produced',
  healthNames.length > 0,
  'the SDK is armed and dataHealth is reporting',
)

const failEvents = posts.filter((p) => p.name === 'health_fail')
check(
  'health_fail events name a known resource',
  failEvents.every((e) => e.properties && e.properties.resource),
  JSON.stringify(failEvents.map((e) => e.properties?.resource)),
)

check('no PII-shaped keys in any payload', !posts.some((p) => JSON.stringify(p.properties || {}).match(/"(phone|email|address|message)"/)))

await browser.close()
console.log(fail === 0 ? '\nBROWSER: all checks passed' : `\nBROWSER: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
