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

/**
 * Entries are described once, in craftbook.manifest.json, which
 * update-craftbook.mjs also reads. This list used to be duplicated here, which
 * is how the health entry came to be stored under a title its own heading did
 * not use — found only when an update refused to apply. One manifest is a thing
 * that cannot drift the way two hand-typed copies can.
 */
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'scripts', 'craftbook.manifest.json'), 'utf8')
)

/** A delimiter that cannot appear in the prose. Verified, not assumed. */
const TAG = '$craftbook$'
for (const e of manifest) {
  const body = fs.readFileSync(path.join(dir, e.file), 'utf8')
  if (body.includes(TAG)) throw new Error(`${e.file} contains the delimiter ${TAG}`)
}

const values = manifest.map((e) => {
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
