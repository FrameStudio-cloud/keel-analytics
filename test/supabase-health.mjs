/**
 * Proves the supabase-mode health fix, in two runs.
 *
 * The bug: in `supabase` data mode the catalogue and banners branches had no
 * success report on any path, so those lamps sat "no signal" forever on a shop
 * running its own database, while the site worked perfectly. Silent, with no
 * reason attached.
 *
 * Two environments are needed, because one cannot prove both halves:
 *
 *   fallback  MODE resolves to fallback, so reads take the success path with no
 *             network involved. Proves a SUCCESSFUL read - including one that
 *             returns nothing - reports healthy.
 *
 *   supabase  MODE resolves to supabase, but anon RLS hides store_settings, so
 *             the shop cannot be identified. Proves the supabase branches report
 *             AT ALL, and with a specific reason, rather than staying silent.
 *
 * Before the fix the supabase run reported nothing whatsoever, so its
 * "every resource reported" assertion is the direct regression guard.
 *
 * Usage: node test/supabase-health.mjs <playwright-core path> <devUrl> <fallback|supabase>
 */
import { createRequire } from 'node:module'

const [, , pwPath, devUrl, expectMode] = process.argv
if (!pwPath || !devUrl || !expectMode) {
  console.error('usage: node test/supabase-health.mjs <pw> <devUrl> <fallback|supabase>')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)

const RESOURCES = ['settings', 'catalogue', 'product', 'banners', 'page_content']

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

// waitUntil must be load, not domcontentloaded: the store module has to be the
// same instance the app uses, and a dev server that just invalidated a file
// serves it under two different URLs
await page.goto(devUrl, { waitUntil: 'load', timeout: 45000 })

// The app's own ShopProvider calls getSettings on mount, so a test that fires
// its own calls immediately races it - and the winner varies, which showed up as
// a store that said healthy while the returned mode said fallback. Wait for the
// app to settle first, then drive the data layer.
await page.waitForFunction(
  () => {
    const root = document.querySelector('#root');
    return root && root.children.length > 0;
  },
  { timeout: 30000 },
);
await page.waitForTimeout(2500);

const result = await page.evaluate(async (productId) => {
  const ds = await import('/src/services/dataService.js')
  const dh = await import('/src/lib/dataHealth.js')
  const mode = ds.MODE

  // Reset so what we assert on is this run's reads, not the app's.
  dh.resetDataHealth()

  const settings = await ds.getSettings()
  const products = await ds.getProducts()
  const product = productId ? await ds.getProduct(productId) : null
  const banners = await ds.getBanners()

  return {
    mode,
    resources: JSON.parse(JSON.stringify(dh.__testState().resources)),
    returned: {
      settingsMode: settings?.mode ?? null,
      settingsIsObject: typeof settings === 'object' && settings !== null,
      productsIsArray: Array.isArray(products),
      bannersIsArray: Array.isArray(banners),
      productIsNullOrObject: product === null || typeof product === 'object',
    },
  }
}, process.env.PRODUCT_UUID || null)

console.log(`  mode under test: ${result.mode}  (expected ${expectMode})`)
check('we are testing the intended branch', result.mode === expectMode, `mode=${result.mode}`)

console.log('\n  what each resource reported:')
for (const name of RESOURCES) {
  const s = result.resources[name]
  console.log(`    ${name.padEnd(14)} ${s ? (s.ok ? 'ok=true ' : 'ok=false') : 'NOT REPORTED'}${s?.error ? '  ' + s.error : ''}`)
}

if (expectMode === 'supabase') {
  console.log('\n  asserting the SUPABASE branches report at all:')
  // The regression: these two were completely silent before.
  for (const name of ['catalogue', 'banners', 'settings']) {
    const s = result.resources[name]
    check(`${name} reported something (was silent before the fix)`, Boolean(s), `got ${JSON.stringify(s)}`)
  }
  // anon RLS hides store_settings, so the honest answer is a fault with a reason.
  const catalogue = result.resources.catalogue
  check(
    'the fault carries a specific, actionable reason',
    catalogue?.ok === false && /no shop id resolved/.test(catalogue?.error || ''),
    `error="${catalogue?.error}"`,
  )
  check('getProducts still returns an array', result.returned.productsIsArray)
  check('getBanners still returns an array', result.returned.bannersIsArray)
  check('getProduct returns null or a product', result.returned.productIsNullOrObject)
} else {
  // fallback and keel both take the success path; keel additionally talks to the
  // real API, so it proves the whole chain rather than just the local branch.
  console.log(`\n  asserting the SUCCESS path (${expectMode}):`)
  for (const name of RESOURCES) {
    const s = result.resources[name]
    check(`${name} reports healthy`, s?.ok === true, s?.ok === true ? '' : `got ${JSON.stringify(s)}`)
  }
  check('getSettings returns an object', result.returned.settingsIsObject)
  check('getProducts returns an array', result.returned.productsIsArray)
  check('getBanners returns an array', result.returned.bannersIsArray)
  check('getProduct returns null or a product', result.returned.productIsNullOrObject)
  if (expectMode === 'keel') {
    check(
      'getSettings reports keel mode, not fallback',
      result.returned.settingsMode === 'keel',
      `mode=${result.returned.settingsMode}`,
    )
  }
}

check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
console.log(fail === 0 ? `\nHEALTH(${expectMode}): all checks passed` : `\nHEALTH(${expectMode}): ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
