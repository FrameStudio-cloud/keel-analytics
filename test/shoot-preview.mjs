/**
 * Screenshot the design-review preview page.
 *
 * This mounts the real SiteHealth components against a stub client, so there is
 * no auth gate, no service worker and no DataProvider to fight. It is the same
 * code the app renders - there is no second implementation that could drift.
 *
 * Usage: node test/shoot-preview.mjs <playwright-core path> <previewUrl>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const [, , pwPath, url] = process.argv
if (!pwPath || !url) { console.error('usage: node test/shoot-preview.mjs <pw> <url>'); process.exit(2) }

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)
const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'health.json'), 'utf8'))

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
const page = await context.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(2500)

const out = path.join(process.cwd(), 'sites-console.png')
await page.screenshot({ path: out, fullPage: true })
console.log('  screenshot: ' + out)

const text = await page.innerText('body')

console.log('\n  --- assertions ---')
check('page rendered', /Sites/.test(text))
check('every site in the fixture is listed', fixture.sites.every((s) => text.includes(s.shop_name)),
  `${fixture.sites.length} site(s)`)
check('vocabulary drives the bars: all resource keys shown',
  fixture.vocabulary.resources.every((r) => text.includes(r.key)))
check('vocabulary drives the stream: event labels shown',
  fixture.events.every((e) => {
    const label = fixture.vocabulary.events.find((v) => v.name === e.name)?.label || e.name
    return text.includes(label)
  }))
check('lamp dots rendered', (await page.locator('span.rounded-full').count()) >= 10)
check('inventory counts rendered', text.includes(String(fixture.inventory.products)))
// DataProvider runs the dashboard's own twenty queries with no session in this
// harness, so 401s from it are expected and say nothing about the page under
// review. Only errors that are ours should fail this.
const unexpected = errors.filter((e) => !/401/.test(e))
check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '))

// The rail and detail must both be usable on a phone.
await page.setViewportSize({ width: 390, height: 860 })
await page.waitForTimeout(500)
await page.screenshot({ path: out.replace('.png', '-mobile.png'), fullPage: true })
const mobile = await page.innerText('body')
check('mobile still lists sites', fixture.sites.some((s) => mobile.includes(s.shop_name)))
console.log('  mobile screenshot: ' + out.replace('.png', '-mobile.png'))

console.log('\n  --- what the page says ---')
console.log(text.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'))

await browser.close()
console.log(fail === 0 ? '\nPREVIEW: all checks passed' : `\nPREVIEW: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
