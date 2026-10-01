/**
 * Model-facing surface.
 *
 * Five tools, deliberately small and orthogonal:
 *   learn                — inspect, curate and repair the learned library
 *   learn_review         — run or preview the proposal pass now
 *   learn_curator        — inspect or run idle library maintenance
 *   learn_skill_manage   — the ONLY validated write path for a skill file
 *   learn_skills         — retrieval over the learned library
 *
 * Every destructive action goes through validation here, on one principle:
 * autonomous maintenance must be a validated operation, not a file write. The
 * model never gets a raw write tool pointed at the skills root — it asks, and
 * this file decides.
 *
 * Three fixes from the audit live in this file and are worth not regressing:
 *   - `delete`/`archive` USED to return before the managed check, so they could
 *     archive any directory under the shared skills root. Authorization is now
 *     the first statement in both branches, plus a protected list.
 *   - `minScore` used to be dead AND inverted (`force = args.minScore === undefined`
 *     meant passing it disabled the force). It is now a real threshold.
 *   - `learn_curator status` used to answer a different question than the
 *     scheduler (idleMs defaulted to +∞). Both now call `curator.shouldRunNow()`.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { CURATOR_INVARIANTS, DO_NOT_CAPTURE, READ_BEFORE_WRITE, REVIEW_PREFERENCE_ORDER, REVIEW_SIGNALS, REVIEW_STANCE, SKILL_QUALITY } from './blocks.js';
import { buildSkillBody, DESCRIPTION_LIMIT, LEARNED_SUBDIR, NAME_RE } from './skills.js';
import { screenDescription, hasInjection } from './sanitize.js';
import { RULE_BUDGET } from './review.js';
import { SUMMARY_FIELDS } from './fields.js';

const text = (text_) => [{ type: 'text', text: text_ }];

/** Which session an explicit note belongs to, without inventing an id. */
function sessionIdFrom(args) {
  const raw = args?.session ?? args?.sessionId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'note';
}

function output(render) {
  return { schema: { type: 'json' }, render: (_args, value) => render(value) };
}

const json = (value) => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/**
 * Tool results must be LOSSLESS JSON — the host rejects a value carrying
 * `undefined` ("value is not lossless JSON"), which surfaces to the model as a
 * failed call even though the work already happened. Optional fields are
 * everywhere in these records, so every result crosses this boundary first.
 */
function safeJson(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (Array.isArray(value)) return value.map(safeJson);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = safeJson(item);
  }
  return out;
}

const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');

// --------------------------------------------------------------- organize ---

/** Locate the profile directory that owns the running host, without guessing. */
function resolveProfileDir(config) {
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    process.env.DSH_PROFILE,
    join(config.dshHome, 'profiles', 'desktop'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const dir = resolve(String(candidate));
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'cordis.patch.yml'))) return dir;
  }
  const profilesRoot = join(config.dshHome, 'profiles');
  for (const candidate of candidates) {
    const dir = resolve(String(candidate));
    if (existsSync(join(dir, 'package.json')) || existsSync(profilesRoot) === false) return dir;
  }
  return resolve(candidates[candidates.length - 1]);
}

/** The loader entry id that owns skill-root discovery, and its package name. */
const SKILL_LOADER_ID = 'skill-filesystem';
const SKILL_LOADER_NAME = '@deepseek-ai/dsh-skill-filesystem';

/** Does this line open the loader list entry we need to extend? */
function isSkillLoaderHead(line) {
  const t = String(line);
  return (
    new RegExp(`^\\s*-\\s*id:\\s*['"]?${SKILL_LOADER_ID}['"]?\\s*$`).test(t) ||
    new RegExp(`^\\s*-\\s*name:\\s*['"]?${SKILL_LOADER_NAME.replace(/[/@]/g, (m) => `\\${m}`)}['"]?\\s*$`).test(t)
  );
}

/** Does this line open *any* top-level loader patch entry? */
function isAnyEntryHead(line) {
  return /^\s*-\s*(?:id|name):/.test(String(line));
}

/**
 * Add `customSkillDirs` to the host's `skill-filesystem` loader entry.
 *
 * This is the whole "organize into a folder" feature, and it is text surgery on
 * purpose: the plugin has no way to add a skill root at runtime (roots come only
 * from provider config), and pulling in a YAML dependency to rewrite two lines
 * would be a poor trade.
 *
 * A profile patch entry targets a loader entry by `id` — see the surrounding
 * lines of any real `cordis.patch.yml`, where every entry is
 * `- id: <loader-id>` plus the optional `name:` and `config:`. The built-in
 * provider is declared in the base layer as
 * `- id: skill-filesystem` / `name: '@deepseek-ai/dsh-skill-filesystem'`, so we
 * accept either spelling, and when the profile has no entry for it yet we append
 * one (that is exactly what a patch layer is for). The file is backed up first
 * and is never rewritten unless the anchors are understood.
 */
function patchProfileForRoot(profileDir, learnedDir, { dryRun = false } = {}) {
  const patchFile = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(patchFile)) return { ok: false, reason: `找不到 profile 补丁文件：${patchFile}` };
  const original = readFileSync(patchFile, 'utf8');
  const lines = original.split('\n');
  const quote = (value) => JSON.stringify(value);

  const headIndex = lines.findIndex(isSkillLoaderHead);
  let next;
  let mode;

  if (headIndex === -1) {
    // No entry for this loader yet: append one. `customSkillDirs` is additive —
    // the provider still keeps every default root.
    const block = [
      '',
      '# 让 dsh-learn 学到的技能作为一个独立技能根被宿主发现（子目录不会被扫描，',
      '# 所以「整理到文件夹」只能通过增加一个根来实现）。',
      `- id: ${SKILL_LOADER_ID}`,
      `  name: "${SKILL_LOADER_NAME}"`,
      '  config:',
      '    customSkillDirs:',
      `      - ${quote(learnedDir)}`,
    ];
    const trailing = lines.length && lines[lines.length - 1].trim() === '' ? lines.slice(0, -1) : lines;
    next = [...trailing, ...block, ''].join('\n');
    mode = 'appended';
  } else {
    // Find the end of this entry, then decide where `customSkillDirs` goes.
    let end = lines.length;
    for (let i = headIndex + 1; i < lines.length; i += 1) {
      if (isAnyEntryHead(lines[i])) {
        end = i;
        break;
      }
    }
    const block = lines.slice(headIndex, end);
    if (block.some((line) => /customSkillDirs\s*:/.test(line))) {
      return { ok: true, already: true, file: patchFile, note: 'customSkillDirs 已存在' };
    }
    const configAt = block.findIndex((line) => /^\s*config\s*:/.test(line));
    if (configAt !== -1) {
      const indent = (/^\s*/.exec(block[configAt]) || [''])[0] + '  ';
      const inserted = [`${indent}customSkillDirs:`, `${indent}  - ${quote(learnedDir)}`];
      next = [...lines.slice(0, headIndex + configAt + 1), ...inserted, ...lines.slice(headIndex + configAt + 1)].join('\n');
    } else {
      const indent = (/^\s*/.exec(block[0]) || [''])[0] + '  ';
      const inserted = [`${indent}config:`, `${indent}  customSkillDirs:`, `${indent}    - ${quote(learnedDir)}`];
      next = [...lines.slice(0, headIndex + 1), ...inserted, ...lines.slice(headIndex + 1)].join('\n');
    }
    mode = 'merged';
  }

  if (dryRun) return { ok: true, dryRun: true, file: patchFile, mode, preview: next };
  const backup = `${patchFile}.bak-learn-${Date.now().toString(36)}`;
  copyFileSync(patchFile, backup);
  writeFileSync(patchFile, next, 'utf8');
  return { ok: true, file: patchFile, backup, mode, added: learnedDir };
}

// ------------------------------------------------------------------ tools ---

export function createTools({ config, store, skills, managed, capture, review, curator, graph, logger, defineTool, probeRoot = null, settleRoot = null }) {
  const define = (spec) => {
    // `execute` is async on purpose (the host awaits it), and the result must
    // cross the lossless-JSON boundary. `raw` keeps a synchronous handle on the
    // unguarded implementation so the self-test can exercise the same logic
    // without every assertion becoming a promise.
    const guarded = { ...spec, execute: async (args, exec) => safeJson(await spec.execute(args, exec)) };
    Object.defineProperty(guarded, 'raw', { value: spec, enumerable: false });
    return typeof defineTool === 'function' ? defineTool(guarded) : guarded;
  };

  /**
   * Move this plugin's own skills out of the shared root into the dedicated one.
   *
   * Only skills this plugin owns are touched: a skill the user wrote by hand
   * keeps its path, because moving it would break whatever points at it. And
   * nothing is moved at all while the dedicated root is invisible to the host —
   * a skill that cannot be loaded is worse than a skill in a crowded folder.
   */
  const migrateLegacy = ({ dryRun = true, adopt = false } = {}) => {
    const candidates = skills.list({ includeLegacy: true }).filter((entry) => entry.legacy);
    const owned = candidates.filter((entry) => adopt || managed.isManaged(entry.name) || managed.BUILTIN_PROTECTED.includes(entry.name));
    const foreign = candidates.filter((entry) => !owned.includes(entry));
    const moved = [];
    const failed = [];
    for (const entry of owned) {
      if (dryRun) {
        moved.push({ name: entry.name, dryRun: true, to: skills.dirFor(entry.name) });
        continue;
      }
      const result = skills.adoptIntoRoot(entry.name);
      if (result.ok) {
        try {
          managed.claim(entry.name, { kind: 'learned', source: 'organize', legacyPath: result.from, file: result.file });
        } catch (error) {
          store.warn(`claim after migrate ${entry.name}`, error);
        }
        store.appendLedger({ action: 'skill.organize', skill: entry.name, from: result.from, to: result.to });
        moved.push({ name: entry.name, from: result.from, to: result.to });
      } else {
        failed.push({ name: entry.name, reason: result.reason });
      }
    }
    return {
      moved,
      failed,
      foreign: foreign.map((entry) => entry.name),
      remaining: skills.list({ includeLegacy: true }).filter((entry) => entry.legacy).length,
    };
  };

  // ---------------------------------------------------------------- learn ---
  const learn = define({
    name: 'learn',
    description: [
      '检视你自己的学习状态：已蒸馏的技能、还没成形的候选教训、技能加载台账、学习图。',
      '机制：每个回合结束后做一次事后审查，把会话里的纠正、失败与修法变成「候选教训」（propose），不直接写文件；',
      `确认写库走 learn_skill_manage create，或 learn action=note。技能库根目录 ${config.skillsRoot}。`,
      `动作：status（默认）| list | view | pending | history | undo | consolidate | organize | doctor | graph | note | pin | archive | restore-pending。`,
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'list', 'view', 'pending', 'history', 'undo', 'consolidate', 'organize', 'doctor', 'graph', 'note', 'pin', 'archive', 'restore-pending'],
        description: '要执行的动作，默认 status',
      },
      name: { type: 'string', description: '技能名（view / history / undo / pin / archive 用）' },
      ruleId: { type: 'string', description: '规则 id（undo 用；从 history 或 view 输出里取）' },
      statement: { type: 'string', description: 'note 动作要记的事实（会过一遍反垃圾门槛，达标才写成技能）' },
      kind: {
        type: 'string',
        enum: ['remember-request', 'user-preference', 'user-correction', 'durable-fact', 'technique', 'recovered-failure', 'skill-wrong'],
        description: 'note 动作：这条事实属于哪一类。用户要求记住/长期偏好用 remember-request，本环境事实用 durable-fact',
      },
      session: { type: 'string', description: 'note 动作：归属会话 id' },
      umbrella: { type: 'string', enum: ['durable-preferences', 'tool-recovery', 'environment-facts'], description: 'note 动作：指定类级技能' },
      pinned: { type: 'boolean', description: 'pin 动作：true 加 pin，false 取消' },
      adopt: { type: 'boolean', description: 'archive / organize 动作：连非本插件创建的技能一起处理（会在账本留痕）' },
      dryRun: { type: 'boolean', description: 'consolidate / organize 先预览再执行' },
      query: { type: 'string', description: 'view 动作的模糊匹配' },
      fp: { type: 'string', description: 'restore-pending 时指定要提升的候选 fingerprint' },
    },
    output: output((value) => (typeof value === 'string' ? text(value) : json(value))),
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const action = String(args.action || 'status').toLowerCase();
      const KIND_ALIASES = {
        'remember-request': 'REMEMBER_REQUEST',
        'user-preference': 'USER_PREFERENCE',
        'user-correction': 'USER_CORRECTION',
        'durable-fact': 'DURABLE_FACT',
        technique: 'TECHNIQUE',
        'recovered-failure': 'RECOVERED_FAILURE',
        'skill-wrong': 'SKILL_WRONG',
      };

      if (action === 'status') {
        const state = store.loadState();
        const snapshot = curator.snapshot();
        const pending = store.loadPending();
        const usage = curator.usage();
        const lines = [];
        const live = skills.isLive();
        lines.push(`技能写入位置 ${skills.activeRoot()}（${live ? '专用目录已生效' : `专用目录尚未生效，暂用共享根；登记目标 ${skills.learnedDir}`}）`);
        lines.push(`受管技能 ${managed.names().length} 个｜候选教训 ${pending.length} 条（其中已过门槛 ${pending.filter((item) => item.ok).length} 条）｜规则 ${snapshot.skills.reduce((n, item) => n + item.rules, 0)} 条`);
        lines.push(`自动审查 ${state.reviews || 0} 次（提出 ${state.proposals_filed || 0} 条）｜curator 运行 ${state.curator_runs || 0} 次（归档 ${state.curator_archived || 0} 个）`);
        const idle = snapshot.idleHours === null ? '从未有活动记录' : `${snapshot.idleHours}h 无活动`;
        lines.push(`最近活动 ${fmtTime(snapshot.lastActivityAt)}（${idle}）｜上次维护 ${fmtTime(snapshot.lastRunAt)}`);
        if (snapshot.skills.length) {
          lines.push('');
          for (const row of snapshot.skills) {
            const flags = [row.protected ? 'protected' : '', row.pinned ? 'pinned' : '', row.managed ? 'managed' : 'external', row.legacy && live ? '待收拢' : ''].filter(Boolean).join(',');
            const loads = usage[row.name] ? `｜加载 ${usage[row.name].loads}` : '';
            lines.push(`- ${row.name}（${flags || 'ok'}｜规则 ${row.rules}｜${row.ageDays} 天前${loads}）`);
          }
        }
        const dupes = review.allRules().length - new Set(review.allRules().map((rule) => rule.text)).size;
        if (dupes > 0) lines.push(`\n提示：有 ${dupes} 条文字完全相同的规则，可 learn action=consolidate 合并。`);
        return lines.join('\n');
      }

      if (action === 'list') {
        return curator.snapshot().skills.map((row) => ({
          name: row.name,
          description: row.description,
          rules: row.rules,
          loads: row.loads,
          ageDays: row.ageDays,
          managed: row.managed,
          protected: row.protected,
          legacy: row.legacy,
          file: row.file,
        }));
      }

      if (action === 'view') {
        const name = String(args.name || '').trim();
        if (name) {
          const record = skills.read(name);
          if (!record) return `技能不存在：${name}（技能根 ${skills.learnedDir}）`;
          if (!NAME_RE.test(name) && !record) return `技能名不合法：${name}`;
          return {
            name,
            file: record.file,
            description: record.meta.description || '',
            rules: skills.readRules(name).map((rule) => ({ id: rule.id, text: rule.text })),
            usage: managed.usageOf(name),
            body: record.body,
          };
        }
        const query = String(args.query || '').trim();
        if (!query) return 'view 需要 name 或 query';
        const hits = skills.search(query, 10);
        if (!hits.length) return `没有匹配「${query}」的技能。`;
        return ['## 匹配的技能', ...hits.map((hit) => `- ${hit.name}（相关度 ${Math.round(hit.score * 100) / 100}）${hit.description ? `\n  ${hit.description}` : ''}`)].join('\n');
      }

      if (action === 'pending') {
        const items = store.loadPending();
        if (!items.length) {
          return '候选教训 0 条。自动审查只提出候选、不直接写文件；确认要写成技能时用 learn_skill_manage create。';
        }
        const ready = items.filter((item) => item.ok);
        const lines = [`候选教训 ${items.length} 条（已过门槛 ${ready.length} 条）`];
        for (const item of items.slice(0, 20)) {
          const mark = item.ok ? '可写入' : '未过门槛';
          lines.push(`- [${mark}] ${item.id}｜${item.umbrella || '无类级技能'}｜${item.kind}｜命中 ${item.hits || 1} 次`);
          lines.push(`  陈述：${item.statement}`);
          if (!item.ok && item.reason) lines.push(`  未过原因：${item.reason}`);
          if (item.duplicateOf) lines.push(`  与既有规则相似 ${Math.round(item.duplicateOf.score * 100)}%：${item.duplicateOf.text}`);
        }
        lines.push('');
        lines.push('确认写入：learn_skill_manage create（或 learn action=note）；放弃：learn action=pending 后由你决定，或用 restore-pending 提升某条。');
        return lines.join('\n');
      }

      if (action === 'history') {
        const name = String(args.name || '').trim();
        if (!name) return 'history 需要 name（三个类级技能之一）';
        const history = review.historyOf(name);
        if (!history.ok) return history.reason;
        const lines = [
          `## ${name}`,
          `文件 ${history.file}`,
          `规则 ${history.rules.length} 条（软上限 ${history.budget.limit}）｜技能加载 ${history.usage.loads} 次（${history.usage.sessions} 个会话）`,
          '',
          '### 现有规则',
        ];
        for (const rule of history.rules) {
          const when = [rule.at, rule.session ? `会话 ${rule.session}` : '', rule.kindLabel].filter(Boolean).join(' · ');
          lines.push(`- [${rule.id}] ${rule.text}${when ? `\n  来自 ${when}` : ''}`);
        }
        if (history.lessons.length) {
          lines.push('', '### 写入记录');
          for (const lesson of history.lessons) {
            lines.push(`- ${fmtTime(lesson.at)} ${lesson.action}${lesson.ruleId ? ` (${lesson.ruleId})` : ''}${lesson.reason ? `｜${lesson.reason}` : ''}`);
          }
        }
        if (history.events.length) {
          lines.push('', '### 账本');
          for (const event of history.events.slice(0, 12)) {
            lines.push(`- ${fmtTime(event.at)} ${event.action}${event.ruleId ? ` ${event.ruleId}` : ''}${event.statement ? `：${event.statement}` : ''}`);
          }
        }
        lines.push('', `撤回某条：learn action=undo name=${name} ruleId=<上面的 id>`);
        return lines.join('\n');
      }

      if (action === 'undo') {
        const name = String(args.name || '').trim();
        const ruleId = String(args.ruleId || args.id || '').trim();
        if (!name || !ruleId) return 'undo 需要 name 和 ruleId（先用 learn action=history 看 id）';
        const result = review.undoRule(name, ruleId, { reason: 'learn action=undo' });
        if (!result.ok) return result.reason;
        return `已撤回 ${name} 里的规则 ${ruleId}：${result.removed.text}\n剩余 ${result.remaining} 条规则。账本已留痕，可 learn action=history ${name} 复查。`;
      }

      if (action === 'consolidate') {
        const result = review.consolidate({
          umbrella: args.umbrella ? String(args.umbrella) : null,
          dryRun: args.dryRun !== false,
          maxMerges: 30,
        });
        const lines = [result.dryRun ? '合并预览（未改动文件）' : '已合并'];
        for (const entry of result.report) {
          if (!entry.merges.length) {
            lines.push(`- ${entry.umbrella}：${entry.rules ?? entry.after} 条规则，无近似重复`);
            continue;
          }
          lines.push(`- ${entry.umbrella}：${entry.rules} 条 → ${entry.after ?? entry.rules - entry.merges.length} 条，合并 ${entry.merges.length} 组`);
          for (const merge of entry.merges.slice(0, 6)) {
            lines.push(`  · 保留 [${merge.into}]，并入 [${merge.dropped}]（相似 ${Math.round(merge.score * 100)}%）：${merge.droppedText}`);
          }
        }
        if (result.dryRun) lines.push('', '确认执行：learn action=consolidate dryRun=false');
        return lines.join('\n');
      }

      if (action === 'organize') {
        const dryRun = args.dryRun !== false;
        const profileDir = resolveProfileDir(config);
        const patch = patchProfileForRoot(profileDir, skills.learnedDir, { dryRun });
        const lines = [];
        lines.push(dryRun ? '整理预览（未改动任何文件）' : '整理结果');
        lines.push(`专用技能目录：${skills.learnedDir}`);
        lines.push(`宿主登记：${patch.ok ? (patch.already ? '已登记' : dryRun ? '待写入 profile 补丁' : '已写入 profile 补丁') : `未完成 —— ${patch.reason}`}`);
        if (patch.file) {
          lines.push(
            `profile 补丁：${patch.file}${patch.backup ? `（备份 ${patch.backup}）` : ''}` +
              `${patch.mode ? `｜方式：${patch.mode === 'appended' ? '新增条目' : '并入既有条目'}` : ''}`,
          );
        }

        // Registration alone proves nothing: the host reads skill roots at
        // startup, so until it has restarted the dedicated folder is still
        // invisible. Ask the live catalog before moving a single file.
        let live = skills.isLive();
        let liveReason = '';
        if (!dryRun) {
          const settled = typeof settleRoot === 'function' ? await settleRoot() : null;
          if (settled) {
            live = settled.live === true;
            liveReason = settled.reason || '';
          }
        } else if (typeof probeRoot === 'function') {
          const probed = await probeRoot().catch(() => null);
          if (probed) {
            live = probed.live === true;
            liveReason = probed.reason || '';
          }
        }
        lines.push(`宿主是否已能看到它：${live ? `是 —— ${liveReason || '探测通过'}` : `否 —— ${liveReason || '尚未探测'}`}`);

        const migration = migrateLegacy({ dryRun: dryRun || !live, adopt: args.adopt === true });
        if (!live) {
          lines.push(
            '',
            dryRun
              ? '现在还不能搬：技能根是宿主启动时读的，profile 补丁写完后必须重启 DSH，再跑一次 organize 才会真正迁移。'
              : '还没搬迁，技能都留在原处照常可用。重启 DSH 宿主后再跑一次 learn action=organize 即可完成收拢。',
          );
        } else {
          lines.push(`待收拢技能：${migration.moved.length + migration.failed.length} 个`);
        }
        for (const item of migration.moved) lines.push(`  · ${item.name}${item.dryRun || !live ? '（预览）' : ` → ${item.to}`}`);
        for (const item of migration.failed) lines.push(`  · ${item.name} 迁移失败：${item.reason}`);
        if (migration.foreign.length) {
          lines.push(
            `  · 不动这些（不是本插件创建的技能，位置由你说了算）：${migration.foreign.slice(0, 8).join(', ')}${migration.foreign.length > 8 ? ' …' : ''}`,
          );
        }

        if (!patch.ok && patch.reason) {
          lines.push('', `手工做法：在 ${join(profileDir, 'cordis.patch.yml')} 追加一条条目：`);
          lines.push(`- id: ${SKILL_LOADER_ID}`);
          lines.push(`  name: "${SKILL_LOADER_NAME}"`);
          lines.push('  config:');
          lines.push('    customSkillDirs:');
          lines.push(`      - ${JSON.stringify(skills.learnedDir)}`);
        }
        if (dryRun) lines.push('', '确认执行：learn action=organize dryRun=false（会备份 cordis.patch.yml）');
        return lines.join('\n');
      }

      if (action === 'doctor') {
        // Ask the profile patch itself, not a config key: what matters is
        // whether the HOST was told about the root, and only the patch file
        // knows that. `dryRun` makes this a pure read.
        const profileDir = resolveProfileDir(config);
        let registered = false;
        let patchNote = '';
        try {
          const probe = patchProfileForRoot(profileDir, skills.learnedDir, { dryRun: true });
          registered = Boolean(probe.already);
          patchNote = probe.ok
            ? registered
              ? ''
              : `（profile 补丁还没有这条；learn action=organize 会以「${probe.mode}」方式写入）`
            : `（${probe.reason}）`;
        } catch (error) {
          patchNote = `（读 profile 补丁失败：${error && error.message ? error.message : error}）`;
        }
        const customRoots = registered ? [skills.learnedDir] : config.hostCustomSkillDirs;
        const report = review.doctor({
          customRoots,
          learnedDir: skills.learnedDir,
          live: skills.isLive(),
          activeRoot: skills.activeRoot(),
        });
        const lines = [report.ok ? '自检通过' : '自检发现问题'];
        for (const check of report.checks) {
          lines.push(`${check.ok ? '✓' : '✗'} ${check.id}：${check.detail}${check.id === 'host-root' ? patchNote : ''}`);
        }
        return lines.join('\n');
      }

      if (action === 'graph') {
        const built = graph.build();
        return { file: graph.file, nodes: built.nodes.length, edges: built.edges.length, summary: built.summary };
      }

      if (action === 'note') {
        const statement = String(args.statement || args.text || '').trim();
        if (!statement) return 'note 需要 statement';
        if (hasInjection(statement)) {
          return `这条陈述命中「指令注入」特征，拒绝写入：技能库会自动加载进未来每个会话，这类文本只能当引用，不能落盘。请改写为描述性的做法。`;
        }
        const kind = KIND_ALIASES[String(args.kind || '').toLowerCase()] || 'TECHNIQUE';
        const result = review.remember({
          statement,
          kind,
          source: 'note',
          session: sessionIdFrom(args),
          umbrella: args.umbrella ? String(args.umbrella) : null,
          note: 'learn action=note',
        });
        if (!result.ok) {
          return [`未写入：${result.reason}`, result.checks ? `门槛明细：${result.checks.map((check) => `${check.id}=${check.ok ? 'ok' : check.reason}`).join('；')}` : ''].filter(Boolean).join('\n');
        }
        if (result.reinforced) {
          return `已并入既有规则（${result.umbrella} / ${result.ruleId}）：${result.rule}\n同一件事学第二次是加强，不再新增一条。`;
        }
        return [
          `已写入 ${result.umbrella} 的规则 ${result.ruleId}：${result.rule}`,
          `文件 ${result.file}`,
          result.warning || '',
        ].filter(Boolean).join('\n');
      }

      if (action === 'pin') {
        const name = String(args.name || '').trim();
        if (!name) return 'pin 需要 name';
        const result = curator.setPinned(name, args.pinned !== false);
        return `${result.pinned ? '已 pin' : '已取消 pin'}：${result.name}（当前 pin 列表：${result.pinnedList.join(', ') || '空'}）\npin 的技能跳过一切自动流转，包括归档。`;
      }

      if (action === 'archive') {
        const name = String(args.name || '').trim();
        if (!name) return 'archive 需要 name';
        // Authorization FIRST — this used to run after the existence check and
        // could therefore archive anything in the shared skills root.
        const verdict = managed.canDestroy(name, { adopt: args.adopt === true });
        if (!verdict.ok) return verdict.reason;
        const result = skills.archive(name, {
          archiveDir: join(store.dirs.archive, 'skills'),
          managed: (key) => managed.isManaged(key),
          adopt: args.adopt === true,
        });
        if (!result.ok) return result.reason;
        managed.release(name);
        store.appendLedger({ action: 'skill.archive', skill: name, from: result.from, to: result.to, adopted: result.adopted === true });
        return `已归档 ${name} → ${result.to}（不是删除，可原样移回）${result.adopted ? '\n注意：该技能不是本插件创建的，这次归档是你显式 adopt 的结果，账本已留痕。' : ''}`;
      }

      if (action === 'restore-pending') {
        const fp = String(args.fp || args.id || '').trim();
        if (!fp) return 'restore-pending 需要 fp（从 learn action=pending 的输出里取）';
        const result = review.promoteProposal(fp, { session: sessionIdFrom(args) });
        return result.ok ? `已提升为规则：${result.rule || result.ruleId}` : `未提升：${result.reason}`;
      }

      return `未知动作：${action}`;
    },
  });

  // ---------------------------------------------------------- learn_review ---
  const learnReview = define({
    name: 'learn_review',
    description: [
      '对当前会话跑一次事后审查：把窗口里的纠正、失败与修法变成「候选教训」。',
      '注意：自动审查只提出候选（propose），不写技能文件。确认要写时用 learn_skill_manage create 或 learn action=note。',
      'dry-run 只列出会提出哪些候选，不落盘。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['run', 'dry-run'], description: 'run 真写候选队列；dry-run 只看会做什么，默认 dry-run' },
      session: { type: 'string', description: '目标会话 id，默认当前会话' },
      minWeight: { type: 'number', description: '覆盖观测权重门槛（默认取配置）' },
    },
    output: output((value) => json(value)),
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const session = String(args.session || '').trim();
      const dryRun = String(args.action || 'dry-run').toLowerCase() !== 'run';
      const sessions = session ? [session] : [...capture.sessions.keys()];
      if (!sessions.length) return { ok: true, note: '当前没有观测窗口（这个进程还没看到会话事件）', sessions: [] };
      const results = sessions.map((id) => review.runReview(id, {
        dryRun,
        minWeight: Number.isFinite(Number(args.minWeight)) ? Number(args.minWeight) : config.review.minWeight,
      }));
      const filed = results.reduce((n, result) => n + (result.filed || 0), 0);
      return {
        ok: true,
        dryRun,
        sessions: results.map((result) => ({
          session: result.session,
          observations: result.observations,
          filed: result.filed,
          pendingTotal: result.pendingTotal,
          proposals: result.proposals,
          skipped: result.skipped,
        })),
        filed,
        next: dryRun ? '确认要记的话：learn_review action=run，再用 learn_skill_manage create 落成技能' : '用 learn action=pending 查看候选',
      };
    },
  });

  // --------------------------------------------------------- learn_curator ---
  const learnCurator = define({
    name: 'learn_curator',
    description: [
      '技能库的闲置维护（curator）：按活动时间流转生命周期、只归档不删除、pin 的技能跳过一切自动流转。',
      '动作：status（默认）| run | dry-run | pause | resume。',
      '它空闲触发，没有常驻定时器；用户前台回合永远优先',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['status', 'run', 'dry-run', 'pause', 'resume'], description: '默认 status' },
      force: { type: 'boolean', description: 'run 时忽略「距上次维护不足一个周期 / 未空闲」的闸门' },
    },
    output: output((value) => (typeof value === 'string' ? text(value) : json(value))),
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = String(args.action || 'status').toLowerCase();
      if (action === 'status') {
        const snapshot = curator.snapshot();
        // The SAME decision function the scheduler uses. The old tool answered
        // with idleMs = +∞ and cheerfully printed 「会」 while the real gate was
        // closed forever, which is worse than no status at all.
        const decision = curator.shouldRunNow({});
        const state = store.loadState();
        const lines = [
          `受管技能 ${snapshot.skills.filter((row) => row.managed).length} 个｜受保护 ${snapshot.skills.filter((row) => row.protected).length} 个`,
          `空闲 ${snapshot.idleHours === null ? '未知' : `${snapshot.idleHours}h`}｜上次维护 ${fmtTime(snapshot.lastRunAt)}｜已运行 ${snapshot.runs} 次｜已归档 ${snapshot.archived} 个`,
          `门槛：${snapshot.thresholds.staleAfterDays} 天未更新=陈旧（只报告）、${snapshot.thresholds.archiveAfterDays} 天=归档、空闲 ≥${snapshot.thresholds.minIdleHours}h、周期 ≥${snapshot.thresholds.intervalHours}h`,
          `现在会不会跑：${decision.run ? '会' : '不会'}（${decision.reason}）`,
          state.curator_paused ? '自动维护已暂停（pause）。' : '',
        ].filter(Boolean);
        if (snapshot.skills.length) {
          lines.push('');
          for (const row of snapshot.skills) {
            lines.push(`- ${row.name}｜${row.action}${row.pinned ? '｜pinned' : ''}${row.protected ? '｜protected' : ''}${row.managed ? '' : '｜external(跳过)'}｜${row.ageDays} 天`);
          }
        }
        return lines.join('\n');
      }
      if (action === 'pause' || action === 'resume') {
        store.updateState((state) => {
          state.curator_paused = action === 'pause';
          return state;
        });
        return action === 'pause' ? '自动维护已暂停（手动 learn_curator run 仍可用）。' : '自动维护已恢复。';
      }
      if (store.loadState().curator_paused && action === 'run' && args.force !== true) {
        return '自动维护处于暂停状态；确实要跑请加 force=true。';
      }
      const result = curator.run({ dryRun: action === 'dry-run', force: args.force === true });
      if (!result.ran) return `没有运行：${result.reason}`;
      const lines = [
        result.dryRun ? '维护预览（未改动文件）' : '维护已完成',
        `原因：${result.reason}`,
        `归档 ${result.moved.length} 个${result.moved.length ? `：${result.moved.map((item) => item.name).join(', ')}` : ''}`,
        `跳过 ${result.skipped.length} 个`,
      ];
      for (const item of result.skipped.slice(0, 10)) lines.push(`- 跳过 ${item.name}${item.reason ? `：${item.reason}` : item.action ? `（${item.action}，${item.ageDays} 天）` : ''}`);
      lines.push('', CURATOR_INVARIANTS.trim().split('\n').slice(0, 3).join('\n'));
      return lines.join('\n');
    },
  });

  // ---------------------------------------------------- learn_skill_manage ---
  const skillManage = define({
    name: 'learn_skill_manage',
    description: [
      '这是唯一被允许的技能库写入口：读、建、改、删。',
      `写入前会做内容卫生：脱敏、{{ 转义、注入特征拒收、超长行折断。技能库根目录 ${config.skillsRoot}。`,
      'delete 只对本插件创建的技能生效（managed.json），删别人写的技能必须显式 adopt=true。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['create', 'update', 'read', 'delete', 'archive'], description: '默认 create' },
      name: { type: 'string', description: 'kebab-case 类级技能名，禁止 PR 号/日期/错误串/库名' },
      description: { type: 'string', description: '一句话说明它覆盖哪一类任务、什么时候该加载' },
      whenToUse: { type: 'string', description: '可选的触发条件（写给未来的自己看）' },
      summary: { type: 'string', description: '正文开头：这个技能解决什么' },
      conditions: { type: 'array', description: '适用条件', items: { type: 'string' } },
      steps: { type: 'array', description: '过程步骤，越具体越好（命令、路径、顺序）', items: { type: 'string' } },
      pitfalls: { type: 'array', description: '坑：规则 + 一句为什么', items: { type: 'string' } },
      verification: { type: 'array', description: '怎么算做对了', items: { type: 'string' } },
      notApplicable: { type: 'array', description: '不适用条件', items: { type: 'string' } },
      body: { type: 'string', description: '直接给 markdown 正文，替代 summary/steps/...' },
      overwrite: { type: 'boolean', description: 'create 时覆盖同名技能（默认拒绝）' },
      adopt: { type: 'boolean', description: '接管一个非本插件管理的同名技能（默认拒绝）' },
    },
    output: output((value) => (typeof value === 'string' ? text(value) : json(value))),
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = String(args.action || 'create').toLowerCase();
      const name = String(args.name || '').trim();

      if (action === 'read') {
        if (!name) return { ok: false, reason: '需要 name' };
        const record = skills.read(name);
        if (!record) return { ok: false, reason: `技能不存在：${name}`, file: skills.fileFor(name) };
        return {
          ok: true,
          name,
          file: record.file,
          legacy: record.legacy,
          description: record.meta.description || '',
          rules: skills.readRules(name).map((rule) => ({ id: rule.id, text: rule.text })),
          usage: managed.usageOf(name),
          body: record.body,
        };
      }

      if (action === 'delete' || action === 'archive') {
        // Authorization FIRST. The old code returned before this check, which
        // meant `delete`/`archive` could destroy any skill in the shared root.
        const verdict = managed.canDestroy(name, { adopt: args.adopt === true });
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        if (action === 'archive') {
          const result = skills.archive(name, {
            archiveDir: join(store.dirs.archive, 'skills'),
            managed: (key) => managed.isManaged(key),
            adopt: args.adopt === true,
          });
          if (!result.ok) return { ok: false, reason: result.reason };
          managed.release(name);
          store.appendLedger({ action: 'skill.archive', skill: name, to: result.to, adopted: result.adopted === true });
          return { ok: true, archived: name, to: result.to, recoverable: true };
        }
        const result = skills.remove(name, { managed: (key) => managed.isManaged(key), adopt: args.adopt === true });
        if (!result.ok) return { ok: false, reason: result.reason };
        managed.release(name);
        store.appendLedger({ action: 'skill.delete', skill: name, dir: result.dir, adopted: args.adopt === true });
        return { ok: true, deleted: name, note: '技能目录已删除，账本留痕' };
      }

      const existing = skills.read(name);
      if (existing && !existing.legacy && action === 'create' && args.overwrite !== true && managed.isManaged(name)) {
        return {
          ok: false,
          reason: `${name} 已存在且是本插件管理的技能。要改内容请用 action=update（或 create 加 overwrite=true）；要先看内容用 action=read。`,
          file: existing.file,
        };
      }
      if (existing && !managed.isManaged(name)) {
        if (args.adopt !== true) {
          return {
            ok: false,
            reason: `${name} 已存在，但不是本插件创建的（不在 managed.json）。直接覆盖会破坏用户自己写的技能；确认要接管请显式 adopt=true，它会记进 managed.json 与账本。`,
            file: existing.file,
          };
        }
      }
      if (existing && existing.legacy && args.adopt === true) {
        const moved = skills.adoptIntoRoot(name);
        if (moved.ok) store.appendLedger({ action: 'skill.organize', skill: name, from: moved.from, to: moved.to, reason: 'adopt' });
      }
      if (!NAME_RE.test(name)) {
        return { ok: false, reason: `技能名不合法：${JSON.stringify(name)}。要用 kebab-case 的类级名字（例如 dependency-install-recovery），不要用 PR 号、日期或错误串。` };
      }

      const body = args.body ? String(args.body) : buildBody(args);
      if (!body.trim()) return { ok: false, reason: '需要 body，或 summary/steps/pitfalls 里至少一项' };

      const description = String(args.description || '').trim();
      const screened = screenDescription(description);
      if (!description) return { ok: false, reason: '需要 description（它是未来唯一的路由信号）' };
      if (screened.clipped) {
        return {
          ok: false,
          reason: `description ${screened.length} 字，超过技能目录预算 ${DESCRIPTION_LIMIT} 字。宿主会把它截断成「…」，被截掉的往往正是触发词。请压缩到 ${DESCRIPTION_LIMIT} 字以内（把「什么时候该加载」写进 whenToUse）。`,
        };
      }

      const written = skills.write(name, {
        description,
        body,
        meta: {
          'learn-when': args.whenToUse ? String(args.whenToUse) : undefined,
          'learn-rule': args.rule ? String(args.rule) : undefined,
        },
      });
      if (!written.ok) {
        return { ok: false, reason: `写入被拒：${(written.refused || []).join('；')}`, issues: written.issues };
      }
      managed.claim(name, {
        kind: 'manual',
        source: action,
        rules: skills.readRules(name).length,
        file: written.file,
        adopted: existing && !managed.isManaged(name) ? name : undefined,
      });
      store.appendLedger({
        action: action === 'update' ? 'skill.update' : 'skill.create',
        skill: name,
        file: written.file,
        description: screened.text,
        adopted: Boolean(existing) && args.adopt === true,
      });
      return {
        ok: true,
        action: existing ? 'updated' : 'created',
        name,
        file: written.file,
        description: written.fit.text,
        descriptionChars: written.fit.length,
        descriptionLimit: written.fit.limit,
        issues: written.issues,
        rules: skills.readRules(name).length,
      };
    },
  });

  // --------------------------------------------------------- learn_skills ---
  const learnSkills = define({
    name: 'learn_skills',
    description: '在本插件管理的技能里按语义/词面检索（用于「这个任务我是不是已经学过」），并返回最相关的技能名与加载建议。\n它是检索入口，不是写入入口：找到后用 skill 工具按名加载，或 learn_skill_manage 增补。',
    parameters: {
      query: { type: 'string', required: true, description: '任务描述或关键词' },
      limit: { type: 'number', description: '返回条数，默认 5' },
    },
    output: output((value) => (typeof value === 'string' ? text(value) : json(value))),
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const query = String(args.query || '').trim();
      if (!query) return '需要 query';
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const hits = skills.search(query, limit);
      // Rules are searchable too: an umbrella may hold the answer even when the
      // description does not mention the query.
      const ruleHits = [];
      for (const rule of review.allRules()) {
        const score = tokenOverlap(query, rule.text);
        if (score > 0.34) ruleHits.push({ umbrella: rule.umbrella, id: rule.id, text: rule.text, score });
      }
      ruleHits.sort((a, b) => b.score - a.score);
      if (!hits.length && !ruleHits.length) {
        return `没有匹配的已学技能。可以用 learn_review dry-run 看本会话能不能蒸出新候选。`;
      }
      const lines = ['## 已学技能命中'];
      for (const hit of hits) {
        lines.push(`- ${hit.name}（相关度 ${Math.round(hit.score * 100) / 100}）${hit.description ? `\n  ${hit.description}` : ''}\n  文件 ${hit.file}`);
      }
      if (ruleHits.length) {
        lines.push('', '## 规则命中');
        for (const hit of ruleHits.slice(0, limit)) {
          lines.push(`- [${hit.umbrella} / ${hit.id}] ${hit.text}（相关度 ${Math.round(hit.score * 100) / 100}）`);
        }
      }
      lines.push('', '加载：用 skill 工具按名加载对应技能；要补充用 learn_skill_manage update。');
      return lines.join('\n');
    },
  });

  return {
    learn,
    learnReview,
    learnCurator,
    skillManage,
    learnSkills,
    // Kept for callers that predate the tool split.
    learnHistory: null,
    learnConsolidate: null,
    policies: { REVIEW_SIGNALS },
  };
}

/** Assemble a markdown body from the structured arguments. */
function buildBody(args) {
  const parts = [];
  const summary = String(args.summary || '').trim();
  if (summary) parts.push(summary);
  const section = (title, items) => {
    const list = (Array.isArray(items) ? items : []).map((item) => String(item).trim()).filter(Boolean);
    if (!list.length) return;
    parts.push('', `## ${title}`, ...list.map((item) => `- ${item}`));
  };
  section('适用条件', args.conditions);
  section('过程', args.steps);
  section('坑', args.pitfalls);
  section('验证', args.verification);
  section('不适用', args.notApplicable);
  if (!parts.length) return '';
  const head = String(args.title || '').trim();
  const title = head ? `# ${head}\n\n` : '';
  return `${title}${parts.join('\n').replace(/^\n+/, '')}`.trim();
}

/** Cheap lexical overlap used to search stored rules. */
function tokenOverlap(query, text) {
  const left = new Set((String(query).toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,4}/g) || []));
  const right = new Set((String(text).toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,4}/g) || []));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / left.size;
}

export { safeJson, buildBody, sessionIdFrom, resolveProfileDir, patchProfileForRoot, RULE_BUDGET, LEARNED_SUBDIR };
