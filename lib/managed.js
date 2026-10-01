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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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

/** Umbrella skills this plugin owns by construction: never archivable. */
export const BUILTIN_PROTECTED = ['self-learning-loop', 'durable-preferences', 'tool-recovery', 'environment-facts'];

export function createManaged({ store }) {
  const file = join(store.dirs.root, 'managed.json');
  const usageFile = join(store.dirs.root, 'usage.json');
  let cache = null;
  let usageCache = null;

  const load = () => {
    if (cache) return cache;
    const raw = store.readJson(file, {});
    const skills = raw && typeof raw.skills === 'object' && raw.skills ? raw.skills : {};
    cache = { version: 1, owner: OWNER, skills };
    return cache;
  };

  const save = () => {
    if (!cache) return;
    store.writeAtomic(file, `${JSON.stringify(cache, null, 2)}\n`);
  };

  /**
   * Record ownership. Called on every write path, so a skill created by this
   * plugin is always attributable even if the process dies mid-turn.
   */
  const claim = (name, facts = {}) => {
    const data = load();
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
    save();
    return data.skills[name];
  };

  const release = (name) => {
    const data = load();
    if (!data.skills[name]) return false;
    delete data.skills[name];
    save();
    return true;
  };

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
  const loadUsage = () => {
    if (usageCache) return usageCache;
    const raw = store.readJson(usageFile, {});
    usageCache = raw && typeof raw.skills === 'object' && raw.skills ? raw : { version: 1, skills: {} };
    return usageCache;
  };

  const saveUsage = () => {
    if (!usageCache) return;
    store.writeAtomic(usageFile, `${JSON.stringify(usageCache, null, 2)}\n`);
  };

  /** Count a real load of a skill. The honest replacement for guessing. */
  const recordUse = (name, { session = '', at = new Date().toISOString() } = {}) => {
    const key = String(name || '');
    if (!key) return null;
    const data = loadUsage();
    const prev = data.skills[key] || { loads: 0, sessions: [], firstAt: at };
    const rec = {
      loads: (prev.loads || 0) + 1,
      firstAt: prev.firstAt || at,
      lastAt: at,
      sessions: [...new Set([...(prev.sessions || []), session].filter(Boolean))].slice(-20),
    };
    data.skills[key] = rec;
    saveUsage();
    return rec;
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
    /** Test seam: drop caches so a fresh read sees another process's write. */
    invalidate() {
      cache = null;
      usageCache = null;
    },
  };
}
