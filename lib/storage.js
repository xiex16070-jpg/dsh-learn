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

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { screenStatement } from './sanitize.js';

export const LOCK_STALE_MS = 30000;
export const LOCK_RETRY_MS = 25;
export const LOCK_TIMEOUT_MS = 4000;

export function nowIso() {
  return new Date().toISOString();
}

export { escapeBraces } from './sanitize.js';

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
   */
  const withLock = (fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) => {
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
    try {
      return fn();
    } finally {
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

  const loadState = () => readJson(files.state, {}) || {};
  const saveState = (state, { locked = false } = {}) => {
    const write = () => writeAtomic(files.state, `${JSON.stringify(state, null, 2)}\n`);
    if (locked) return write();
    return withLock(write);
  };
  /** Read-modify-write under one lock; the only safe way to touch state.json. */
  const updateState = (mutator) => withLock(() => {
    const state = loadState();
    const next = mutator(state) || state;
    writeAtomic(files.state, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });

  const readLedger = ({ limit = 0 } = {}) => readJsonl(files.ledger, { limit });
  const appendLedger = (entry) => {
    const safe = { ...entry };
    if (typeof safe.reason === 'string') safe.reason = screenStatement(safe.reason, { maxChars: 600 }).text;
    return appendJsonl(files.ledger, { at: nowIso(), ...safe });
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
    readLessons,
    appendLesson,
    loadPending,
    savePending,
    updatePending,
  };
}
