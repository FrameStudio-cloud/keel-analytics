/**
 * Update one Craftbook entry, matched by filename against the manifest.
 *
 * The insert path is seed-craftbook.mjs; this exists because editing an entry
 * means re-inserting it, and "delete then insert" throws away the row id and
 * created_at for no reason.
 *
 * Both scripts read craftbook.manifest.json, which is the reason the two can
 * never disagree. The first version of this file matched a title against each
 * file's first heading, and failed immediately: the entry had been seeded with
 * the title "Health monitoring — the tripwire" while the heading said "Health
 * monitoring — how the tripwire works". One title, two spellings, found only
 * when an update refused to apply. A manifest is a thing that cannot drift the
 * way a heading compared to a hand-typed string can.
 *
 * Usage: node scripts/update-craftbook.mjs <accessToken> <userId> <dir> <file.md>
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , accessToken, userId, dir, filename] = process.argv
if (!accessToken || !userId || !dir || !filename) {
  console.error('usage: node scripts/update-craftbook.mjs <token> <userId> <dir> <file.md>')
  process.exit(2)
}

const PROJECT = 'sjhwllnhuozxeplpygnc'
const TAG = '$craftbook$'

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'craftbook.manifest.json'), 'utf8'))
const entry = manifest.find((e) => e.file === filename)
if (!entry) {
  console.error(`  ${filename} is not in the manifest`)
  process.exit(1)
}

const body = fs.readFileSync(path.join(dir, filename), 'utf8')
if (body.includes(TAG)) {
  console.error(`  ABORT: ${filename} contains the SQL delimiter ${TAG}`)
  process.exit(1)
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

// Matched on the PREVIOUS title as well as the new one, so a correction to an
// entry's title does not orphan it.
const sql = `
update public.craftbook
set content = ${TAG}${body}${TAG},
    title = ${lit(entry.title)},
    tags = array[${entry.tags.map(lit).join(', ')}]::text[],
    pinned = ${entry.pinned},
    updated_at = now()
where user_id = ${lit(userId)}::uuid
  and (title = ${lit(entry.title)} or content ilike ${lit('%' + filename.replace(/\.md$/, '') + '%')})
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
if (!rows.length) {
  console.error(`  no row matched ${filename} for that user - nothing updated`)
  process.exit(1)
}
console.log(`  updated "${rows[0].title}" from ${filename} (${rows[0].len} chars)`)
