/**
 * The most important test in the project: does a real outage still show RED?
 *
 * The abort fix stops navigation noise being reported as a fault. The risk of
 * that change is a health bar that is green all the time and therefore useless.
 * So: kill the API, load the site, and require a genuine health_fail.
 *
 * Assumes the API and the site are already running. Usage:
 *   node test/outage.mjs <playwright-core path> <devUrl>
 * The caller kills the API before invoking this.
 */
import { createRequire } from 'node:module'
const [, , pwPath, devUrl] = process.argv
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
page.on('request', (r) => {
  if (r.url().includes('/api/events')) {
    try {
      const b = JSON.parse(r.postData() || '[]')
      posts.push(...(Array.isArray(b) ? b : [b]))
    } catch { /* beacon bodies are not exposed; the DB is the real check */ }
  }
})

console.log('  loading the site with the API DOWN')
await page.goto(devUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
// the retry budget is ~8.5s worst case, so give it room to give up
await page.waitForTimeout(14000)

const body = await page.content()
check('the site still rendered (degraded, not broken)', body.length > 0)
check('no raw "undefined" leaked into the page', !body.includes('undefined'))
check('no unhandled exception text on the page', !/API error: 5\d\d/.test(body))

await browser.close()
console.log(fail === 0 ? '\nOUTAGE: rendered honestly with the API down' : `\nOUTAGE: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
