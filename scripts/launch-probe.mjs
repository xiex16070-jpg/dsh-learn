// Launch probe: start an executable and report its lifecycle without blocking.
// Usage: node launch-probe.mjs "<path-to-exe>" [seconds]
import { spawn } from 'node:child_process'

const exe = process.argv[2]
const seconds = Number(process.argv[3] ?? 15)
if (!exe) {
  console.error('usage: node launch-probe.mjs <exe> [seconds]')
  process.exit(2)
}

const startedAt = Date.now()
const child = spawn(exe, [], { detached: false, stdio: 'ignore', windowsHide: false })
let settled = null

child.on('error', (error) => {
  settled = { kind: 'error', message: error.message, code: error.code }
})
child.on('exit', (code, signal) => {
  settled = { kind: 'exit', code, signal, afterMs: Date.now() - startedAt }
})

const timer = setTimeout(() => {
  console.log(JSON.stringify({
    pid: child.pid ?? null,
    stillRunning: settled === null,
    settled,
    elapsedMs: Date.now() - startedAt,
  }, null, 2))
  if (settled === null) {
    console.log('VERDICT: still running after wait — the exe launched successfully')
    child.unref()
  } else if (settled.kind === 'error') {
    console.log(`VERDICT: spawn failed — ${settled.message}`)
  } else {
    console.log(`VERDICT: exited code=${settled.code} signal=${settled.signal} after ${settled.afterMs}ms`)
  }
  process.exit(0)
}, seconds * 1000)

timer.unref()
