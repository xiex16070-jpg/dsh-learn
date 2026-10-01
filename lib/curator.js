/**
 * Curator — lifecycle maintenance for learned skills.
 *
 * Four invariants, and every one of them is a promise the user can check:
 * maintenance is inactivity-triggered rather than scheduled; it seeds its clock
 * on first sight and defers one full interval; it NEVER deletes (archive only,
 * and an archive is a directory move that can be moved back); a pinned skill is
 * exempt from every automatic transition.
 *
 * One bug is worth recording because it made this whole module dead code while
 * the status tool cheerfully reported the opposite. The old `onTurnStop()` did:
 *
 *     state.lastEventAt = Date.now();
 *     scheduleCurator();                 // reads Date.now() - lastEventAt
 *
 * so idle time was always ~0 and the automatic path could never fire — yet
 * `learn_curator status` called `shouldRunNow({})`, whose `idleMs` defaulted to
 * +Infinity, and printed 「会」. A status call that answers a different question
 * than the scheduler is worse than no status call.
 *
 * The fix is structural: activity is recorded in ONE place, idle time is
 * derived from it in ONE function, and both the scheduler and the status tool
 * call that function. There is no second basis to disagree with.
 */

import { join } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function createCurator({ store, skills, managed, config, ledger = null }) {
  const { staleAfterDays, archiveAfterDays, minIdleHours, intervalHours, pinned = [] } = config.curator;

  /**
   * The ledger is the store: `createStore` exposes `appendLedger`/`readLedger`,
   * not an `append`/`read` pair. Accept either shape so a caller cannot hand in
   * something that looks like a ledger and throws on the first maintenance pass
   * — this exact mismatch only surfaced when a real `run()` executed.
   */
  const ledgerAppend = (entry) => {
    if (!ledger) return null;
    if (typeof ledger.appendLedger === 'function') return ledger.appendLedger(entry);
    if (typeof ledger.append === 'function') return ledger.append(entry);
    return null;
  };
  const ledgerRead = ({ limit = 0 } = {}) => {
    if (!ledger) return [];
    if (typeof ledger.readLedger === 'function') return ledger.readLedger({ limit });
    if (typeof ledger.read === 'function') return ledger.read({ limit });
    return [];
  };

  const pinnedSet = () => new Set([...(config.curator.pinned || []), ...(pinned || [])]);

  /**
   * Read a stored timestamp as epoch milliseconds.
   *
   * v0.1.0 stored `curator_last_run_at` as an ISO string; v0.2.0 stores a number.
   * `Number("2026-09-30T13:15:55.254Z")` is NaN, and every comparison against NaN
   * is false — which silently made the interval gate stop gating. Accept both
   * shapes (and give up to 0 for anything unparseable) instead of trusting one.
   */
  const toMillis = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  /** Observed activity clock. Kept in the store so it survives a restart. */
  const touch = (at = Date.now()) =>
    store.updateState((state) => {
      state.lastActivityAt = toMillis(at) || Date.now();
      return state;
    });

  /**
   * The single idle-time basis. `now` defaults to the wall clock; callers never
   * pass a fabric of their own.
   */
  const idleMs = (now = Date.now()) => {
    const state = store.loadState();
    const last = toMillis(state.lastActivityAt);
    if (!last) return Infinity; // never seen activity: a fresh install is idle
    return Math.max(0, now - last);
  };

  const isManaged = (name) => Boolean(managed && managed.isManaged(name));

  /** Per-skill usage, folded from the sidecar counters (real loads). */
  const usage = () => {
    const counts = managed ? managed.usageAll() : {};
    const out = {};
    for (const [name, rec] of Object.entries(counts)) {
      out[name] = { loads: rec.loads || 0, lastLoadAt: rec.lastAt || '', sessions: (rec.sessions || []).length };
    }
    return out;
  };

  const snapshot = () => {
    const now = Date.now();
    const state = store.loadState();
    const counts = usage();
    const rows = [];
    for (const entry of skills.list()) {
      const record = skills.read(entry.name);
      const ageDays = entry.updatedAt ? (now - Date.parse(entry.updatedAt)) / DAY_MS : 0;
      const protectedName = (managed && managed.isProtected(entry.name)) || pinnedSet().has(entry.name);
      const managedHere = isManaged(entry.name);
      rows.push({
        name: entry.name,
        description: record?.meta?.description || '',
        ageDays: Math.round(ageDays * 10) / 10,
        rules: skills.readRules(entry.name).length,
        loads: (counts[entry.name] && counts[entry.name].loads) || 0,
        pinned: pinnedSet().has(entry.name),
        protected: protectedName,
        managed: managedHere,
        legacy: Boolean(entry.legacy),
        file: entry.file,
        action: managedHere && !protectedName ? (ageDays >= archiveAfterDays ? 'archive' : ageDays >= staleAfterDays ? 'stale' : 'keep') : 'skip',
      });
    }
    return {
      skills: rows,
      lastRunAt: toMillis(state.curator_last_run_at) ? new Date(toMillis(state.curator_last_run_at)).toISOString() : '',
      runs: state.curator_runs || 0,
      archived: state.curator_archived || 0,
      // Never `new Date(junk).toISOString()` — that is a RangeError, and a stored
      // clock is exactly the kind of value that outlives the code that wrote it.
      lastActivityAt: toMillis(state.lastActivityAt) ? new Date(toMillis(state.lastActivityAt)).toISOString() : '',
      idleHours: Number.isFinite(idleMs(now)) ? Math.round((idleMs(now) / 3600000) * 10) / 10 : null,
      thresholds: { staleAfterDays, archiveAfterDays, minIdleHours, intervalHours },
    };
  };

  /**
   * Whether the AUTOMATIC path would run right now, using the same idle basis
   * the scheduler uses. No default of +Infinity — that default was the lie.
   */
  const shouldRunNow = ({ now = Date.now(), idleMs: override = null, force = false } = {}) => {
    if (force) return { run: true, reason: 'force' };
    const idle = override === null ? idleMs(now) : override;
    const state = store.loadState();
    const lastRunAt = toMillis(state.curator_last_run_at);
    if (!lastRunAt) {
      return { run: false, reason: '首次运行只记时间戳并推迟一个周期（避免刚装好就动技能库）', idleHours: idle / 3600000, seeded: true };
    }
    const sinceRunHours = (now - lastRunAt) / 3600000;
    if (Math.abs(sinceRunHours) < intervalHours) {
      return { run: false, reason: `距上次维护 ${sinceRunHours.toFixed(1)}h < 周期 ${intervalHours}h`, idleHours: idle / 3600000 };
    }
    if (idle / 3600000 < minIdleHours) {
      return { run: false, reason: `空闲 ${(idle / 3600000).toFixed(1)}h < 门槛 ${minIdleHours}h（会话活跃时不整理）`, idleHours: idle / 3600000 };
    }
    return { run: true, reason: `空闲 ${(idle / 3600000).toFixed(1)}h，距上次维护 ${sinceRunHours.toFixed(1)}h` };
  };

  /**
   * Seed on first sight: record the clock and do nothing else. A brand-new
   * install must not reorganize a skill library it has not observed yet.
   *
   * Accepts either a timestamp or `{ now }`, because both call shapes reach it
   * from the tool layer and from activation, and a silent `new Date({}).toISOString()`
   * is a RangeError rather than a fallback.
   */
  const seedIfNeeded = (when = Date.now()) => {
    const now = typeof when === 'number' ? when : Number(when && when.now) || Date.now();
    const state = store.loadState();
    if (state.curator_last_run_at) return false;
    store.updateState((next) => {
      next.curator_last_run_at = now;
      next.curator_seeded_at = next.curator_seeded_at || new Date(now).toISOString();
      if (!next.lastActivityAt) next.lastActivityAt = now;
      return next;
    });
    return true;
  };

  const applyTransitions = ({ dryRun = false, now = Date.now() } = {}) => {
    const moved = [];
    const skipped = [];
    for (const row of snapshot().skills) {
      if (row.action === 'archive') {
        if (dryRun) {
          moved.push({ name: row.name, action: 'archive', dryRun: true, ageDays: row.ageDays });
          continue;
        }
        const result = skills.archive(row.name, {
          archiveDir: join(store.dirs.archive, 'skills'),
          managed: isManaged,
          adopt: false,
        });
        if (result.ok) {
          if (managed) managed.release(row.name);
          moved.push({ name: row.name, action: 'archive', ageDays: row.ageDays, to: result.to });
        } else {
          skipped.push({ name: row.name, reason: result.reason });
        }
      } else if (row.action === 'stale') {
        skipped.push({ name: row.name, action: 'stale', ageDays: row.ageDays });
      }
    }
    return { moved, skipped };
  };

  const run = ({ dryRun = false, force = false, now = Date.now(), idleMs: override = null } = {}) => {
    const decided = shouldRunNow({ now, idleMs: override, force });
    if (!decided.run) return { ran: false, ...decided };
    const seeded = store.loadState().curator_last_run_at ? false : true;
    const result = applyTransitions({ dryRun, now });
    const summary = {
      ran: true,
      dryRun,
      reason: decided.reason,
      moved: result.moved,
      skipped: result.skipped,
      seeded,
      at: new Date(now).toISOString(),
    };
    if (!dryRun) {
      store.updateState((state) => {
        state.curator_last_run_at = now;
        state.curator_runs = (state.curator_runs || 0) + 1;
        state.curator_archived = (state.curator_archived || 0) + result.moved.length;
        state.curator_last_result = { at: summary.at, moved: result.moved.length, skipped: result.skipped.length, reason: decided.reason };
        return state;
      });
      if (ledger) {
        ledgerAppend({
          action: 'curator.run',
          reason: decided.reason,
          moved: result.moved.map((item) => item.name),
          skipped: result.skipped.length,
        });
      }
    }
    return summary;
  };

  const setPinned = (name, value = true) => {
    const key = String(name || '');
    if (!key) return { ok: false, reason: '需要 name' };
    const next = new Set(pinnedSet());
    if (value) next.add(key);
    else next.delete(key);
    store.updateState((state) => {
      state.curator_pinned = [...next];
      return state;
    });
    return { ok: true, name: key, pinned: value, pinnedList: [...next] };
  };

  /**
   * The automatic path's timer. Deliberately a real interval, not a
   * turn-stopping side effect: a long-lived process must be able to run
   * maintenance while nobody is talking to it, which is the entire point of an
   * inactivity-triggered curator. `unref()` keeps it from holding the host open.
   */
  const start = ({ onRun = null } = {}) => {
    seedIfNeeded();
    const periodMs = Math.max(60_000, Math.min(6 * 3600000, (intervalHours * 3600000) / 4));
    const timer = setInterval(() => {
      try {
        const decided = shouldRunNow();
        if (!decided.run) return;
        const result = run({});
        if (onRun && result.ran) onRun(result);
      } catch (error) {
        store.warn('curator timer failed', error);
      }
    }, periodMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
      stop: () => clearInterval(timer),
      periodMs,
      /** Exposed so a test can drive one tick without waiting. */
      tick: () => {
        const decided = shouldRunNow();
        return decided.run ? run({}) : { ran: false, ...decided };
      },
    };
  };

  return {
    snapshot,
    usage,
    idleMs,
    touch,
    seedIfNeeded,
    shouldRunNow,
    run,
    setPinned,
    isManaged,
    start,
    paths: { archive: join(store.dirs.archive, 'skills') },
  };
}
