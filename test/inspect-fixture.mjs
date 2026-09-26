import fs from 'node:fs'
const f = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
console.log('  entries:', f.entries.length)
for (const e of f.entries) {
  const fences = (e.content.match(/^```/gm) || []).length
  console.log(`    - "${e.title}"  chars=${e.content.length}  fenceLines=${fences}`)
  console.log(`      head: ${JSON.stringify(e.content.slice(0, 70))}`)
}
