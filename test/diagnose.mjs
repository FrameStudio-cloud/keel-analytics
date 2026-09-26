/**
 * Diagnostic: why is the SDK not reporting? Prints what the page can see.
 */
import { createRequire } from 'node:module'
const [, , pwPath, devUrl] = process.argv
const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()

const calls = { manifest: [], settings: [], catalogue: [], events: [], pageviews: [] }
page.on('request', (r) => {
  const u = r.url()
  if (u.includes('keel-manifest')) calls.manifest.push(u)
  else if (u.includes('/api/events')) calls.events.push(u)
  else if (u.includes('/api/page-views')) calls.pageviews.push(u)
  else if (u.includes('/api/settings')) calls.settings.push(r.method())
  else if (u.includes('/api/catalogue')) calls.catalogue.push(r.method())
})
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('keel-analytics') || t.includes('Failed to resolve') || t.toLowerCase().includes('error')) {
    console.log('  [console] ' + t.slice(0, 220))
  }
})
page.on('pageerror', (e) => console.log('  [pageerror] ' + String(e).slice(0, 220)))

await page.goto(devUrl, { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(3000)

console.log('\n  network calls observed:')
for (const [k, v] of Object.entries(calls)) {
  console.log(`    ${k.padEnd(11)} ${v.length} ${v.length ? JSON.stringify(v.slice(0, 2)) : ''}`)
}

// Ask the page directly what it resolved.
const probe = await page.evaluate(async () => {
  const out = { hasShop: false, toggles: null, shopName: null }
  try {
    const res = await fetch('/keel-manifest.json')
    const j = await res.json()
    out.hasShop = true
    out.shopName = j.shop?.name || j.name || null
    out.toggles = j.features ? Object.fromEntries(
      Object.entries(j.features).map(([k, v]) => [k, v?.enabled])
    ) : null
    out.featureKeys = j.features ? Object.keys(j.features) : null
  } catch (e) { out.err = String(e) }
  return out
})
console.log('\n  manifest probe:')
for (const [k, v] of Object.entries(probe)) {
  console.log('    ' + k.padEnd(11) + ' ' + JSON.stringify(v))
}

await browser.close()
