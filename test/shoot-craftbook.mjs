/**
 * Screenshot the Craftbook reader preview and exercise the copy button.
 *
 * The copy button is wired by event delegation because renderMarkdown returns an
 * HTML string, so there is no React onClick to assert against - it has to be
 * clicked in a real browser. The clipboard is stubbed, so this verifies the
 * handler reads the right text and reports success, not that the OS clipboard
 * works.
 *
 * Usage: node test/shoot-craftbook.mjs <playwright-core path> <previewUrl>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const [, , pwPath, url] = process.argv
if (!pwPath || !url) { console.error('usage: node test/shoot-craftbook.mjs <pw> <url>'); process.exit(2) }

const require = createRequire(import.meta.url)
const { chromium } = require(pwPath)
const entries = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'craftbook.json'), 'utf8')).entries

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1280, height: 1200 },
  deviceScaleFactor: 2,
  serviceWorkers: 'block',
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await context.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

const out = path.join(process.cwd(), 'craftbook-preview.png')

for (let i = 0; i < entries.length; i++) {
  const e = entries[i]
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(500)
  if (i > 0) {
    await page.locator('nav button', { hasText: e.title }).click()
    await page.waitForTimeout(400)
  }
  await page.screenshot({ path: out.replace('.png', `-${i + 1}.png`), fullPage: true })

  const blocks = await page.locator('.cb-block').count()
  const highlighted = await page.locator('.cb-block code.hljs').count()
  const copies = await page.locator('[data-cb-copy]').count()
  console.log(`  ${e.title}: ${blocks} blocks, ${highlighted} highlighted, ${copies} copy buttons`)
  check(`${e.title}: has code blocks`, blocks > 0)
  check(`${e.title}: every block is highlighted`, highlighted === blocks, `${highlighted}/${blocks}`)
  check(`${e.title}: every block has a copy button`, copies === blocks, `${copies}/${blocks}`)
  check(`${e.title}: every block is labelled`, (await page.locator('.cb-block-lang').count()) === blocks)
}

// The copy interaction itself, on the first entry that has a js block.
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
const firstBlock = page.locator('.cb-block').first()
const expected = (await firstBlock.locator('code').textContent()) ?? ''
await firstBlock.locator('[data-cb-copy]').click()
await page.waitForTimeout(250)
const label = await firstBlock.locator('[data-cb-copy]').textContent()
check('clicking copy reports success', label === 'Copied', `label="${label}"`)
const clip = await page.evaluate(() => navigator.clipboard.readText())
check('the clipboard holds the code', clip.length > 0, `${clip.length} chars`)
// The Windows clipboard stores CRLF even when writeText is handed LF. That is
// the clipboard's format, not a defect in the copy - so compare on normalised
// newlines and say so, rather than "fixing" a round trip we do not control.
const norm = (s) => s.replace(/\r\n/g, '\n').trim()
check('the clipboard matches the block, not the page', norm(clip) === norm(expected))
check(
  'the copied text is plain source, no highlight markup',
  !clip.includes('<span') && !clip.includes('hljs'),
)

await page.screenshot({ path: out, fullPage: true })
console.log('\n  screenshots: craftbook-preview-{1..4}.png')

const unexpected = errors.filter((e) => !/401|Failed to load resource/.test(e))
check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '))

await browser.close()
console.log(fail === 0 ? '\nCRAFTBOOK: all checks passed' : `\nCRAFTBOOK: ${fail} check(s) failed`)
process.exitCode = fail === 0 ? 0 : 1
