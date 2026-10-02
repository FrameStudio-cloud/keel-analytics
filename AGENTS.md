# AGENTS.md — @framestudio/keel-analytics

The storefront analytics + data-health client. ~300 lines, zero dependencies, plain
ESM, no build step. Published to npm and installed by name, so **anything in `index.js`
ships to every storefront that depends on it** — a regression here is a bug on live
shops, not just in a repo.

## Tooling: never patch files with PowerShell

Use `read` / `edit` / `write` for anything that changes file contents. Use the shell
for `git`, `npm`, servers and tests only.

Not a preference — PowerShell string surgery truncated a script in this repo from
64 lines to 12, silently. `Get-Content -Raw` + `-replace` + `WriteAllText` on a
**relative** path resolved against the tool's working directory rather than the
`Set-Location` target, so the read returned `$null` and the write replaced the file with
almost nothing. `-replace` with `\n` also inserts a literal backslash-n rather than a
newline, and backticks/`$` in inline JS get mangled — so dollar-quoted SQL cannot be
assembled in PowerShell at all.

The file tools fail loudly instead: `edit` refuses a non-matching `oldString`, and they
take absolute paths so they cannot misresolve. That is the whole reason.

Also: `git`/`npm` writing to stderr makes the shell tool report `NativeCommandError`
even when the command succeeded. Check the exit code and the real output.

## Commands

```bash
npm test                          # 27 unit assertions, no network
node test/e2e.js <apiBase> <token> # real HTTP into a running collector
```

The rest of `test/` needs a live site and a browser, and reaches into sibling repos by
absolute path — they are development tools for this workspace, not a portable suite:

| script | what it proves |
| --- | --- |
| `test/browser-health.mjs` | a real browser against a real site produces health events |
| `test/supabase-health.mjs` | all three storefront data modes report correctly |
| `test/live-stream.mjs` | the console merges new events without a reload |
| `test/shoot-preview.mjs` | the Sites console, screenshotted |
| `test/shoot-craftbook.mjs` | the Craftbook reader, including code-block copy |
| `test/build-fixture.mjs` | rebuilds `test/fixtures/health.json` from the live database |
| `scripts/seed-craftbook.mjs` | writes the four Craftbook playbook entries |
| `scripts/update-craftbook.mjs` | updates one entry, matched by filename |

`test/fixtures/` and `*.png` are gitignored — they are evidence for a change, not an
input to one.

## Rules this file will not break

1. **The event vocabulary is closed.** `EVENTS` is the list, and the database enforces
   the same list by foreign key to `event_types`. Adding an event is a database insert,
   not a code change, so the console picks up its label with no deploy.
1a. **Health resources are NOT closed, and must not become closed again.** They became
   per-site in 0.3.0, so the set is what each site declared, not what this file knows.
   `HEALTH_RESOURCES` is a starter set for discoverability. Refusing anything else here
   was a production-only failure: the warning fires in development only, so a
   legitimate new resource was dropped with no request, no row and no trace, and the
   console showed a site that had never reported anything. The collector validates
   per site and can refuse with a reason; this file cannot.
2. **Never throw into the host app.** A failed analytics call must not break a shop's
   page mid-sale. Every public function is wrapped.
3. **Never send customer contact details.** Keys matching
   `phone|email|address|message|note|body|contact` are dropped in the browser, and the
   collector drops them again.
4. **Health fires on transitions only.** A broken catalogue produces one record, not one
   per page view. Current state is the latest record, so history and state are one query.
5. **Query strings never leave the browser.** `/shop?email=…` would otherwise write
   customer data into the event table.

## The three bugs this SDK exists because of

Each was found by a real browser or a real HTTP call, and none could be caught by the
unit tests. Do not "simplify" any of them away.

- **`navigator.sendBeacon` cannot set custom headers.** It looks correct for a flush on
  page unload. The site token travels in `x-keel-site-token`, so every beacon was sent
  unauthenticated, the collector answered `401`, and `sendBeacon` had already returned
  `true`. Six POSTs on the wire, zero rows stored, nothing in any log. Node has no
  `navigator.sendBeacon`, so **no test that does not run in a browser can catch this**.
  Use `fetch(..., { keepalive: true })` — it survives unload *and* carries the header.
- **A nullable field validated as "absent".** The collector accepted `path` only when it
  was missing, not when it was `null`. The SDK sends `path: null` when it has no
  `window`, so 5 of 6 events were dropped with a 400 while `page_view` worked — which
  made it look partly fine. Injected-transport tests cannot see this; it needs a real
  HTTP boundary.
- **A local `file:` dependency.** Resolves on the machine that has both folders and
  nowhere else. A Vercel clone has one. Depend on the published version.

## Publishing

```bash
npm login
npm publish --access public
```

The scope is `@framestudio` and already exists. Bump `version` — npm refuses to
republish a version, and sites pin a range, so a breaking change needs a new major.

Before publishing: `npm test`, and `npm pack --dry-run` to confirm only `index.js`,
`README.md` and `package.json` ship. Test files and fixtures must never end up in the
tarball.
