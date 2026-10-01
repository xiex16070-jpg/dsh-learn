#!/usr/bin/env node
/**
 * loc-probe.mjs — is a *location* blocking app launch, or is it something else?
 *
 * The Hermes desktop app crashes with 0x80000003 (STATUS_BREAKPOINT) when started
 * from its own directory, while a byte-identical copy under %TEMP launches fine.
 * Before prescribing "move the app", rule out the alternatives: a transient process
 * holding a handle, or an ACL on the directory.
 *
 * Runs N launches per tree, alternating which tree goes first so a warming/cooling
 * effect cannot masquerade as a location effect.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

const SRC = process.argv[2]
const TREES = process.argv.slice(3)
const ROUNDS = Number(process.env.ROUNDS || 3)
const WAIT_MS = Number(process.env.WAIT_MS || 11000)

if (!SRC || TREES.length < 2) {
  console.error('usage: loc-probe.mjs <source-app-dir> <treeA> <treeB> [...]')
  process.exit(2)
}

const results = new Map(TREES.map((t) => [t, []]))

function probe(tree) {
  return new Promise((resolve) => {
    const exe = path.join(tree, 'Hermes.exe')
    const child = spawn(exe, [], {
      cwd: tree,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
      stdio: 'ignore',
      windowsHide: false,
    })
    let settled = false
    const finish = (verdict) => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve(verdict)
    }
    child.on('error', (err) => finish(`SPAWN-ERROR ${err.code || err.message}`))
    child.on('exit', (code, signal) => finish(`exit ${code}${code === null ? ` signal=${signal}` : ` 0x${(code >>> 0).toString(16).toUpperCase()}`}`))
    setTimeout(() => finish('STILL-RUNNING (launch ok)'), WAIT_MS)
  })
}

console.log(`source tree : ${SRC}`)
for (const t of TREES) {
  rmSync(t, { recursive: true, force: true })
  mkdirSync(t, { recursive: true })
  const r = await new Promise((res) => {
    const cp = spawn('robocopy', [SRC, t, '/E', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS'], { cwd: 'C:\\', stdio: 'ignore', windowsHide: true })
    cp.on('exit', (c) => res(c))
    cp.on('error', () => res(-1))
  })
  console.log(`prepared    : ${t}  (robocopy ${r})`)
}

for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 === 1 ? TREES : [...TREES].reverse()
  for (const tree of order) {
    const verdict = await probe(tree)
    results.get(tree).push(verdict)
    console.log(`  round ${round}  ${verdict.padEnd(26)} ${tree}`)
  }
}

console.log('\n==== verdict by location ====')
for (const [tree, vs] of results) {
  const ok = vs.filter((v) => v.includes('STILL-RUNNING')).length
  console.log(`  ${ok}/${vs.length} launched   ${tree}`)
}
