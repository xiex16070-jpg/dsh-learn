/**
 * asar-inspect.mjs — list or extract entries from an Electron asar archive.
 *
 * Usage: node asar-inspect.mjs <archive.asar> [pathSubstring ...]
 *
 * The header stores each file entry's `offset` as a STRING (and directory
 * entries carry no offset at all), so coerce with Number() — guarding with
 * `typeof offset !== 'number'` silently matches nothing.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const asar = process.argv[2]
const wanted = process.argv.slice(3)
const outDir = process.env.OUT_DIR

const buf = readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const baseOffset = 16 + headerSize

const hits = []
function walk(node, path) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = path ? `${path}/${name}` : name
    if (entry.files) {
      walk(entry, p)
      continue
    }
    if (entry.offset === undefined || entry.offset === null) continue
    if (wanted.length && !wanted.some((w) => p.includes(w))) continue
    hits.push({ path: p, size: Number(entry.size), offset: Number(entry.offset) })
  }
}
walk(header, '')

for (const hit of hits) {
  if (outDir) {
    const dst = join(outDir, hit.path)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, buf.subarray(baseOffset + hit.offset, baseOffset + hit.offset + hit.size))
  } else {
    console.log(`${hit.size}\t${hit.path}`)
  }
}
console.error(`${outDir ? 'extracted' : 'matched'}=${hits.length}`)
