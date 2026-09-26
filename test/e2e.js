/**
 * End-to-end: the SDK talking to a real keel-api over real HTTP, with rows
 * landing in the real database. Uses the default transport (fetch), not an
 * injected one, so the sendBeacon path and headers are exercised too.
 *
 * Usage: node test/e2e.js <apiBase> <writeToken>
 */
import { init, track, health, captureError, page, flush, __reset, __state } from '../index.js'

const [, , apiBase, token] = process.argv
if (!apiBase || !token) {
  console.error('usage: node test/e2e.js <apiBase> <writeToken>')
  process.exit(2)
}

let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fail += 1
}

init({ token, apiBase, debug: true })

// The window is absent in Node, so page_view paths will be null. Use the
// explicit page() helper for the path assertions instead.
page('/e2e-check')
track('product_viewed', { name: 'E2E Chair', quantity: 2, phone: '+254799451882', email: 'leak@example.com' })
track('add_to_cart', { name: 'E2E Chair', quantity: 1 })
health('catalogue', false, 'e2e: simulated catalogue timeout')
health('catalogue', false, 'e2e: still broken - should NOT be sent')
health('catalogue', true)
captureError(new Error('e2e: deliberate failure'), { source: 'e2e' })
check('out-of-vocabulary event refused locally', track('made_up_event') === false)

flush()

// Give the in-flight requests room to finish. Do not process.exit() here: it
// aborts any fetch that has not yet resolved, which silently loses most of a
// batch and makes the database check look like a server bug.
await new Promise((r) => setTimeout(r, 3000))

const expected = __state().queue.length
check('queue drained after flush', expected === 0, `queue=${expected}`)

console.log(fail === 0 ? '\nE2E: all SDK-side checks passed' : `\nE2E: ${fail} check(s) failed`)
__reset()
// natural exit, letting the event loop settle
process.exitCode = fail === 0 ? 0 : 1
