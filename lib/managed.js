/**
 * Ownership and usage telemetry — kept OUT of SKILL.md.
 *
 * The previous version stamped `managed-by: '@dsh/learn'` into the user-visible
 * frontmatter of every learned skill. That is a design error with three
 * consequences, all real:
 *   - it puts plugin bookkeeping into a file the user authors and reads;
 *   - a hand edit silently drops it (the skill becomes "external" and the
 *     curator stops maintaining it);
 *   - it is trivially forgeable, so it can never be the authority for a
 *     destructive operation.
 *
 * So ownership lives in a sidecar next to the plugin's own state, and SKILL.md
 * keeps only human-meaningful provenance (which session a rule came from).
 * Same discipline as keeping telemetry out of a user-authored file: the guard
 * reads state the user never has to see or maintain.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SKILL_NAME } from './skillfile.js';
import { UMBRELLAS } from './review.js';

export const OWNER = 'dsh-learn';

/**
 * The plugin shipped under this name before it was published. Records written
 * back then name the old owner, and a rename must never orphan a skill the
 * plugin really did create — ownership is the authority for destructive
 * operations, so losing it would leave the skill permanently unmaintainable.
 */
export const LEGACY_OWNERS = ['@dsh/learn'];

export function isOurOwner(value) {
  const owner = String(value || '');
  return owner === OWNER || LEGACY_OWNERS.includes(owner);
}

/**
 * Umbrella skills this plugin owns by construction: never archivable.
 *
 * DERIVED, not written out. This list used to be a hand-copied array of four names, and
 * when `agent-engineering` became the fourth umbrella the array was not updated — so the
 * new umbrella was archivable after 30 idle days, deletable through
 * `learn_skill_manage delete`, and invisible to the by-construction ownership test in
 * `migrateOwnSkills`. Nothing failed loudly; the protection was simply absent for the one
 * skill the plugin had just invented. A second copy of a list is a second truth, and this
 * plugin spends its whole life catching those.
 *
 * `UMBRELLAS` is the one source; `DEFAULT_SKILL_NAME` is the other member. Both modules
 * are leaves in the import graph (`review.js` does not import this file), so there is no
 * cycle.
 */
export const BUILTIN_PROTECTED = Object.freeze([DEFAULT_SKILL_NAME, ...Object.keys(UMBRELLAS)]);

export function createManaged({ store }) {
  const file = join(store.dirs.root, 'managed.json');
  const usageFile = join(store.dirs.root, 'usage.json');
  let cache = null;
  let usageCache = null;

  /** mtime of a file, or 0 when it is missing or unreadable. */
  const stampOf = (target) => {
    try {
      return statSync(target).mtimeMs;
    } catch {
      return 0;
    }
  };

  const shapeSkills = (raw) => {
    const skills = raw && typeof raw.skills === 'object' && raw.skills ? raw.skills : {};
    return { version: 1, owner: OWNER, skills };
  };

  /**
   * The cache is keyed on the file's mtime, not on "we read it once".
   *
   * Two dsh instances share one `~/.dsh`, and this sidecar is the authority for
   * every destructive path. A cache that could never notice another process's
   * write answered `isManaged()` from a snapshot taken at activation — which is
   * how a skill this plugin really created reads as "not ours" (and becomes
   * permanently unmaintainable), or how a record naming somebody else is missed.
   * One `stat` per read is cheap; being wrong here is not.
   */
  const load = () => {
    const stamp = stampOf(file);
    if (cache && cache.stamp === stamp) return cache.data;
    const data = shapeSkills(store.readJson(file, {}));
    cache = { stamp, data };
    return data;
  };

  /**
   * Read-modify-write under the store lock, then drop the cache.
   *
   * Every mutation goes through here. The previous version loaded through the
   * cache and wrote with a bare `writeAtomic`, so two writers could each publish
   * a whole file and one of the two records would simply vanish — and the lock
   * this plugin already owns was never taken for it.
   */
  const mutateSkills = (mutate) => store.withLock(() => {
    const data = shapeSkills(store.readJson(file, {}));
    const result = mutate(data);
    store.writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    cache = null;
    return result;
  });

  /**
   * Record ownership. Called on every write path, so a skill created by this
   * plugin is always attributable even if the process dies mid-turn.
   */
  const claim = (name, facts = {}) => mutateSkills((data) => {
    const prev = data.skills[name] || {};
    data.skills[name] = {
      owner: OWNER,
      created: prev.created || facts.created || new Date().toISOString(),
      updated: new Date().toISOString(),
      ...(prev.adopted ? { adopted: prev.adopted } : {}),
      ...(facts.adopted ? { adopted: facts.adopted } : {}),
      ...(facts.source ? { source: facts.source } : prev.source ? { source: prev.source } : {}),
      // Every field falls back to what was already recorded: re-claiming a skill
      // must never quietly erase what the previous claim knew about it.
      ...(facts.kind ? { kind: facts.kind } : prev.kind ? { kind: prev.kind } : {}),
      ...(facts.rules !== undefined ? { rules: facts.rules } : prev.rules !== undefined ? { rules: prev.rules } : {}),
      ...(facts.file ? { file: facts.file } : {}),
      ...(facts.legacyPath ? { legacyPath: facts.legacyPath } : prev.legacyPath ? { legacyPath: prev.legacyPath } : {}),
    };
    return data.skills[name];
  });

  const release = (name) => mutateSkills((data) => {
    if (!data.skills[name]) return false;
    delete data.skills[name];
    return true;
  });

  const isManaged = (name) => {
    const record = load().skills[String(name || '')];
    if (!record) return false;
    // An owner field that names neither the current nor a legacy name is not
    // ours to destroy, even if the record exists.
    return record.owner === undefined || isOurOwner(record.owner);
  };
  const facts = (name) => load().skills[String(name || '')] || null;
  const names = () => Object.keys(load().skills);
  const list = () => ({ ...load().skills });

  const isProtected = (name) => BUILTIN_PROTECTED.includes(String(name || ''));

  /**
   * The single authorization decision for every destructive path. Returning a
   * reason (not a boolean) is deliberate: the tool reports it verbatim, so a
   * refusal explains itself instead of looking like a bug.
   */
  const canDestroy = (name, { adopt = false } = {}) => {
    const key = String(name || '');
    if (!key) return { ok: false, reason: '需要 name' };
    if (isProtected(key)) {
      return { ok: false, reason: `${key} 是插件自身的常驻技能（受保护名单），自动流程与工具都不能归档它` };
    }
    const record = load().skills[key];
    if (record && record.owner !== undefined && !isOurOwner(record.owner)) {
      return {
        ok: false,
        reason: `${key} 的记录写着别人（${record.owner}）的名字，不是本插件创建的，不能归档`,
        foreignOwner: String(record.owner),
      };
    }
    if (record) return { ok: true, name: key, record };
    if (adopt) return { ok: true, name: key, record: null, adopted: true };
    return {
      ok: false,
      reason: `${key} 不在本插件管理清单里（managed.json）。技能根是多个来源共享的，只有本插件自己创建的技能才能被自动流程归档；确实要归档请显式 adopt=true，它会在账本留痕`,
    };
  };

  // ------------------------------------------------------------------ usage
  const shapeUsage = (raw) => (raw && typeof raw.skills === 'object' && raw.skills ? raw : { version: 1, skills: {} });

  /** Same mtime-keyed cache, and the same reasoning, as `load()` above. */
  const loadUsage = () => {
    const stamp = stampOf(usageFile);
    if (usageCache && usageCache.stamp === stamp) return usageCache.data;
    const data = shapeUsage(store.readJson(usageFile, {}));
    usageCache = { stamp, data };
    return data;
  };

  /** Count a real load of a skill. The honest replacement for guessing. */
  const recordUse = (name, { session = '', at = new Date().toISOString() } = {}) => {
    const key = String(name || '');
    if (!key) return null;
    // Under the lock, and read fresh inside it: this is a read-modify-write of a
    // counter, and the whole point of the counter is that it is not lost.
    return store.withLock(() => {
      const data = shapeUsage(store.readJson(usageFile, {}));
      const prev = data.skills[key] || { loads: 0, sessions: [], firstAt: at };
      const rec = {
        loads: (prev.loads || 0) + 1,
        firstAt: prev.firstAt || at,
        lastAt: at,
        sessions: [...new Set([...(prev.sessions || []), session].filter(Boolean))].slice(-20),
      };
      data.skills[key] = rec;
      store.writeAtomic(usageFile, `${JSON.stringify(data, null, 2)}\n`);
      usageCache = null;
      return rec;
    });
  };

  const usageOf = (name) => loadUsage().skills[String(name || '')] || { loads: 0, sessions: [] };
  const usageAll = () => ({ ...loadUsage().skills });

  return {
    file,
    usageFile,
    OWNER,
    LEGACY_OWNERS,
    isOurOwner,
    claim,
    release,
    isManaged,
    facts,
    names,
    list,
    isProtected,
    canDestroy,
    BUILTIN_PROTECTED,
    recordUse,
    usageOf,
    usageAll,
    /**
     * Drop both caches. No longer required to notice another process's write —
     * the mtime stamp does that — but kept because a caller that has just written
     * the sidecar by hand should not have to reason about timestamp resolution.
     */
    invalidate() {
      cache = null;
      usageCache = null;
    },
  };
}
