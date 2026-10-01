/**
 * Configuration.
 *
 * Every option here has a reader. The previous version shipped five keys
 * (`review.promoteScore`, `review.cooldownMs`, `generate.requireGates`,
 * `generate.namePrefix`, `generate.updateOwnOnly`) that existed only in
 * `DEFAULTS` and `normalizeConfig` — two references each, zero readers. A knob
 * that does nothing is worse than a missing knob: it makes the config file a
 * description of the system that is not true. If a key is added here, wire it
 * or delete it.
 */

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

/** Resolve the DSH home the same way the host does. */
export function resolveDshHome(config = {}) {
  const explicit = config.dshHome || config.dsh_home || process.env.DSH_HOME;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  return join(homedir(), '.dsh');
}

/**
 * Where learned skills live. A dedicated ROOT, not a subfolder: the host's
 * filesystem provider scans exactly one level below a root (`isPotentialSkillPath`
 * rejects `segments.length > 2`), so `<skills>/learned/<name>/SKILL.md` would be
 * invisible to the catalog. `lib/provider.js` registers this root with the host
 * as a skill provider of this plugin's own (rank 330), so it needs no host-side
 * configuration and takes effect without a restart.
 */
export const LEARNED_SUBPATH = join('skills', 'learned');

export const DEFAULTS = Object.freeze({
  skillsRoot: LEARNED_SUBPATH,
  legacySkillsRoot: 'skills',
  dataDir: join('learn', 'data'),
  capture: {
    maxSessions: 8,
    maxItemsPerSession: 120,
    maxItemChars: 400,
    /**
     * Tool names whose results are never observed. Empty by default: a tool
     * result only reaches the window when it classifies as a failure/success
     * signal AND carries a concrete handle, so a blanket deny-list would hide
     * real recoveries. Set it to quiet a chatty read-only tool.
     */
    ignoreTools: [],
    /**
     * Whether a *successful* call with no failure signal is still recorded as a
     * technique. Off by default: "the command worked" is not a lesson, and
     * turning it on floods the window with routine calls.
     */
    recordSuccesses: false,
  },
  review: {
    /** Minimum observation weight the automatic path will even look at. */
    minWeight: 2,
    /** Proposals filed per review pass. */
    maxProposals: 8,
    /** Review a session once this many observations have accumulated. */
    triggerObservations: 3,
    /** Soft ceiling on rules per umbrella; crossing it is reported. */
    ruleBudget: 24,
    /** Token similarity above which a statement reinforces an existing rule. */
    similarity: 0.6,
  },
  curator: {
    /** Days of no writes before a skill is reported stale (not touched). */
    staleAfterDays: 14,
    /** Days of no writes before a skill is archived. */
    archiveAfterDays: 30,
    /** Hours of user inactivity required before the automatic pass runs. */
    minIdleHours: 2,
    /** Minimum hours between automatic passes. */
    intervalHours: 24,
    /** Extra pinned names, on top of the persistence in state.json. */
    pinned: [],
  },
});

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const str = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const list = (value, fallback) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : fallback);

/** Merge user config over defaults, dropping nothing and inventing nothing. */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const dshHome = resolveDshHome(config);
  const skillsRootRaw = str(config.skillsRoot, DEFAULTS.skillsRoot);
  const legacyRaw = str(config.legacySkillsRoot, DEFAULTS.legacySkillsRoot);
  const dataDirRaw = str(config.dataDir, DEFAULTS.dataDir);
  const capture = config.capture && typeof config.capture === 'object' ? config.capture : {};
  const review = config.review && typeof config.review === 'object' ? config.review : {};
  const curator = config.curator && typeof config.curator === 'object' ? config.curator : {};

  return {
    dshHome,
    skillsRoot: isAbsolute(skillsRootRaw) ? skillsRootRaw : join(dshHome, skillsRootRaw),
    legacySkillsRoot: isAbsolute(legacyRaw) ? legacyRaw : join(dshHome, legacyRaw),
    dataDir: isAbsolute(dataDirRaw) ? dataDirRaw : join(dshHome, dataDirRaw),
    enabled: bool(config.enabled, true),
    capture: {
      maxSessions: Math.max(1, num(capture.maxSessions, DEFAULTS.capture.maxSessions)),
      maxItemsPerSession: Math.max(10, num(capture.maxItemsPerSession, DEFAULTS.capture.maxItemsPerSession)),
      maxItemChars: Math.max(80, num(capture.maxItemChars, DEFAULTS.capture.maxItemChars)),
      ignoreTools: list(capture.ignoreTools, DEFAULTS.capture.ignoreTools).map((tool) => tool.toLowerCase()),
      recordSuccesses: bool(capture.recordSuccesses, DEFAULTS.capture.recordSuccesses),
    },
    review: {
      minWeight: Math.max(1, num(review.minWeight, DEFAULTS.review.minWeight)),
      maxProposals: Math.max(1, num(review.maxProposals, DEFAULTS.review.maxProposals)),
      triggerObservations: Math.max(1, num(review.triggerObservations, DEFAULTS.review.triggerObservations)),
      ruleBudget: Math.max(5, num(review.ruleBudget, DEFAULTS.review.ruleBudget)),
      similarity: Math.min(0.95, Math.max(0.3, num(review.similarity, DEFAULTS.review.similarity))),
    },
    curator: {
      staleAfterDays: Math.max(1, num(curator.staleAfterDays, DEFAULTS.curator.staleAfterDays)),
      archiveAfterDays: Math.max(2, num(curator.archiveAfterDays, DEFAULTS.curator.archiveAfterDays)),
      minIdleHours: Math.max(0, num(curator.minIdleHours, DEFAULTS.curator.minIdleHours)),
      intervalHours: Math.max(1, num(curator.intervalHours, DEFAULTS.curator.intervalHours)),
      pinned: list(curator.pinned, DEFAULTS.curator.pinned),
    },
  };
}
