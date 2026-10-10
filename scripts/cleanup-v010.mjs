#!/usr/bin/env node
// One-shot data remediation for the v0.1.0 pollution described in the audit (P0-1 / P2).
//
// What it fixes:
//   1. skill files carry the v0.1.0 frontmatter telemetry (managed-by / learn.*) -> removed,
//      because ownership now lives in managed.json (sidecar) and frontmatter is user-owned.
//   2. umbrella skills polluted with a placeholder rule whose text is the plugin's own
//      English debug monologue -> that rule is removed.
//   3. <root>/pending.json in the OLD raw-array shape holding debug-era proposals whose
//      `statement` is reasoning prose, truncated at maxItemChars -> filtered and re-wrapped
//      into the v0.2.0 `{version, updatedAt, items}` envelope.
//   4. lessons.jsonl | ledger.jsonl debug-era lines whose statement/reason is prose-about-
//      the-plugin rather than a lesson about the user's project -> dropped.
//   5. the v0.1.0 data layout (<DSH_HOME>/learn/<file>) moved down into the v0.2.0 layout
//      (<DSH_HOME>/learn/data/<file>) -> copied, never clobbering a newer file.
//
// Dry run by default. Nothing is written without --apply. The teacher-written files are the
// plugin's own; no user-authored skill is touched (skills without the v0.1.0 markers are left
// strictly alone and reported as SKIP).
//
// Usage:
//   node cleanup-v010.mjs [--dsh-home <path>] [--apply]

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const homeFlag = argv.indexOf('--dsh-home')
const DSH_HOME = path.resolve(
  homeFlag >= 0 ? argv[homeFlag + 1] : process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
)

const SKILLS_ROOT = path.join(DSH_HOME, 'skills')
const LEARNED_ROOT = path.join(SKILLS_ROOT, 'learned')
// v0.1.0 wrote data at <dshHome>/learn/ (no `data` level); v0.2.0 keeps that path but treats
// each planar name as a field of the store. Accept both so a legacy tree is always found.
const DATA_ROOT = (() => {
  const flat = path.join(DSH_HOME, 'learn')
  const nested = path.join(flat, 'data')
  if (fs.existsSync(path.join(flat, 'pending.json')) || fs.existsSync(path.join(flat, 'state.json'))) return flat
  if (fs.existsSync(nested)) return nested
  return flat
})()

const OWNER = 'dsh-learn'
const V010_FRONT_KEYS = /^\s*(?:managed-by|learn\.)/

// A statement is debug-era noise if it is prose *about the plugin's own internals* or if it is
// the truncated reasoning text that produced P0-1. Real lessons name a tool, a path, a command,
// or a concrete symptom of the user's project — they are not deliberation.
const NOISE_MARKERS = [
  /I(?:'m| am) (?:checking|noticing|realizing|identifying|implementing|wondering)/i,
  /(?:the )?(?:false positive|dry.?run|regex|pattern|candidate|signal-to-noise|noise\b)/i,
  /(?:I|we) need to (?:figure out|examine|trace|look)/i,
  /tool(?:\s|-)?result|serialization|lossless JSON/i,
  /assistant (?:reasoning|messages?|prose)/i,
  /插件的|本插件|@dsh\/learn/,
]

const report = { scanned: [], changed: [], skipped: [], dropped: [], kept: [], notes: [] }
const rel = (p) => path.relative(DSH_HOME, p) || p
const say = (...a) => console.log(...a)

function isNoise(text = '') {
  const s = String(text)
  if (s.length >= 600) return true // truncated at the old capture.maxItemChars
  const hits = NOISE_MARKERS.filter((re) => re.test(s)).length
  return hits >= 2
}

// ---------------------------------------------------------------- frontmatter

function stripTelemetry(name, file) {
  const raw = fs.readFileSync(file, 'utf8')
  report.scanned.push(rel(file))
  if (!/^---\r?\n/.test(raw)) {
    report.skipped.push(`${rel(file)} — no frontmatter, left untouched`)
    return null
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) {
    report.skipped.push(`${rel(file)} — frontmatter not terminated, left untouched`)
    return null
  }
  const head = raw.slice(0, end)
  const tail = raw.slice(end)
  const lines = head.split(/\r?\n/)
  const keptHead = []
  const removed = []
  for (const line of lines) {
    if (V010_FRONT_KEYS.test(line)) removed.push(line.trim())
    else keptHead.push(line)
  }
  // `metadata:` becomes an empty map once its only children were telemetry -> drop it too.
  const prunedHead = []
  for (let i = 0; i < keptHead.length; i += 1) {
    const line = keptHead[i]
    if (/^\s*metadata:\s*$/.test(line)) {
      const next = keptHead[i + 1]
      if (next === undefined || !/^\s+\S/.test(next)) {
        removed.push(line.trim())
        continue
      }
    }
    prunedHead.push(line)
  }
  const body = tail
    .split(/\r?\n/)
    .filter((line) => {
      // P0-1: the placeholder rule whose text is the plugin's own debug monologue.
      if (/^\s*-\s+遵守用户要求：/.test(line)) {
        removed.push(line.trim().slice(0, 72) + '…')
        return false
      }
      // The old "rules live elsewhere" pointer is false once the file is empty.
      if (/^\s*-\s+/.test(line) && isNoise(line)) {
        removed.push('noise rule: ' + line.trim().slice(0, 72) + '…')
        return false
      }
      return true
    })
    .join('\n')

  if (!removed.length) {
    report.skipped.push(`${rel(file)} — no v0.1.0 telemetry found`)
    return null
  }
  // If 「## 规则」 is now empty, say so plainly instead of leaving a dangling heading.
  let out = prunedHead.join('\n') + body
  out = out.replace(
    /(##\s*规则\s*\n)(?!\s*-\s)/,
    (_m, h) =>
      `${h}（暂无规则。只有当你明确要求记住某件事、或纠正过同一个做法时，这里才会出现条目。）\n`,
  )
  out = out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
  report.changed.push({ file: rel(file), name, removed: removed.length, bytes: out.length })
  return out
}

// ---------------------------------------------------------------- pending.json

function cleanPending(file, managedNames) {
  const raw = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    report.notes.push(`pending.json unreadable (${err.message}) — left untouched`)
    return null
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : []
  const keep = []
  for (const item of items) {
    const why = isNoise(item?.statement || item?.fp || '')
      ? 'debug-era reasoning prose'
      : !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(item?.umbrella || ''))
        ? 'unknown umbrella'
        : null
    if (why) report.dropped.push({ id: item?.id, why, head: String(item?.statement || '').slice(0, 58) })
    else keep.push(item)
  }
  report.kept.push(...keep.map((k) => `${k.id} → ${k.umbrella}`))
  const shapeChanged = Array.isArray(parsed)
  if (!keep.length && !items.length && !shapeChanged) {
    report.skipped.push(`${rel(file)} — already empty`)
    return null
  }
  const out = JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), items: keep }, null, 2) + '\n'
  if (out === raw) {
    report.skipped.push(`${rel(file)} — already v0.2.0 shape`)
    return null
  }
  report.changed.push({
    file: rel(file),
    name: '(pending)',
    removed: items.length - keep.length,
    bytes: out.length,
    note: shapeChanged ? 're-wrapped into {version,updatedAt,items}' : 'filtered',
  })
  return out
}

// ---------------------------------------------------------------- jsonl

function cleanJsonl(file, fields) {
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const kept = []
  let dropped = 0
  for (const line of lines) {
    let row = null
    try {
      row = JSON.parse(line)
    } catch {
      dropped += 1
      continue
    }
    const text = fields.map((f) => row?.[f]).filter(Boolean).join(' ')
    if (isNoise(text)) {
      dropped += 1
      report.dropped.push({
        id: row?.id,
        why: `${path.basename(file)}: debug-era`,
        head: String(row?.statement || row?.rule || row?.reason || '').slice(0, 58),
      })
      continue
    }
    kept.push(line)
  }
  if (!dropped) {
    report.skipped.push(`${rel(file)} — nothing to drop (${lines.length} rows)`)
    return null
  }
  const out = kept.length ? kept.join('\n') + '\n' : ''
  report.changed.push({ file: rel(file), name: path.basename(file), removed: dropped, bytes: out.length, kept: kept.length })
  return out
}

// ---------------------------------------------------------------- main

say(`DSH_HOME  ${DSH_HOME}`)
say(`mode      ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`)
say('')

if (!fs.existsSync(SKILLS_ROOT)) {
  say(`! ${SKILLS_ROOT} does not exist`)
}

say('— skill files —')
for (const root of [SKILLS_ROOT, LEARNED_ROOT]) {
  if (!fs.existsSync(root)) continue
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    const next = stripTelemetry(entry.name, file)
    if (next && APPLY) fs.writeFileSync(file, next, 'utf8')
  }
}

say('')
say('— learn data —')
if (fs.existsSync(DATA_ROOT)) {
  const pending = path.join(DATA_ROOT, 'pending.json')
  if (fs.existsSync(pending)) {
    const next = cleanPending(pending, [])
    if (next && APPLY) fs.writeFileSync(pending, next, 'utf8')
  }
  for (const [name, fields] of [
    ['lessons.jsonl', ['statement', 'rule', 'reason']],
    ['ledger.jsonl', ['statement', 'rule', 'reason', 'title', 'summary']],
  ]) {
    const file = path.join(DATA_ROOT, name)
    const next = cleanJsonl(file, fields)
    if (next !== null && APPLY) fs.writeFileSync(file, next, 'utf8')
  }
} else {
  say(`(no data dir at ${DATA_ROOT})`)
}

say('')
say('— data layout —')
// v0.1.0 kept the store directly under <DSH_HOME>/learn; v0.2.0 nests it under
// learn/data. Same directory, one level deeper — so the legacy files are sitting
// BESIDE their new home, not somewhere else. Without this step the plugin starts
// with an empty ledger and a curator that has never been seeded.
const LEGACY_DATA = path.join(DSH_HOME, 'learn')
const NESTED_DATA = path.join(LEGACY_DATA, 'data')
const CARRY = ['state.json', 'pending.json', 'ledger.jsonl', 'lessons.jsonl', 'learning-graph.json']
if (path.resolve(DATA_ROOT) === path.resolve(LEGACY_DATA) && fs.existsSync(NESTED_DATA)) {
  const plan = []
  for (const name of CARRY) {
    const from = path.join(LEGACY_DATA, name)
    const to = path.join(NESTED_DATA, name)
    if (!fs.existsSync(from)) continue
    if (fs.existsSync(to)) {
      // state.json is the one file whose history is worth merging: the nested copy
      // may be a fresh seed written moments ago, while the legacy one carries the
      // real counters. Merge key-wise with the target winning — never overwrite.
      if (name === 'state.json') {
        try {
          const oldState = JSON.parse(fs.readFileSync(from, 'utf8'))
          const newState = JSON.parse(fs.readFileSync(to, 'utf8'))
          const missing = Object.keys(oldState).filter((k) => !(k in newState))
          if (missing.length) plan.push({ name, action: 'merge', keys: missing, from, to })
          else plan.push({ name, action: 'keep', why: '没有可补的键' })
        } catch (err) {
          plan.push({ name, action: 'keep', why: `读不动（${err.message}）` })
        }
        continue
      }
      plan.push({ name, action: 'keep', why: '目标已存在，不覆盖' })
      continue
    }
    plan.push({ name, action: 'copy', bytes: fs.statSync(from).size })
  }
  for (const p of plan) {
    if (p.action === 'copy') {
      if (APPLY) fs.copyFileSync(path.join(LEGACY_DATA, p.name), path.join(NESTED_DATA, p.name))
      report.changed.push({ file: rel(path.join(NESTED_DATA, p.name)), name: p.name, removed: 0, bytes: p.bytes, note: '从旧布局搬入（原文件保留）' })
    } else if (p.action === 'merge') {
      if (APPLY) {
        const oldState = JSON.parse(fs.readFileSync(p.from, 'utf8'))
        const newState = JSON.parse(fs.readFileSync(p.to, 'utf8'))
        for (const k of p.keys) newState[k] = oldState[k]
        fs.writeFileSync(p.to, JSON.stringify(newState, null, 2) + '\n', 'utf8')
      }
      report.changed.push({ file: rel(p.to), name: p.name, removed: 0, bytes: 0, note: `补齐旧计数器：${p.keys.join(', ')}` })
    } else {
      report.skipped.push(`${rel(path.join(NESTED_DATA, p.name))} — ${p.why}`)
    }
  }
  if (!plan.length) say('  (旧布局里没有可搬的数据文件)')
} else {
  say(`  (数据已经在 ${rel(DATA_ROOT)}，无需搬家)`)
}

say('')
say('— result —')
for (const c of report.changed) {
  const extra = c.note ? ` · ${c.note}` : ''
  const kept = c.kept === undefined ? '' : ` kept=${c.kept}`
  say(`  ${APPLY ? 'CHANGED' : 'would change'}  ${c.file}  −${c.removed}${kept}${extra} → ${c.bytes}B`)
}
for (const s of report.skipped) say(`  skip     ${s}`)
for (const d of report.dropped) say(`  dropped  ${d.id || '(no id)'}  [${d.why}]  ${d.head}`)
for (const k of report.kept) say(`  kept     ${k}`)
for (const n of report.notes) say(`  note     ${n}`)
say('')
say(`${report.changed.length} file(s) ${APPLY ? 'written' : 'pending'} · ${report.dropped.length} row(s) dropped · ${report.scanned.length} skill file(s) scanned`)
if (!APPLY && report.changed.length) say('re-run with --apply to write')
