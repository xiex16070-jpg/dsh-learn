#!/usr/bin/env node
/**
 * Re-judge everything currently queued in the live library and drop what the
 * CURRENT gates would refuse.
 *
 * Why this exists: when the gates get sharper, the rules get better but the
 * queue does not. A skill library that only ever grows is a junk drawer, and the
 * first live run is the proof — nine proposals were sitting in `pending.json`,
 * every one of them a transcript artifact, all of them carrying `ok: true`
 * because they were filed by the older, weaker gate.
 *
 * The script deliberately re-uses the plugin's own `review.gatesFor()`. A purge
 * tool with its own opinion about quality would drift from the plugin it is
 * cleaning up after.
 *
 * Usage:
 *   node scripts/purge-noise.mjs                 # dry run, prints the verdict
 *   node scripts/purge-noise.mjs --apply         # actually rewrite
 *   node scripts/purge-noise.mjs --dsh-home DIR  # target a different library
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { normalizeConfig } from '../lib/config.js';
import { createManaged } from '../lib/managed.js';
import { createSkills } from '../lib/skills.js';
import { createStore } from '../lib/storage.js';
import { createReview } from '../lib/review.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name, fallback) => {
  const hit = args.find((entry) => entry === name || entry.startsWith(`${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const dshHome = String(flag('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')));
const config = normalizeConfig({ dshHome });
const store = createStore({ root: config.dataDir, dataDir: config.dataDir });

// -- 1. re-judge the pending queue ------------------------------------------

const raw = store.loadPending();
const items = Array.isArray(raw) ? raw : (raw && raw.items) || [];
const noisy = [];

// Real services, not stubs. This script's whole argument is that it re-uses the
// plugin's own gates instead of holding its own opinion — and the first version
// proved the point by crashing: it hand-wrote a `skills` double with `list` and
// `readRules` but no `exists`, which was harmless only for as long as the `novel`
// gate was hardcoded to `true` (review.js, the v0.3.0 placebo). The moment
// `novel` started calling `allRules()` for real, the purge tool died with
// `TypeError: skills.exists is not a function` — a tool that had never been run
// against a working gate. A double that can drift from the interface it is
// doubling is not a shortcut, it is a second definition of the interface.
const skills = createSkills({
  root: config.skillsRoot,
  legacyRoot: config.legacySkillsRoot,
  protectedNames: config.curator.pinned,
});
const managed = createManaged({ store });

const probe = createReview({
  config,
  store,
  skills,
  managed,
  curator: { touch: () => {} },
  logger: console,
  capture: null,
});

console.log(`库：${config.dataDir}`);
console.log(`候选教训：${items.length} 条`);
console.log('');

const kept = [];
for (const item of items) {
  const verdict = probe.gatesFor({
    statement: item.statement,
    kind: item.kind,
    source: item.source,
    resolved: item.resolved,
    umbrella: item.umbrella,
  });
  const reasons = probe.gateReasons(verdict.gate, verdict.checks);
  if (!verdict.gate.ok) {
    noisy.push({ item, reasons });
    console.log(`  丢弃 ${item.id}  [${item.kind}/${item.source}] ${reasons}`);
  } else {
    kept.push(item);
  }
}

console.log('');
console.log(`保留 ${kept.length} 条，丢弃 ${noisy.length} 条`);
for (const item of kept) {
  console.log(`  · 保留 ${item.id}  [${item.kind}/${item.source}] ${String(item.statement).slice(0, 100).replace(/\s+/g, ' ')}`);
}

// -- 2. compact the ledger --------------------------------------------------

const ledgerFile = store.files.ledger;
let ledgerRows = [];
try {
  ledgerRows = readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
} catch {
  ledgerRows = [];
}

// A refusal that repeats is one decision, not N. The live run wrote 124
// identical `review.refuse` rows because the reviewer re-litigated the same
// candidate every tick; the ledger is a history, not a counter.
const seen = new Map();
const compacted = [];
for (const row of ledgerRows) {
  const key = `${row.action}|${row.fp || ''}|${row.reason || ''}|${row.id || ''}`;
  if (row.action === 'review.refuse' && seen.has(key)) {
    const first = seen.get(key);
    first.repeats = (first.repeats || 1) + 1;
    first.lastAt = row.at || first.lastAt;
    continue;
  }
  const copy = { ...row };
  seen.set(key, copy);
  compacted.push(copy);
}

console.log('');
console.log(`账本：${ledgerRows.length} 行 → ${compacted.length} 行（合并 ${ledgerRows.length - compacted.length} 行重复的拒收记录）`);

// -- 3. apply ---------------------------------------------------------------

if (!apply) {
  console.log('');
  console.log('（dry run，未写入任何文件。加 --apply 才会生效。）');
  process.exit(0);
}

if (noisy.length) {
  // savePending takes the ARRAY and writes the envelope itself. Handing it the
  // envelope instead silently queues nothing — which is how this script would
  // have "cleaned" a library by throwing away every good proposal with it.
  store.savePending(kept);
}
if (compacted.length !== ledgerRows.length) {
  const text = compacted.map((row) => JSON.stringify(row)).join('\n');
  store.writeAtomic(ledgerFile, text ? `${text}\n` : '');
}

console.log('');
console.log(`已写入：候选 ${kept.length} 条，账本 ${compacted.length} 行`);
