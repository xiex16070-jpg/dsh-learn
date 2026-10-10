/**
 * The learned-skill root as a first-class host skill provider.
 *
 * Why this exists: DSH's skill catalog is a layered registry of *providers*
 * (`@deepseek-ai/dsh-skill`), and the filesystem provider scans each registered
 * root exactly one level deep. `<dshHome>/skills/learned` is therefore invisible
 * until some row names it — and the obvious row, `skill-filesystem`, is
 * `disabled: true` in the host plane because the web app moved the per-agent
 * rows behind agent presets (`@deepseek-ai/dsh-web-app/cordis.patch.yml`, the
 * comment starting "The `skill` REGISTRY stays in the host plane"). A profile
 * patch that adds `customSkillDirs` to that disabled row composes cleanly and
 * does nothing.
 *
 * So this module stops asking the host for a favour and becomes the provider
 * itself: `registerProvider` files this plugin's own reader into the registry's
 * layer, which makes the dedicated folder part of the catalog with no host
 * configuration, no `cordis.patch.yml` surgery and no restart.
 *
 * The contract is `{ name, list(options), get(candidate, options) }`. Every
 * field is validated by the registry before it is used, and `validateCandidate`
 * *throws* on a bad row — which would take the whole catalog down with it. A
 * folder a user renamed to `My Skill` must never do that, so `list()` filters
 * aggressively and swallows its own read errors: an unreadable root contributes
 * nothing, and only rows that already satisfy the registry's own grammar are
 * ever emitted.
 *
 * Rank sits between the `custom` roots (300) and `user-dsh` (400): a learned
 * skill outranks a stale copy in the shared root while project roots (100/200)
 * still outrank everything this plugin knows.
 *
 * @module provider
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './skills.js';

/** Stable provider name; also the `provider` field every candidate must carry. */
export const LEARNED_PROVIDER = 'dsh-learn';

/** Precedence rank for learned skills. See the module comment for the choice. */
export const LEARNED_RANK = 330;

/** `source` shown in catalogs and in the "ignored because..." dedupe warning. */
export const LEARNED_SOURCE = 'learned';

/** The registry's public skill-name grammar, duplicated so a bad folder name is skipped here. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_INVOCATION = { modelInvocable: true, userInvocable: true };

/** Collapse a description to one line and clip it to something a catalog row can hold. */
function oneLine(value, limit = 400) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Frontmatter flag that is only true when the author wrote it as such. */
function flag(value, fallback) {
  if (value === undefined) return fallback;
  return !/^(?:false|no|0|off)$/i.test(String(value).trim());
}

/**
 * The trigger text a catalog row carries, under every spelling that has ever been
 * written into a learned file.
 *
 * The host's grammar is `whenToUse`, and `@deepseek-ai/dsh-skill-filesystem`
 * accepts `when-to-use`. This plugin wrote `learn-when` for several versions, so
 * every file written before v0.3.14 carries the old key — and a key the reader
 * does not know is a key the writer should not have written. Reading all three
 * means the fix needs no migration pass over the library.
 */
function whenToUseOf(meta) {
  return oneLine(meta?.whenToUse ?? meta?.['when-to-use'] ?? meta?.['learn-when'], 200);
}

/**
 * Build the provider over one learned-skill root.
 *
 * @param root - absolute path of the dedicated skills folder.
 * @param logger - optional logger for the one diagnostic worth emitting.
 * @param onLoad - optional `(name, options) => void`, called once per skill body
 *   the HOST actually asked for. This is the only honest usage signal there is:
 *   `list()` runs for the catalog on every collect and says nothing about use,
 *   while `get()` runs exactly when a skill is loaded into a session.
 * @returns the provider object handed to `ctx.skills.registerProvider`.
 */
export function createLearnedProvider({ root, logger, onLoad = null } = {}) {
  const dir = String(root ?? '');
  const warn = (message) => {
    try {
      logger?.warn?.(`[learn] ${message}`);
    } catch {
      /* logging must never break discovery */
    }
  };

  /** Absolute `SKILL.md` path for one folder, or null when it is not a skill. */
  const fileOf = (name) => {
    const dirPath = join(dir, name);
    const file = join(dirPath, 'SKILL.md');
    return existsSync(file) ? file : null;
  };

  const parse = (file) => {
    try {
      return parseFrontmatter(readFileSync(file, 'utf8'));
    } catch (error) {
      warn(`skill file unreadable, skipped: ${file} (${error?.message ?? error})`);
      return null;
    }
  };

  return {
    name: LEARNED_PROVIDER,

    /**
     * Invocation-neutral rows for every skill physically inside the root.
     * Never throws: a row that would fail the registry's own validation is
     * dropped instead, because one bad candidate aborts the whole collect.
     */
    list() {
      const candidates = [];
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        /* the folder does not exist yet: an empty contribution, not an error */
        return { candidates: [], complete: true };
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (!SKILL_NAME.test(name)) continue;
        const file = fileOf(name);
        if (!file) continue;
        const parsed = parse(file);
        if (!parsed) continue;
        const description = oneLine(parsed.meta.description);
        // The registry requires a non-empty description and throws otherwise.
        if (!description) continue;
        const candidate = {
          name,
          description,
          invocation: {
            modelInvocable: flag(parsed.meta['model-invocable'], DEFAULT_INVOCATION.modelInvocable),
            userInvocable: flag(parsed.meta['user-invocable'], DEFAULT_INVOCATION.userInvocable),
          },
          source: LEARNED_SOURCE,
          rank: LEARNED_RANK,
          provider: LEARNED_PROVIDER,
          path: file,
          locator: file,
        };
        const whenToUse = whenToUseOf(parsed.meta);
        if (whenToUse) candidate.whenToUse = whenToUse;
        candidates.push(candidate);
      }
      candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      return { candidates, complete: true };
    },

    /**
     * Full body for one selected candidate. Re-read at load time so a skill the
     * model just rewrote is never served from a stale parse.
     */
    get(candidate, options) {
      const file = candidate?.locator ?? candidate?.path ?? fileOf(candidate?.name);
      if (!file) throw new Error(`learned skill "${candidate?.name}" no longer exists`);
      const source = readFileSync(file, 'utf8');
      const parsed = parseFrontmatter(source);
      const name = candidate.name;
      const description = oneLine(parsed.meta.description);
      if (!description) throw new Error(`learned skill "${name}" has no description`);
      const whenToUse = whenToUseOf(parsed.meta);
      const definition = {
        name,
        description,
        ...(whenToUse ? { whenToUse } : {}),
        invocation: {
          modelInvocable: flag(parsed.meta['model-invocable'], DEFAULT_INVOCATION.modelInvocable),
          userInvocable: flag(parsed.meta['user-invocable'], DEFAULT_INVOCATION.userInvocable),
        },
        source: LEARNED_SOURCE,
        provider: LEARNED_PROVIDER,
        content: parsed.body,
        path: file,
      };
      // The load already succeeded by here. Telemetry is reported after the fact
      // and inside a guard, because a counter is never worth failing a load over.
      if (onLoad) {
        try {
          onLoad(name, options);
        } catch (error) {
          warn(`usage hook failed for ${name}: ${error?.message ?? error}`);
        }
      }
      return definition;
    },
  };
}

/**
 * Register the learned root with the host catalog.
 *
 * Runs through `ctx.inject` because `skills` is an optional capability: a
 * minimal host without a skill registry must still activate, it simply gets no
 * dedicated root. Registration is filed into the calling scope's layer, and
 * disposal is handed back so the plugin's single teardown effect owns it.
 *
 * @param ctx - the plugin context.
 * @param options - `{ root, disposers, onLoad }`; the learned dir, the teardown
 *   sink, and the per-load usage hook the curator's keep-alive is built on.
 * @returns a handle: `{ registered, refresh() }`. `registered` flips to true once
 *   the injection has run (it is asynchronous even when `skills` already exists);
 *   `refresh()` drops the registry's collect cache so a caller that just wrote a
 *   file into the root sees it immediately instead of after the next revision.
 */
export function registerLearnedProvider(ctx, { root, disposers, onLoad = null } = {}) {
  const sink = Array.isArray(disposers) ? disposers : [];
  const handle = { registered: false, refresh: () => false };
  if (typeof ctx?.inject !== 'function') return handle;
  try {
    ctx.inject(['skills'], (scoped) => {
      // `scoped.skills` is the Cordis service accessor (the same one
      // `@deepseek-ai/dsh-skill-filesystem` uses inside its own `apply`); the
      // `get()` fallback covers a context that only exposes the accessor form.
      const registry = scoped?.skills ?? scoped?.get?.('skills');
      if (!registry || typeof registry.registerProvider !== 'function') return;
      const log = scoped.logger ?? ctx.logger;
      try {
        const provider = createLearnedProvider({ root, logger: log, onLoad });
        // The control object is how a provider tells the registry that the
        // filesystem moved underneath it; without this the collect cache keeps
        // answering from a snapshot taken before the file existed.
        const dispose = registry.registerProvider((control) => {
          if (control && typeof control.invalidate === 'function') {
            handle.refresh = () => {
              try {
                control.invalidate();
                return true;
              } catch {
                return false;
              }
            };
          }
          return provider;
        });
        if (typeof dispose === 'function') sink.push(dispose);
        handle.registered = true;
        try {
          log?.info?.(`[learn] 专用技能根已注册为宿主技能提供者：${root}`);
        } catch {
          /* logging only */
        }
      } catch (error) {
        // A name collision or a hostile registry must not abort activation.
        try {
          log?.warn?.(`[learn] 注册专用技能根失败：${error?.message ?? error}`);
        } catch {
          /* ignore */
        }
      }
    });
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[learn] 注入 skills 服务失败：${error?.message ?? error}`);
    } catch {
      /* ignore */
    }
  }
  return handle;
}
