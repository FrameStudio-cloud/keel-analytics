/**
 * Screenshot the /sites page with a throwaway authenticated session, then
 * delete the user. The dashboard is behind Supabase Auth, so the page cannot be
 * verified without a session.
 *
 * Usage: node test/screenshot-dashboard.mjs <playwright-core path> <devUrl>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const [, , pwPath, devUrl] = process.argv
if (!pwPath || !devUrl) { console.error('usage: node test/screenshot-dashboard.mjs <pw> <devUrl>'); process.exit(2) }

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)

const DASH_ENV = 'C:/Users/Administrator/projects/framestudio/framestudio-dashboard/.env'
const accessToken = fs.readFileSync(path.join(process.env.USERPROFILE, '.supabase', 'access-token'), 'utf8').trim()

const env = {}
for (const line of fs.readFileSync(DASH_ENV, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
  if (m) env[m[1]] = m[2]
}
const url = env.VITE_SUPABASE_URL
const anon = env.VITE_SUPABASE_ANON_KEY
const ref = new URL(url).hostname.split('.')[0]
const email = `healthcheck-${Date.now()}@framestudio.test`
const password = 'Healthcheck-' + Date.now() + '-aA1'

console.log('  creating a throwaway user: ' + email)
const created = await fetch(`${url}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: accessToken, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }),
})
if (!created.ok) { console.error('  create failed:', (await created.text()).slice(0, 300)); process.exit(1) }
const user = await created.json()
console.log('  created ' + user.id)

const cleanup = async () => {
  const del = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
    method: 'DELETE',
    headers: { apikey: accessToken, Authorization: `Bearer ${accessToken}` },
  })
  console.log(`  ${del.ok ? 'deleted' : 'FAILED TO DELETE'} the throwaway user (${del.status})`)
}

try {
  const signed = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const session = await signed.json()
  if (!session.access_token) { console.error('  sign-in failed:', JSON.stringify(session).slice(0, 300)); await cleanup(); process.exit(1) }
  console.log('  signed in')

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)) })

  await page.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value) },
    [`sb-${ref}-auth-token`, JSON.stringify(session)],
  )

  await page.goto(devUrl + '/sites', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(4000)

  const out = path.join(process.cwd(), 'health-console.png')
  await page.screenshot({ path: out, fullPage: true })
  console.log('  screenshot: ' + out)

  const text = await page.innerText('body')
  console.log('\n  --- visible text (first 1200 chars) ---')
  console.log(text.slice(0, 1200).split('\n').map((l) => '    ' + l).join('\n'))

  if (errors.length) {
    console.log('\n  --- page errors ---')
    errors.slice(0, 8).forEach((e) => console.log('    ' + e))
  } else {
    console.log('\n  no page errors')
  }

  await browser.close()
} finally {
  await cleanup()
}
