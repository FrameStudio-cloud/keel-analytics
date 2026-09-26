/**
 * Insert Craftbook entries.
 *
 * Reads the markdown files, then inserts one craftbook row each through the
 * Supabase management SQL API. The content is written with a dollar-quoted
 * literal, so nothing in the prose can break out of it - the failure mode being
 * guarded against is markdown full of quotes, backticks and apostrophes.
 *
 * Usage: node scripts/seed-craftbook.mjs <supabase-access-token> <userId> <dir>
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , accessToken, userId, dir] = process.argv
if (!accessToken || !userId || !dir) {
  console.error('usage: node scripts/seed-craftbook.mjs <accessToken> <userId> <dir>')
  process.exit(2)
}

const PROJECT = 'sjhwllnhuozxeplpygnc'

const ENTRIES = [
  {
    file: '01-build-a-mini-catalogue.md',
    title: 'Build a mini-catalogue from scratch',
    category: 'Playbooks',
    tags: ['mini-catalogue', 'playbook', 'onboarding'],
    pinned: true,
  },
  {
    file: '02-starter-files.md',
    title: 'Starter files — copy these in',
    category: 'Playbooks',
    tags: ['mini-catalogue', 'starter', 'code'],
    pinned: true,
  },
  {
    file: '03-health-monitoring.md',
    title: 'Health monitoring — the tripwire',
    category: 'Playbooks',
    tags: ['health', 'monitoring', 'analytics'],
    pinned: true,
  },
  {
    file: '04-deploy-and-verify.md',
    title: 'Deploy and verify a catalogue',
    category: 'Playbooks',
    tags: ['deploy', 'verify', 'checklist'],
    pinned: false,
  },
]

/** A delimiter that cannot appear in the prose. Verified, not assumed. */
const TAG = '$craftbook$'
for (const e of ENTRIES) {
  const body = fs.readFileSync(path.join(dir, e.file), 'utf8')
  if (body.includes(TAG)) throw new Error(`${e.file} contains the delimiter ${TAG}`)
}

const values = ENTRIES.map((e) => {
  const body = fs.readFileSync(path.join(dir, e.file), 'utf8')
  const esc = (s) => `'${String(s).replace(/'/g, "''")}'`
  const arr = (list) => `array[${list.map(esc).join(', ')}]::text[]`
  return `(
    ${esc(e.title)},
    ${esc(e.category)},
    ${arr(e.tags)},
    ${e.pinned},
    ${TAG}${body}${TAG}
  )`
}).join(',\n  ')

const sql = `
insert into public.craftbook (user_id, title, category, tags, pinned, content)
select
  '${userId}'::uuid, t.title, t.category, t.tags, t.pinned, t.content
from (values ${values}
) as t(title, category, tags, pinned, content)
returning id, title, length(content) as len;
`

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
const text = await res.text()
if (!res.ok) {
  console.error('  FAILED', res.status, text.slice(0, 600))
  process.exit(1)
}
const rows = JSON.parse(text)
console.log(`  inserted ${rows.length} entries`)
for (const r of rows) console.log(`    ${r.title}  (${r.len} chars)`)
