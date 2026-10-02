/**
 * dsh-learn — persistent learning for DSH.
 *
 * What it does, in one line: every session leaves behind reusable skills, and
 * nothing it learns is a self-imposed lie.
 *
 * The design rests on one split: the deterministic path may only *propose*, and
 * a skill file is written only when the model itself decides to write it.
 *
 *   the usual approach                      dsh-learn instead
 *   ─────────────────────────────────────   ────────────────────────────────────
 *   fork an agent after every turn to       observe the session/event feed and
 *                                           keep a bounded, distilled window
 *                                           (zero extra model calls)
 *   replay the transcript as cache-warm     never touch the conversation or the
 *   prompt                                  prompt — the prefix cache is sacred
 *   the fork's model decides what to save   the foreground model decides; the
 *                                           regex only proposes
 *   dispatch-side tool whitelist            validated writes only, through
 *                                           learn_skill_manage
 *   one ever-growing memory document        three class-level umbrellas, one
 *                                           write target each (no duplicate facts)
 *   a private second store                  plain DSH skills under
 *                                           <dshHome>/skills/learned/<name>/
 *   idle maintenance that deletes           curator.js, own timer, archive-only
 *   a hand-drawn diagram                    graph.js (plus optional plugin nodes)
 *
 * Invariants kept from the host: an optional service is probed with
 * `ctx.get(name)` (never property access), every disposer is collected into a
 * single `ctx.effect`, and injection is irreversible in practice — so this
 * plugin never mutates the prompt of a live session.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Capture } from './capture.js';
import { createCurator } from './curator.js';
import { makeExtractor } from './extract.js';
import { createGraph } from './graph.js';
import { createHostHooks } from './host.js';
import { createManaged } from './managed.js';
import { registerLearnedProvider } from './provider.js';
import { createReview } from './review.js';
import { createSkills } from './skills.js';
import { createStore, nowIso } from './storage.js';
import { createTools } from './tools.js';
import { CONFIG_SHAPE, normalizeConfig } from './config.js';
import { DEFAULT_SKILL_DESCRIPTION, DEFAULT_SKILL_NAME, defaultSkillText } from './skillfile.js';

export const name = 'learn';

/** Only `tools` is a hard dependency: a minimal host must still activate. */
export const inject = ['tools'];

/**
 * The options the AUTOMATIC review runs with.
 *
 * Named and exported because it used to be an inline literal, and the adversarial
 * audit's mutation test proved that flipping `dryRun` to `true` — which silently
 * disables the entire learning loop, since a dry run files nothing — left both
 * suites green. There was no selftest section for the index/session wiring at all,
 * so nothing could have noticed. A literal nobody can reach is not a decision, it
 * is a default that happens to compile.
 */
export const AUTO_REVIEW_OPTIONS = Object.freeze({ dryRun: false });

const LOG = '[learn]';

/** Tool names that mean "the model loaded a skill", across host versions. */
const SKILL_TOOLS = new Set(['skill', 'skills', 'skill-tool', 'tool-skill']);

/** `defineTool` is a convenience wrapper; a plain definition works too. */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    /* optional dependency: fall through */
  }
  return undefined;
}

export function applyImpl(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    try {
      ctx.logger?.info?.(`${LOG} disabled by config`);
    } catch {
      /* ignore */
    }
    return;
  }

  const disposers = [];
  const store = createStore({ root: config.dataDir });
  const managed = createManaged({ store });
  const skills = createSkills({
    root: config.skillsRoot,
    legacyRoot: config.legacySkillsRoot,
    protectedNames: managed.BUILTIN_PROTECTED,
  });

  // The dedicated root is only real once the HOST can see it, and nothing here
  // may assume that. `skills` starts with `live: false`, so discovery reads both
  // roots and every write still lands in the shared root the host already scans.
  // The probe below is what can change that, and it can only ever make the
  // plugin more organized, never less usable.
  const lastProbe = { value: { live: false, reason: '尚未探测' } };
  // Filled in once the tools exist; the probe reads it through this holder so
  // the closure order does not matter.
  let learnedProvider = { registered: false, refresh: () => false };
  const probeRoot = async () => {
    const result = await probeLearnedRoot({ ctx, skills, store, provider: learnedProvider });
    lastProbe.value = result;
    skills.setLive(result.live);
    try {
      store.updateState((current) => ({
        ...current,
        learned_root_live: result.live === true,
        learned_root_checked_at: nowIso(),
        learned_root_reason: result.reason || '',
      }));
    } catch (error) {
      store.warn('记录专用目录探测结果失败', error);
    }
    return result;
  };
  const settleRoot = async () => {
    const result = await probeRoot();
    if (!result.live) return result;
    try {
      const moved = migrateOwnSkills({ skills, managed, store });
      return { ...result, ...moved };
    } catch (error) {
      store.warn('收拢技能失败', error);
      return result;
    }
  };

  const capture = new Capture(config);
  const memoryRoot = findMemoryRoot(config.dshHome);
  const curator = createCurator({ store, skills, managed, config, ledger: store });
  const graph = createGraph({ config, store, skills, curator, managed, memoryRoot });

  const state = {
    reviewCount: 0,
    proposalsFiled: 0,
    curatorRuns: 0,
    inflight: new Set(),
    reviewTimer: null,
    hostHooks: null,
    startedAt: Date.now(),
  };

  const review = createReview({
    config,
    store,
    skills,
    managed,
    curator,
    logger: ctx.logger,
    capture,
    onAction() {
      try {
        graph.build();
      } catch {
        /* graph is an artefact, never a blocker */
      }
    },
  });

  // ------------------------------------------------------------------ tools
  const defineTool = ctx.__defineTool; // installed by the async wrapper below
  const tools = createTools({
    config,
    store,
    skills,
    managed,
    capture,
    review,
    curator,
    graph,
    logger: ctx.logger,
    defineTool,
    probeRoot,
    settleRoot,
    providerStatus: () => learnedProvider,
    hostHooks: () => state.hostHooks,
  });
  let registered = 0;
  const definitions = [
    tools.learn,
    tools.learnReview,
    tools.learnCurator,
    tools.skillManage,
    tools.learnSkills,
  ].filter(Boolean);
  for (const definition of definitions) {
    try {
      disposers.push(ctx.tools.register(definition));
      registered += 1;
    } catch (error) {
      store.warn(`register tool ${definition?.name} failed`, error);
    }
  }

  // --------------------------------------------------------------- capture
  const extract = makeExtractor();

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = sessionIdOf(session) || sessionIdOf(event);
      curator.touch();
      const ev = event || {};
      if (ev.type === 'user/message') {
        const source = ev.data?.source;
        // Only real user turns: plugin-injected context must never be memorized.
        if (source && source.kind && source.kind !== 'user') return;
        const cwd = extract.cwd(ev) || extract.cwd(session);
        const observed = capture.recordUserMessage(sessionId, extract.content(ev), { cwd, source });
        if (observed) scheduleReview();
        return;
      }
      if (ev.type === 'assistant/message') {
        if (capture.recordAssistantMessage(sessionId, extract.content(ev))) scheduleReview();
        return;
      }
      if (ev.type === 'tool/call') {
        // The result event does not carry the tool name; it points at the call.
        // Remember the call so the observation that follows is not anonymous.
        extract.noteCall(ev);
        return;
      }
      if (ev.type === 'tool/result') {
        const tool = extract.toolName(ev);
        const failed = extract.failed(ev);
        capture.recordToolResult(sessionId, { tool, failed, content: extract.content(ev), args: extract.args(ev) });
        // A real load is the only honest usage signal: count it in the sidecar
        // instead of guessing from a regex over the tool result.
        if (!failed && tool && SKILL_TOOLS.has(tool.toLowerCase())) {
          const loaded = extract.skillName(ev);
          if (loaded && skills.exists(loaded)) {
            managed.recordUse(loaded, { session: sessionId });
            store.appendLedger({ action: 'skill.load', skill: loaded, session: sessionId });
          }
        }
      }
    } catch (error) {
      store.warn('session/event handler failed', error);
    }
  });

  // Turn boundary: the review is scheduled, never awaited — self-improvement
  // must not block or delay a user-facing turn.
  ctx.on('agent/turn-stopping', () => {
    curator.touch();
    scheduleReview();
  });

  /**
   * The automatic pass files PROPOSALS only (see review.js). It is debounced so
   * a burst of events costs one pass, and it never awaits the tool boundary.
   */
  function scheduleReview() {
    if (state.reviewTimer) return;
    const delayMs = 4000;
    state.reviewTimer = setTimeout(() => {
      state.reviewTimer = null;
      try {
        for (const session of capture.sessions.keys()) {
          if (state.inflight.has(session)) continue;
          const window = capture.window(session);
          if (!window || window.items.length < config.review.triggerObservations) continue;
          state.inflight.add(session);
          try {
            const result = review.runReview(session, { ...AUTO_REVIEW_OPTIONS, minWeight: config.review.minWeight });
            state.reviewCount += 1;
            state.proposalsFiled += result.filed || 0;
            if (result.filed) {
              ctx.logger?.info?.(`${LOG} 会话 ${session} 记下 ${result.filed} 条候选（待模型确认），共 ${result.pendingTotal} 条待定`);
            }
          } finally {
            state.inflight.delete(session);
          }
        }
      } catch (error) {
        store.warn('scheduled review failed', error);
      }
    }, delayMs);
    if (typeof state.reviewTimer?.unref === 'function') state.reviewTimer.unref();
  }

  // ---------------------------------------------------------------- curator
  // Its own long-period timer, not a side effect of a turn boundary. The old
  // design measured idleness immediately after recording activity, so the
  // automatic path could never run — and the status tool disagreed with it.
  const curatorTimer = curator.start({
    onRun(result) {
      state.curatorRuns += 1;
      ctx.logger?.info?.(`${LOG} curator：归档 ${result.moved.length} 个，跳过 ${result.skipped.length} 个（${result.reason}）`);
      try {
        graph.build();
      } catch {
        /* ignore */
      }
    },
  });

  // The plugin's own skill file makes it discoverable and model-invocable
  // through the ordinary skills pipeline.
  //
  // It is written AFTER the probe, never before. Until `settleRoot()` answers,
  // `activeRoot()` is the shared root, so writing here produced a shared-root
  // copy next to an existing dedicated one — and the migration that followed
  // deleted whichever it judged stale. v0.3.0 wrote here, and lost its own
  // instructions on every start. Ordering the write after the probe means it
  // lands in the root the skill already lives in, and the migration never sees
  // two copies it did not create.
  function ensureOwnSkill() {
    try {
      const existing = skills.read(DEFAULT_SKILL_NAME);
      const wanted = defaultSkillText();
      if (!existing || existing.body.trim() !== wanted.trim() || existing.legacy) {
        const written = skills.write(DEFAULT_SKILL_NAME, {
          description: DEFAULT_SKILL_DESCRIPTION,
          body: wanted,
          meta: { 'learn-when': '当你想让「这次学到的东西」沉淀下来、或怀疑某个做法以前学过、或要查看学过什么时' },
        });
        if (written.ok) {
          managed.claim(DEFAULT_SKILL_NAME, { kind: 'self', source: 'activation', file: written.file, legacyPath: existing?.legacy ? existing.file : undefined });
        } else {
          store.warn(`self-learning-loop 写入被拒：${(written.refused || []).join('；')}`);
        }
      } else {
        managed.claim(DEFAULT_SKILL_NAME, { kind: 'self', source: 'activation', file: existing.file });
      }
    } catch (error) {
      store.warn('writing the plugin skill file failed', error);
    }
    return skills.read(DEFAULT_SKILL_NAME);
  }

  disposers.push(
    ctx.effect(() => {
      return () => {
        if (state.reviewTimer) clearTimeout(state.reviewTimer);
        state.reviewTimer = null;
        try {
          curatorTimer.stop();
        } catch {
          /* ignore */
        }
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose?.();
          } catch {
            /* keep disposing */
          }
        }
      };
    }, 'dsh-learn'),
  );

  ctx.logger?.info?.(
    `${LOG} active: ${registered} tools, skills → ${skills.learnedDir}, state → ${store.dirs.root}, memory nodes ← ${memoryRoot || 'none'}`,
  );

  // Register the dedicated root as a host skill provider before probing it.
  // The probe asks the catalog whether it can see a throwaway skill inside
  // `learnedDir`; once this provider answers, the answer becomes structural
  // rather than dependent on the host's disabled `skill-filesystem` row.
  learnedProvider = registerLearnedProvider(ctx, { root: skills.learnedDir, disposers });

  // Umbrellas written by an earlier version carry no ownership record, and the
  // migration path only moves what it can prove this plugin made. Adopt them
  // now, so an upgrade does not strand its own skills in the shared root.
  try {
    const adopted = review.claimUnowned();
    if (adopted.length) ctx.logger?.info?.(`${LOG} 接管旧版创建的类级技能：${adopted.join(', ')}`);
  } catch (error) {
    store.warn('接管旧版类级技能失败', error);
  }

  // Ask the host whether the dedicated root is really part of the catalog, then
  // finish the tidy-up if it is. Fire-and-forget on purpose: activation must not
  // wait on (or fail because of) an optional capability, and until this resolves
  // every write keeps going to the shared root.
  settleRoot()
    .then((result) => {
      if (result.live) {
        ctx.logger?.info?.(
          `${LOG} 专用技能目录已生效：${skills.learnedDir}（迁入 ${result.moved || 0} 个${result.pruned ? `，清理重复 ${result.pruned} 个` : ''}）`,
        );
      } else {
        ctx.logger?.info?.(`${LOG} 专用技能目录暂不可见：${result.reason}`);
      }
    })
    .catch((error) => store.warn('专用目录探测失败', error))
    // `finally`, not `then`: a probe that FAILED still has to leave the plugin's
    // own skill file on disk. The probe decides WHERE it lives, never WHETHER.
    .finally(() => {
      const own = ensureOwnSkill();
      if (own) ctx.logger?.info?.(`${LOG} 常驻技能 → ${own.file}`);
      // Same place, same reason: the guard compares against the roots, and until
      // the probe answers the plugin does not know which root a skill belongs in.
      try {
        state.hostHooks = createHostHooks({
          ctx,
          skills,
          store,
          pendingOf: () => store.loadPending() || [],
        });
        if (state.hostHooks.applied.length) {
          ctx.logger?.info?.(`${LOG} 宿主扩展点：${state.hostHooks.applied.join('、')}`);
        } else {
          ctx.logger?.info?.(`${LOG} 宿主扩展点：${state.hostHooks.reason}`);
        }
        disposers.push(() => state.hostHooks?.dispose?.());
      } catch (error) {
        store.warn('宿主扩展点挂载失败', error);
      }
    });
}

/** Async wrapper: resolves the optional defineTool once, then applies. */
export const apply = Object.assign(
  function apply(ctx, config) {
    const pending = loadDefineTool().then((defineTool) => {
      ctx.__defineTool = defineTool;
      applyImpl(ctx, config);
    });
    // Cordis tolerates a promise-returning apply; keep errors from vanishing.
    return pending.catch((error) => {
      try {
        ctx.logger?.error?.(`${LOG} apply failed: ${error?.stack || error}`);
      } catch {
        /* ignore */
      }
      throw error;
    });
  },
  { __impl: applyImpl },
);

/**
 * A real `Config`, when schemastery is there to build one.
 *
 * This used to be absent on purpose, and the reason was sound: Cordis reads
 * `runtime.Config["~standard"]` before it will call anything else, and a
 * schemastery-less object makes the entry fail to activate with
 * `TypeError: Cannot read properties of undefined (reading 'validate')`. The
 * conclusion drawn from that — "so export nothing" — cost more than it saved:
 * with no schema, `Config.listConfigs` cannot see the plugin and the patch layer
 * cannot check it, so every knob this plugin grew was unreachable from the
 * outside. The fix is not to go without, it is to only export a schema when the
 * schema library is genuinely importable.
 *
 * `normalizeConfig` still runs on the raw patch object and still clamps every
 * field; the schema is the discoverable, validated face of the same table. If it
 * ever disagreed with `normalizeConfig`, the selftest's
 * 「each config key has a reader」 section would not catch it — the two are kept
 * in step by listing the same keys in the same order, and the defaults here are
 * the same literals as `DEFAULTS` in config.js.
 */
async function loadConfigSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const Schema = mod?.default ?? mod;
    if (!Schema || typeof Schema.object !== 'function') return undefined;
    // One table, walked — not a second list of keys typed out beside the first.
    // `CONFIG_SHAPE` is plain data so the selftest can hold it against
    // `normalizeConfig({})` on a machine where schemastery is not installed at
    // all; this function only translates it.
    const build = (shape) => {
      const out = {};
      for (const [key, spec] of Object.entries(shape)) {
        if (spec && typeof spec === 'object' && !spec.type) {
          out[key] = Schema.object(build(spec));
        } else if (spec?.type === 'string[]') {
          out[key] = Schema.array(Schema.string());
        } else if (spec?.type === 'number') {
          out[key] = Schema.number();
        } else if (spec?.type === 'boolean') {
          out[key] = Schema.boolean();
        } else {
          out[key] = Schema.string();
        }
      }
      return out;
    };
    return Schema.object(build(CONFIG_SHAPE));
  } catch {
    // No schema library: the plugin still activates and `normalizeConfig` still
    // validates everything. Only discoverability is lost — and a missing schema
    // must never be fatal, because that is how the entry dies entirely.
    return undefined;
  }
}

export const Config = await loadConfigSchema();


// ------------------------------------------------------------------ helpers

/**
 * Which of the two copies of one skill is the survivor.
 *
 * Written down as its own pure function because the wrong answer here is silent
 * data loss, and the wrong answer was shipped: "the dedicated root wins" is
 * true only AFTER the activation window. During it, the shared root is where a
 * not-yet-live plugin writes, so the shared copy is regularly the newer one and
 * deleting it throws away the freshest text in the system.
 *
 * Rules, in order: an unreadable copy never wins; identical text settles on the
 * dedicated root (no rewrite needed); otherwise the newer mtime wins; and if the
 * timestamps tie while the text differs — the shape a truncated or restored
 * write leaves behind — the longer text wins.
 */
export function pickSurvivor(pair) {
  const learned = pair?.learned || null;
  const flat = pair?.flat || null;
  if (!learned && !flat) return { keep: null, why: '两边都没有这份技能' };
  if (!learned) return { keep: 'flat', why: '专用目录里没有这份技能' };
  if (!flat) return { keep: 'learned', why: '共享根里没有副本' };
  if (learned.unreadable && !flat.unreadable) return { keep: 'flat', why: '专用目录的副本读不出来，留共享根那份' };
  if (flat.unreadable && !learned.unreadable) return { keep: 'learned', why: '共享根的副本读不出来，留专用目录那份' };
  if (learned.text === flat.text) return { keep: 'learned', why: '两份内容相同' };
  const learnedAt = Date.parse(learned.mtime) || 0;
  const flatAt = Date.parse(flat.mtime) || 0;
  if (flatAt > learnedAt) return { keep: 'flat', why: `共享根的副本更新（${flat.mtime} > ${learned.mtime}）` };
  if (learnedAt > flatAt) return { keep: 'learned', why: `专用目录的副本更新（${learned.mtime} > ${flat.mtime}）` };
  return flat.text.length > learned.text.length
    ? { keep: 'flat', why: '时间戳相同，共享根的副本更长' }
    : { keep: 'learned', why: '时间戳相同，共享根的副本没有更长' };
}

/**
 * Move this plugin's own skills from the shared root into the dedicated root.
 *
 * Refuses to do anything until a live probe has proven the host can see the
 * dedicated root: a skill moved into an unregistered subfolder is invisible to
 * the catalog, which is the same as deleting it. Once that is proven, three
 * cases reach the move:
 *   1. a skill listed in `managed.json` — we created it, it is ours to move;
 *   2. a name this plugin creates itself (`self-learning-loop` plus the three
 *      umbrellas) — ours by construction, even on a first boot where the sidecar
 *      was lost;
 *   3. nothing else. A skill the user wrote by hand stays exactly where it is;
 *      relocating it would break paths and shell completions that point at it.
 */
function migrateOwnSkills({ skills, managed, store }) {
  if (!skills.legacyRoot) return { moved: 0, pruned: 0, skipped: '未配置共享技能根' };
  if (!skills.isLive()) return { moved: 0, pruned: 0, skipped: '专用目录还没被宿主登记为技能根，先不搬（搬了会从技能目录里消失）' };
  let moved = 0;
  let pruned = 0;
  for (const entry of skills.list()) {
    const name = entry?.name;
    if (!name) continue;
    const owned = managed.isManaged(name) || managed.BUILTIN_PROTECTED.includes(name);
    if (!owned) continue;
    if (skills.inLearned(name)) {
      // Both copies exist. v0.3.0 assumed the dedicated one was authoritative and
      // deleted the shared one unconditionally — which deleted the plugin's own
      // freshly-written text on every start, because activation writes before the
      // probe answers and therefore writes into the SHARED root. Authority is not
      // a property of a path; the newer bytes win, and the loser is recorded.
      if (skills.inFlat(name)) {
        const verdict = pickSurvivor(skills.copies(name));
        const result = verdict.keep === 'flat' ? skills.promoteFlat(name) : skills.dropFlatCopy(name);
        if (result?.ok) {
          pruned += 1;
          store.appendLedger({
            action: 'skill.dedupe',
            skill: name,
            kept: verdict.keep,
            why: verdict.why,
            dropped: result.dir || result.from || '',
          });
        } else if (result?.reason) {
          store.warn(`技能 ${name} 的重复副本没处理掉：${result.reason}`);
        }
      }
      continue;
    }
    if (!skills.migratable(name)) continue;
    const result = skills.adoptIntoRoot(name);
    if (result?.ok) {
      moved += 1;
      managed.claim(name, { kind: 'self', source: 'migration', file: result.file, from: result.from });
      store.appendLedger({
        action: 'skill.migrate',
        skill: name,
        from: result.from,
        to: result.file,
        reason: '技能迁入专用目录（customSkillDirs 根）',
      });
    } else if (result?.reason) {
      store.warn(`迁移技能 ${name} 失败：${result.reason}`);
    }
  }
  return { moved, pruned, skipped: null };
}

/** Tool names that mean "the model loaded a skill", across host versions. */
const PROBE_SKILL_NAME = 'learn-root-probe';

/** The host's catalog service, or null. Absent is normal, never fatal. */
function optionalSkillsService(ctx) {
  try {
    const direct = ctx?.skills;
    if (direct && typeof direct.list === 'function') return direct;
  } catch {
    /* a service property may throw when the service is not loaded */
  }
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('skills') : null;
    if (viaGet && typeof viaGet.list === 'function') return viaGet;
  } catch {
    /* optional capability */
  }
  return null;
}

/**
 * Ask the HOST whether it can actually see the dedicated root.
 *
 * The filesystem provider scans each root exactly one level deep, so a skill in
 * an unregistered subfolder exists on disk and nowhere else. The only
 * trustworthy answer comes from the host's own catalog: publish a throwaway
 * skill inside the dedicated root and see whether `ctx.skills.list()` reports
 * it. No catalog service means no proof, and no proof means no move — the user
 * asked to tidy the folder without ever breaking a skill, so the conservative
 * answer is the correct one.
 */
async function probeLearnedRoot({ ctx, skills, store, provider = null }) {
  const registry = optionalSkillsService(ctx);
  if (!registry) return { live: false, reason: '宿主没有暴露 skills 服务，无法确认专用目录是否可见' };
  const dir = join(skills.learnedDir, PROBE_SKILL_NAME);
  const file = join(dir, 'SKILL.md');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      ['---', `name: ${PROBE_SKILL_NAME}`, 'description: learn 专用目录可见性探针（用完即删）', '---', '', '临时探针，正常情况下你不会看到它。', ''].join('\n'),
      'utf8',
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // The registry caches a collect per (cwd, scope chain, revision). The file
      // above was written after the last revision, so a cached miss would answer
      // "no" forever; our own provider's control drops that snapshot.
      try {
        provider?.refresh?.();
      } catch {
        /* an unregistered provider simply has nothing to refresh */
      }
      try {
        const listed = await registry.list({});
        if (Array.isArray(listed) && listed.some((entry) => entry && entry.name === PROBE_SKILL_NAME)) {
          return { live: true, reason: `宿主技能目录已能看到 ${skills.learnedDir}（本插件自注册的技能提供者）` };
        }
      } catch (error) {
        if (attempt === 3) return { live: false, reason: `查询宿主技能目录失败：${error && error.message ? error.message : error}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { live: false, reason: `探针技能没有出现在宿主技能目录里：${skills.learnedDir} 还不被任何技能提供者覆盖` };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      store.warn('清理专用目录探针失败', error);
    }
  }
}

function findMemoryRoot(dshHome) {
  return `${dshHome}/.dsh-memory/data/mdcg/contextual`;
}

function sessionIdOf(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const id = raw.id ?? raw.sessionId ?? raw.session_id;
  return typeof id === 'string' ? id : '';
}

// Exported for the self-test: these three carry the "never break a skill"
// guarantee, so they must be exercisable without booting a host.
export { nowIso, migrateOwnSkills, probeLearnedRoot, optionalSkillsService };
