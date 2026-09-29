# @framestudio/keel-analytics

Analytics and data-health for Keel storefronts. About 300 lines, no dependencies.

```js
import * as analytics from '@framestudio/keel-analytics'

analytics.init({ token: import.meta.env.VITE_KEEL_SITE_TOKEN })
```

That is the whole setup. After `init()`, page views and uncaught errors report
themselves. You add the two things that actually matter for a shop — what the
visitor did, and whether the shop's data is loading.

```js
analytics.track('add_to_cart', { name: 'Chair', quantity: 2 })
analytics.health('catalogue', false, 'request timed out')
```

## Why it is shaped like this

**The event vocabulary is closed.** Anything outside the list is refused in the
browser, before a request is made, and again by a `CHECK` constraint in the
database. That double guard is the line between a tool you can maintain and a
product you have to support forever. If you need a new event, add it to `EVENTS`
here and to the constraint in the migration.

| event | when |
| --- | --- |
| `page_view` | automatic; also `page('/virtual-route')` |
| `product_viewed` | a product page resolved |
| `add_to_cart` | added to cart |
| `feature_used` | a non-obvious feature was used (e.g. `back_to_top`) |
| `health_ok` / `health_fail` | a data resource changed state |
| `error` | automatic for uncaught errors and unhandled rejections |

**Health fires on transitions only.** A shop with a dead catalogue produces one
`health_fail` when it breaks, not one per page view. The current state is the
latest event per resource, so history and state are the same query.

**Nothing throws into your app.** A failed analytics call must never break a
shop's page mid-sale. Transport errors are swallowed — except in `debug` mode,
where they are logged, because "my data is not showing up" needs an answer.

## Privacy, built in not bolted on

A storefront has contact forms and a chat widget, so the obvious future mistake
is:

```js
analytics.track('product_viewed', { name, phone, message })
```

Two things stop that:

1. Keys matching `phone`, `email`, `address`, `message`, `note`, `body`,
   `comment` or `contact` are dropped **in the browser** (with a dev-mode
   warning) and again **by the collector**.
2. `page()` and auto-captured page views **strip the query string**, so
   `/shop?email=buyer@example.com` and `?token=...` never leave the browser.

`name` is deliberately kept — on `product_viewed` it is the product name, which
is already public on your site. The closed vocabulary means there is no event
that legitimately carries a customer's details, because none of them is an
inquiry event.

## Knowing who, without knowing who

Every other number this SDK produces is a count of something. "40 views" and
"one person refreshing 40 times" are indistinguishable, and only one of those is
a problem worth knowing about. On a catalogue the gap is sharper still: a
count of distinct pages can never exceed your product count, so it can never
tell you how many people came.

So events carry two extra top-level fields:

- `visitor_id` — a random v4 UUID in `localStorage`, minted on first visit.
- `session_id` — a new UUID after 30 minutes idle.

Both exist to group rows together and for no other reason:

- **Derived from nothing.** Not the IP, not the user agent, not a canvas
  fingerprint. A random number that links events to each other and to nothing
  else.
- **Persisted, including the session.** Otherwise a reload mints a new session,
  and the most ordinary thing a visitor does — open a product, refresh, open it
  again — is recorded as three separate visits by three separate people.
- **Expiring.** `visitor_id` is replaced after 90 days, matching the collector's
  `prune_site_events` default, so an id never outlives the rows it groups.
- **Skippable.** `navigator.doNotTrack` and `navigator.globalPrivacyControl` are
  respected by default, as is `init({ visitor: false })`. When tracking is
  refused the **event still sends** — the health report must not be lost just
  because the visitor asked not to be counted — and both id keys are omitted.
- **Resilient.** No `localStorage` (Safari private mode, blocked storage) and
  `crypto.randomUUID` being absent outside a secure context both fall back. The
  worst case is a visitor counted once and not remembered, which undercounts
  rather than overcounts.

They are top-level columns rather than entries in `properties` for one reason:
`properties` is unindexed jsonb, so every unique-visitor count would be a full
table scan.

```js
import { resetVisitor } from '@framestudio/keel-analytics'
resetVisitor()   // for a "reset my data" control
```

> **Deploy the collector first.** A pre-0.2 collector strips unknown keys
> silently, so shipping the SDK before the schema lands records events with no
> visitor and no warning. Collector first, then the storefronts.

## API

```js
init({ token, apiBase, debug, appVersion, autoPageView, visitor, win, storage, transport })
track(name, properties)     // false if the name is outside the vocabulary
page(path, properties)      // for virtual routes; query string stripped
captureError(error, context)
health(resource, ok, detail)
flush()                     // force a send
resetVisitor()              // forget the visitor, issue a new id
```

`health()` accepts `settings`, `catalogue`, `product`, `banners`, `page_content`.
Anything else is refused, so the console never has to render a bar for a
resource it does not understand.

## Delivery

Events queue and batch (max 20, matching the collector). The queue flushes on a
30-second interval, when it reaches a full batch, and on `pagehide` /
`visibilitychange` — with `keepalive` so the request survives the page being
unloaded.

It uses `fetch(..., { keepalive: true })` and **not** `navigator.sendBeacon`,
which is the obvious choice for a last-gasp flush and is wrong here: sendBeacon
cannot set custom headers, so the `x-keel-site-token` never went out, the
collector answered 401, and sendBeacon had already returned `true` so the SDK
reported success. Health bars were permanently empty with nothing in any log to
explain it. Only loading the real site in a real browser caught it.

This is also why the SDK is a bundled npm dependency rather than a script tag
served by keel-api: keel-api sleeps, so a script served by it is unavailable
during exactly the window it would be meant to explain.

## Development

```bash
npm test          # 23 unit tests, no network
npm run test:e2e http://localhost:3000 <write-token>   # real HTTP into a local keel-api
```

The unit tests inject a transport and so **cannot** catch collector-side
validation bugs. Both the `path: null` and the `origin`-matching defects this
project hit were found only by the e2e run. Run it whenever the collector's
schema changes.

## Publishing

```bash
npm publish --access public
```

Scope is `@framestudio`, so the account needs that scope created once. Sites
then pin a version, which is deliberate: with 8+ live storefronts an SDK release
should never reach them unannounced.
