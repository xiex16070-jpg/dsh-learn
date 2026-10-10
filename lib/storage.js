/**
 * Plugin state on disk: atomic writes, append-only ledgers, and a lock that
 * actually holds.
 *
 * The old `withLock` ran the callback WITHOUT the lock when it could not
 * acquire one ("proceed without the lock rather than dropping work"). That
 * reads as a kindness but is a correctness bug: a read-modify-write of
 * `pending.json` from two sessions in one profile interleaves and one side's
 * work is silently lost, which is precisely the failure the lock exists to
 * prevent. Refusing to work is recoverable (the caller retries, and the item
 * stays in the queue); silently dropping work is not. So the lock either
 * covers the callback or the call fails loudly.
 *
 * Anything that becomes a stored lesson passes through `screenStatement` here.
 * That makes this module the second of the two mandatory funnels — a caller
 * that forgets to sanitize cannot bypass it.
 */

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { screenStatement } from './sanitize.js';

export const LOCK_STALE_MS = 30000;
export const LOCK_RETRY_MS = 25;
export const LOCK_TIMEOUT_MS = 4000;

/**
 * When the ledger is rotated, and how many rotations are kept.
 *
 * The ledger is append-only and was, until this, unbounded: 399 rows in 23 hours
 * came to 857KB, 78% of it `review.propose` rows each embedding the full arrays
 * of what was filed and what was skipped. Two separate problems wore one coat —
 * a row that stores a whole run's detail, and a file that never forgets. The
 * row is trimmed where it is written (see `lib/review.js`); the file is rotated
 * here, because a reader that needs all of it never existed and a reader that
 * needs the last 500 rows should not parse a year of them.
 */
export const LEDGER_ROTATE_BYTES = 2 * 1024 * 1024;
export const LEDGER_KEEP_ROTATED = 3;

/**
 * The same policy for `lessons.jsonl`, which had none.
 *
 * The ledger rotates and the lessons file did not, so the unbounded-growth defect
 * survived in the one file nobody was watching — 48KB and only growing when this was
 * written. Smaller threshold because the rows are bigger and the file is read by
 * `learn action=history`, which only ever wants the recent end.
 */
export const LESSONS_ROTATE_BYTES = 512 * 1024;
export const LESSONS_KEEP_ROTATED = 2;

/**
 * How many fingerprints `seen.json` keeps.
 *
 * The set exists to stop the same lesson being proposed twice, and it had no
 * ceiling: every review that found something new rewrote the whole file under
 * the lock, so the cost of the guard grew with the age of the install while the
 * benefit did not — a repeat of a rule written hundreds of proposals ago is not
 * a repeat anybody is going to hit. Far more than any library has rules, and the
 * oldest entries are the ones dropped first.
 */
export const SEEN_MAX = 5000;

/**
 * Every key `state.json` is allowed to carry, and therefore every key anything may read.
 *
 * `reviews` / `proposals_filed` / `rules_written` / `last_review_at` — `lib/review.js`
 * (the review counters, printed by `learn action=status`).
 * `curator_*` — `lib/curator.js` and `lib/tools.js` (the lifecycle counters, the pin set,
 * the pause flag, the last maintenance result).
 * `lastActivityAt` — `lib/curator.js` (the idle gate's clock, written on every capture).
 *
 * Adding a key here without adding its reader is the exact defect this list exists to catch;
 * the selftest asserts the whitelist and the written keys agree.
 */
export const STATE_KEYS = Object.freeze([
  'reviews',
  'proposals_filed',
  'rules_written',
  'last_review_at',
  'curator_runs',
  'curator_archived',
  'curator_last_run_at',
  'curator_last_result',
  'curator_pinned',
  'curator_paused',
  'lastActivityAt',
]);

export function nowIso() {
  return new Date().toISOString();
}

/** Sleep synchronously without a dependency: `Atomics.wait` on a scratch buffer. */
function sleepSync(ms) {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export function createStore({ root, dataDir = 'learn' }) {
  // Only two directories, because only two are ever written. `reports/` and
  // `staging/` used to sit here: both were created on every start and never
  // written by anything, which taught a reader of the disk layout that the
  // plugin kept run reports and staged drafts. It kept neither. A directory
  // that exists but never fills is worse than no directory — it is a claim.
  const dirs = {
    root,
    archive: join(root, 'archive'),
  };
  const files = {
    state: join(root, 'state.json'),
    ledger: join(root, 'ledger.jsonl'),
    lessons: join(root, 'lessons.jsonl'),
    pending: join(root, 'pending.json'),
    seen: join(root, 'seen.json'),
    lock: join(root, '.lock'),
    errorLog: join(root, 'last-error.log'),
  };

  for (const dir of Object.values(dirs)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort: a read-only home must still yield a working plugin */
    }
  }

  const warn = (message, error) => {
    try {
      appendFileSync(files.errorLog, `[${nowIso()}] ${message}${error ? ` :: ${error && error.message ? error.message : error}` : ''}\n`, 'utf8');
    } catch {
      /* nothing else we can do */
    }
  };

  const writeAtomic = (file, text) => {
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, text, 'utf8');
    try {
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
    return file;
  };

  const readJson = (file, fallback = null) => {
    try {
      if (!existsSync(file)) return fallback;
      const raw = readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      warn(`readJson failed: ${file}`, error);
      return fallback;
    }
  };

  const appendJsonl = (file, record) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  };

  const readJsonl = (file, { limit = 0 } = {}) => {
    try {
      if (!existsSync(file)) return [];
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
      const picked = limit > 0 ? lines.slice(-limit) : lines;
      const out = [];
      for (const line of picked) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* a torn final line from a killed process is expected; skip it */
        }
      }
      return out;
    } catch (error) {
      warn(`readJsonl failed: ${file}`, error);
      return [];
    }
  };

  /**
   * Cross-process mutual exclusion. `openSync(..., 'wx')` is the atomic
   * primitive; a stale lock (dead process, or a crash between create and
   * unlink) is reclaimed by age. Contention retries briefly and then throws —
   * it never silently degrades to an unlocked write.
   *
   * RE-ENTRANT within a process, by depth, keyed on the lock path.
   *
   * This is not a nicety. The lock is a file, so a second acquisition from the
   * same process sees `EEXIST` and waits for a holder that is itself — a
   * self-deadlock that ends in the timeout error, not in a retry that succeeds.
   * `review.remember()` opens one transaction around a whole decision
   * (`lib/review.js`, 「One transaction owns every decision derived from the
   * current skill file」) and calls `managed.claim()` inside it; that is the
   * correct shape — the sidecar write belongs to the same transaction — and the
   * only way to keep it is for the inner acquisition to join the outer one.
   *
   * Keyed by path, not by module: one process may hold several stores open (the
   * self-test does), and holding store A must never look like holding store B.
   */
  const heldDepth = new Map();
  const withLock = (fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) => {
    const depth = heldDepth.get(files.lock) || 0;
    if (depth > 0) {
      // Already ours. Run inline; the OUTERMOST frame still owns the release, so
      // the lock is held for exactly as long as the transaction lasts.
      heldDepth.set(files.lock, depth + 1);
      try {
        return fn();
      } finally {
        const next = (heldDepth.get(files.lock) || 1) - 1;
        if (next > 0) heldDepth.set(files.lock, next);
        else heldDepth.delete(files.lock);
      }
    }
    const started = Date.now();
    let fd = null;
    for (;;) {
      try {
        fd = openSync(files.lock, 'wx');
        writeFileSync(fd, `${process.pid} ${nowIso()}\n`, 'utf8');
        break;
      } catch (error) {
        if (error && error.code !== 'EEXIST') throw error;
        let age = 0;
        try {
          age = Date.now() - statSync(files.lock).mtimeMs;
        } catch {
          continue; // vanished between the open attempt and the stat: retry now
        }
        if (age > staleMs) {
          warn(`reclaimed stale lock (age ${age}ms)`);
          try {
            unlinkSync(files.lock);
          } catch {
            /* someone else won the race */
          }
          continue;
        }
        if (Date.now() - started > timeoutMs) {
          const holder = (() => {
            try {
              return readFileSync(files.lock, 'utf8').trim();
            } catch {
              return '?';
            }
          })();
          throw new Error(`无法获取技能库写锁（${files.lock}，持有者 ${holder}）。稍后重试；本次不作任何写入，避免覆盖并发会话的改动。`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    heldDepth.set(files.lock, 1);
    try {
      return fn();
    } finally {
      heldDepth.delete(files.lock);
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(files.lock);
      } catch {
        /* ignore */
      }
    }
  };

  /**
   * `state.json` is a counter file, so it has a schema — and it did not say so.
   *
   * Hermes's review found four keys with ZERO readers (`review_count`, `last_review_summary`,
   * `last_review_session` and `last_review_at`) sitting in the live file, rewritten by every
   * `updateState` because the mutator spreads whatever it loaded. Two of them were v0.1
   * leftovers that no version of this code has ever read; they survived because nothing ever
   * said which keys were real. A counter file with no schema is a file that grows dead keys
   * forever, and each one reads like state somebody might depend on.
   *
   * So the whitelist is the schema. Anything not named here is dropped on read and on write,
   * which means the next `updateState` prunes the leftovers that are already on disk.
   */
  const loadState = () => {
    const raw = readJson(files.state, {}) || {};
    const out = {};
    for (const key of STATE_KEYS) if (key in raw) out[key] = raw[key];
    return out;
  };
  const saveState = (state, { locked = false } = {}) => {
    const fresh = {};
    for (const key of STATE_KEYS) if (state && key in state) fresh[key] = state[key];
    const write = () => writeAtomic(files.state, `${JSON.stringify(fresh, null, 2)}\n`);
    if (locked) return write();
    return withLock(write);
  };
  /** Read-modify-write under one lock; the only safe way to touch state.json. */
  const updateState = (mutator) => withLock(() => {
    const state = loadState();
    const next = mutator(state) || state;
    // Through `saveState`, so the whitelist applies to what gets written and not only to
    // what gets read: a mutator that returns a key nobody declared is pruned here rather
    // than persisted as a fourth dead field for the next reviewer to find.
    saveState(next, { locked: true });
    return loadState();
  });

  const readLedger = ({ limit = 0 } = {}) => readJsonl(files.ledger, { limit });

  /**
   * Rotate an append-only file out from under nobody.
   *
   * Generic because the policy is: whoever appends, rotates first. Two files needed it
   * (`ledger.jsonl`, then `lessons.jsonl`) and the second one had silently gone without
   * — a `for` loop over two call sites is what keeps the third from forgetting.
   *
   * Runs before an append and only when the file has actually grown past the
   * threshold, so the common path is one `statSync`. The archived name carries a
   * date AND a base-36 timestamp: two rotations in one day are ordinary (the
   * threshold is a size, not a day), and a name that collides would make the
   * second one silently overwrite the first.
   */
  const rotateIfHuge = (file, { bytes, keep, prefix }) => {
    try {
      if (!existsSync(file)) return null;
      if (statSync(file).size < bytes) return null;
      const stamp = `${nowIso().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36)}`;
      const archived = join(dirs.root, `${prefix}-${stamp}.jsonl`);
      renameSync(file, archived);
      const pattern = new RegExp(`^${prefix}-\\d{8}-[a-z0-9]+\\.jsonl$`);
      const rotations = readdirSync(dirs.root)
        .filter((name) => pattern.test(name))
        .sort();
      for (const name of rotations.slice(0, Math.max(0, rotations.length - keep))) {
        try {
          unlinkSync(join(dirs.root, name));
        } catch {
          /* a rotation we cannot prune is a rotation we keep */
        }
      }
      return archived;
    } catch (error) {
      // Never let housekeeping stop a write. A file that grows too large is a
      // problem; a file that refuses to record what happened is a worse one.
      warn(`${prefix} rotation failed`, error);
      return null;
    }
  };

  const rotateLedgerIfHuge = () =>
    rotateIfHuge(files.ledger, { bytes: LEDGER_ROTATE_BYTES, keep: LEDGER_KEEP_ROTATED, prefix: 'ledger' });

  const rotateLessonsIfHuge = () =>
    rotateIfHuge(files.lessons, { bytes: LESSONS_ROTATE_BYTES, keep: LESSONS_KEEP_ROTATED, prefix: 'lessons' });

  const appendLedger = (entry) => {
    const textFields = new Set(['statement', 'reason', 'description', 'rule', 'note']);
    const screenValue = (value, key = '') => {
      if (typeof value === 'string' && textFields.has(key)) {
        return screenStatement(value, { maxChars: key === 'reason' ? 600 : 400 }).text;
      }
      if (Array.isArray(value)) return value.map((item) => screenValue(item));
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, screenValue(child, childKey)]));
      }
      return value;
    };
    const safe = screenValue({ ...entry });
    rotateLedgerIfHuge();
    return appendJsonl(files.ledger, { at: nowIso(), ...safe });
  };

  /**
   * `seen.json`: the fingerprints this library has already dealt with.
   *
   * `knownFingerprints()` in `lib/review.js` used to derive this by reading the
   * WHOLE ledger and collecting `fp` fields — the only unbounded reader left, and
   * it was exported and never called. It could not simply be deleted: the `novel`
   * gate above it was hardcoded `true`, which is why the doctor printed
   * `novel=ok` for every candidate ever judged. A sidecar is the version that can
   * be wired up: bounded, cheap, and it survives the ledger being rotated away.
   *
   * A Set, written as an array. Duplicates are impossible by construction; the
   * file is small enough that the whole thing is rewritten rather than appended.
   */
  const seenFingerprints = () => {
    const raw = readJson(files.seen, null);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.fingerprints) ? raw.fingerprints : [];
    return new Set(list.filter((value) => typeof value === 'string' && value));
  };

  /** Add fingerprints, under the lock, and only rewrite the file if it changed. */
  const rememberFingerprints = (values) => {
    const incoming = [...new Set([].concat(values ?? []).filter((value) => typeof value === 'string' && value))];
    if (!incoming.length) return seenFingerprints();
    return withLock(() => {
      const set = seenFingerprints();
      let added = 0;
      for (const value of incoming) {
        if (set.has(value)) continue;
        set.add(value);
        added += 1;
      }
      if (added) {
        // Insertion-ordered, so the tail is the newest — drop from the front.
        // The caller still gets the untrimmed set back for this pass; only what
        // is persisted is bounded.
        const list = [...set];
        const kept = list.length > SEEN_MAX ? list.slice(list.length - SEEN_MAX) : list;
        writeAtomic(files.seen, `${JSON.stringify({ version: 1, updatedAt: nowIso(), fingerprints: kept }, null, 2)}\n`);
      }
      return set;
    });
  };

  const readLessons = ({ limit = 0 } = {}) => readJsonl(files.lessons, { limit });

  /**
   * The lesson funnel. Every stored lesson is screened here regardless of which
   * module produced it, and a refusal is reported rather than swallowed.
   */
  const appendLesson = (lesson) => {
    const next = { ...lesson };
    for (const key of ['statement', 'reason', 'rule']) {
      if (typeof next[key] !== 'string') continue;
      const screened = screenStatement(next[key], { maxChars: key === 'rule' ? 400 : 1200 });
      next[key] = screened.text;
      if (screened.injection) {
        warn(`lesson ${key} 命中注入特征（${screened.injection}）`);
        return { ok: false, refused: `lesson.${key} 命中指令注入特征（${screened.injection}），未落盘` };
      }
    }
    const record = { at: nowIso(), ...next };
    rotateLessonsIfHuge();
    appendJsonl(files.lessons, record);
    return { ok: true, record };
  };

  const loadPending = () => {
    const raw = readJson(files.pending, []);
    return Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
  };
  const savePending = (items, { locked = false } = {}) => {
    const payload = { version: 1, updatedAt: nowIso(), items: Array.isArray(items) ? items : [] };
    const write = () => writeAtomic(files.pending, `${JSON.stringify(payload, null, 2)}\n`);
    if (locked) return write();
    return withLock(write);
  };
  /** Read-modify-write under one lock; the only safe way to touch pending.json. */
  const updatePending = (mutator) => withLock(() => {
    const raw = readJson(files.pending, []);
    const items = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
    const next = mutator(items) || items;
    writeAtomic(files.pending, `${JSON.stringify({ version: 1, updatedAt: nowIso(), items: next }, null, 2)}\n`);
    return next;
  });

  return {
    dirs,
    files,
    dataDir,
    nowIso,
    warn,
    writeAtomic,
    readJson,
    appendJsonl,
    readJsonl,
    withLock,
    loadState,
    saveState,
    updateState,
    readLedger,
    appendLedger,
    rotateLedgerIfHuge,
    rotateLessonsIfHuge,
    seenFingerprints,
    rememberFingerprints,
    readLessons,
    appendLesson,
    loadPending,
    savePending,
    updatePending,
  };
}
