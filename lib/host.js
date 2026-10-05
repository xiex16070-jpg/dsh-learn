/**
 * The host extension points this plugin actually uses — and why each one is the
 * weakest sufficient one.
 *
 * The capability ladder, weakest first (from the host's own plugin guide):
 *
 *   ctx.tools.restrict()  remove tools from view      — it cannot refuse, only hide
 *   ctx.tools.guard()     synchronous deny            — cannot be argued with
 *   waterfall listeners   (tools/pre-execute, …)      — can rewrite, async
 *   system-prompt assembly                            — replaces everything
 *
 * This module stays on the first two rungs it needs and does not climb. Every
 * registration is optional: `ctx.get(name)` returns undefined on a build without
 * the service, and a missing service degrades to "the plugin works, that one
 * safety net is absent" rather than "the plugin does not load".
 *
 * ORDERING NOTE. None of these hooks may run before the root probe has answered.
 * The guard compares against `skills.learnedDir` and `skills.flatRoot`; before
 * the probe, the plugin does not yet know whether the dedicated root is visible,
 * so a guard built then would deny the wrong path. `createHostHooks` is
 * therefore called from the `.finally()` of the probe, alongside the always-on
 * skill write — the same reason, in the same place.
 */

import { DEFAULT_SKILL_NAME } from './skillfile.js';

/**
 * Lexical path normalisation: resolve `.` and `..`, unify separators, keep the
 * drive letter. No filesystem calls and no dependency on the process cwd, so the
 * same answer comes out wherever it is called from.
 *
 * This matters for a GUARD specifically. A guard that compares raw strings is
 * defeated by `…/learned/x/../../learned/x/SKILL.md` — textually inside, and
 * also textually evadable by climbing out and back in. Normalising first makes
 * the check strictly harder to slip past, and it does so without inventing an
 * answer for a relative path: `..` at the front of a relative path is kept
 * rather than silently resolved against a directory the caller never named.
 */
export function normalizePath(input) {
  const text = String(input == null ? '' : input).replace(/\\/g, '/');
  if (!text) return '';
  const drive = /^[a-zA-Z]:/.exec(text);
  const absolute = Boolean(drive) || text.startsWith('/');
  const rest = drive ? text.slice(2) : text;
  const out = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const body = out.join('/');
  if (drive) return `${drive[0]}:/${body}`;
  return absolute ? `/${body}` : body;
}

/**
 * Is `target` inside `root`? Normalised first, then compared segment-wise, so a
 * sibling that merely shares a prefix (`…/skills/learned-old` vs
 * `…/skills/learned`) is not mistaken for a child.
 */
export function isInside(target, root) {
  const t = normalizePath(target);
  const r = normalizePath(root).replace(/\/+$/, '');
  if (!t || !r) return false;
  const lower = (text) => (/^[a-zA-Z]:/.test(text) ? text.toLowerCase() : text);
  const [a, b] = [lower(t), lower(r)];
  return a === b || a.startsWith(`${b}/`);
}

/**
 * The disciplines that belong in front of the model, as opposed to inside the
 * skill file.
 *
 * This text is BYTE-STABLE on purpose. It is registered once at activation and
 * never rewritten, so it costs one prompt prefix and keeps the prompt cache
 * intact; a section whose text changed per turn would invalidate the prefix on
 * every step. Anything that must vary (the size of the queue) is a separate
 * section with a function for `text`, and that one is empty when there is
 * nothing to say.
 *
 * THE STANCE IS HERMES'S, AND SO IS THE UNIT. Its reviewer prompt
 * (`agent/background_review.py`, `_SKILL_REVIEW_PROMPT`) opens with "Be ACTIVE —
 * most sessions produce at least one skill update, even if small. A pass that
 * does nothing is a missed learning opportunity, not a neutral outcome" and
 * closes with "'Nothing to save.' is a real option but should NOT be the
 * default." Its do-not-capture list ("environment-dependent failures",
 * "negative claims about tools", "one-off task narratives") comes AFTER the
 * expectation, not instead of it.
 *
 * The text this replaced did the opposite. It opened 「把『下一次还会用到』的
 * 东西写下来。值得写的：」 and spent two of its five paragraphs on what is NOT
 * worth writing, ending 「拒了就是拒了」. A measured read of the ledger on
 * 2026-10-04 says what a permission read as a prohibition produces: 861 review
 * passes, 18 proposals ever filed, and 5 rules from the automatic path against
 * 43 from the model's own `learn action=note`.
 *
 * THE WORD FOR THE UNIT IS 「任务」, NOT 「回合」, and that distinction is the
 * correction in v0.3.9. Hermes's second review caught it: when the sentence was
 * moved into this section the unit silently became the TURN, and this plugin's
 * judge is a regex over one sentence where Hermes's is a model reading a whole
 * conversation. The same word 「主动」 means "find one thing in this conversation"
 * there and "write something every turn" here — which is how `tool-recovery`
 * reached 35 rules and `environment-facts` 23, most of them statements rather
 * than techniques. Task-level: be active. Turn-level: silence is the default.
 */
export const DISCIPLINE_SECTION = `[learn] 学习回路

一个任务结束时问自己一句：这次任务里有没有「下一次还会用到」的东西？多数任务里至少有一件，哪怕很小——一条排障路径、一个参数、一处偏好、一个刚被验证的做法。但单位是任务，不是回合：多数回合什么都不必写，那是正常的，不要为了让每一轮都有产出而制造规则。「没什么可记的」是真实的答案，只是别让它成为默认。

值得写的（learn action=note 的 kind）：
· 用户纠正了你的做法 / 风格 / 格式 / 详略，或明确要求你记住（记住 / 以后都 / 别再）→ kind=user-correction、remember-request，当场写，不要只口头答应。
· 失败后真正修好的做法 → kind=recovered-failure；顺手有效、下次还能用的做法或命令 → kind=technique。
· 本机 / 本仓库的固定事实（路径、版本、命令、开关）→ kind=durable-fact，且必须给出具体对象。
· 用户对输出形态的长期偏好 → kind=user-preference；某个已加载的技能本身是错的 → kind=skill-wrong，能改就直接用 learn_skill_manage 改掉。
· 关于 agent 回路、提示词、判定门槛本身的经验（怎么排拒绝清单、怎么让审查真的学东西）→ kind=technique，指定 umbrella=agent-engineering。这类自指内容不要塞进上面三把任务伞。

写之前问一句「动作测试」：未来某次会话只看这一条，会不会换一条命令、换一个顺序、或者停手不做某事？说不出被改变的那个动作，就是陈述而不是做法，不写。

不值得写的：这一轮才有的任务指令、过程叙述（「我先…然后…」）、工具输出原文、没有具体对象的说法。环境相关的偶发失败要记成「怎么装 / 怎么配」（安装命令、配置项、要设的环境变量），不要记成「这个工具不行」。

写法：命令名、参数、路径、文件名都用反引号括起来（\`--dry-run\`、\`lib/text.js\`）——门槛靠反引号里的东西认出「具体对象」，同一句话不加反引号会被拒。一条别超过 200 字，超了同样进不去，而且反引号加得再多也没用：长句里的路径会被当成顺带提到。有一条以上的事实就分开几条写。一把伞的规则条数只是提示线，不拦人；拦人的是正文的字符上限，到了就写不进去——那时先 \`learn action=consolidate dryRun=true\` 看一眼有没有真能合并的，没有就退掉最旧的一条（\`learn action=undo\`），或者承认一把伞装不下这一类、另建一个更专门的技能。别把「先合并」当成一句口号念，它有时候是堵死的。

技能是唯一被校验的写入口，用 learn_skill_manage；直接 write / edit 技能库里的文件会被拦下。`;

/**
 * Build the queue nudge. Returns `''` for an empty queue so the section adds
 * nothing to the prompt; when the queue is non-empty the text depends only on
 * the candidate ids, which change only when the queue changes.
 *
 * Deliberately a prompt section rather than `agent.inject()`. `inject` puts a
 * message in the agent's inbox without waking it, so it cannot make the model
 * act on the turn it fires in; it can, however, fire again the moment the queue
 * is read, which is a loop waiting to happen. A section says the same thing at
 * the same position in every prompt, costs one stable prefix, and cannot loop.
 */
export function queueNudge(pending) {
  const items = Array.isArray(pending) ? pending : [];
  if (!items.length) return '';
  const head = items
    .slice(0, 5)
    .map((item) => `· ${item.umbrella || '?'} · ${String(item.statement || '').slice(0, 80)}  fp=${item.fp || '(缺)'}`)
    .join('\n');
  const more = items.length > 5 ? `\n（还有 ${items.length - 5} 条，用 learn action=pending 看全）` : '';
  return `[learn] 有 ${items.length} 条候选还没有着落——它们不会自己变成技能，也不会自己消失：

${head}${more}

要么写下它：learn action=restore-pending fp=<上面的 fp>；要么丢掉它：learn action=drop-pending fp=<fp>。别把它留过这个回合。`;
}

/**
 * How many characters of learned rules are worth putting in every prompt.
 *
 * Hermes's P1-1, measured: across 20 recent sessions (~30k events) there were 138
 * `learn*` calls, 2 `skill` loads and **0** `learn_skills` calls, and `usage.json`
 * — the file `loads` is counted in — had never been created. Rules were being
 * written and almost never read, so "写下来，下次就做对" had not happened once in
 * the data. A library nothing retrieves from is a diary.
 *
 * The host already has the mechanism it needs: `dsh-memory` keeps a small excerpt
 * in a `systemPrompt.section` that changes ONLY when the memory changes, so the
 * assembled prefix stays byte-identical across turns and the prompt cache holds.
 * This is that, sized so one umbrella's worth of preferences and a few of the
 * newest techniques fit without crowding the discipline section.
 */
export const RULE_EXCERPT_MAX_CHARS = 1200;

/**
 * Render the bounded excerpt of what has actually been learned.
 *
 * The point is not completeness — that is what `learn action=list` and
 * `learn_skills` are for — it is that the model SEES that it has a memory, in
 * every turn, without asking. The footer says where the rest is.
 *
 * Determinism is the whole performance contract: the same rule files must render
 * the same bytes, because that is what keeps the assembled prompt prefix stable
 * and the cache cheap. There is deliberately NO memo here — an excerpt cache adds
 * a stale-excerpt bug class, and rendering five small files per assembly costs
 * less than the bug would.
 *
 * `durable-preferences` is shown in full (it is the user's own stated
 * preferences, and it is meant to be short); the task umbrellas show their newest
 * few, because the newest lesson is the one this session just taught.
 */
export function ruleExcerpt(skills, { maxChars = RULE_EXCERPT_MAX_CHARS, newestPerSkill = 3 } = {}) {
  if (!skills || typeof skills.list !== 'function' || typeof skills.readRules !== 'function') return '';
  let entries;
  try {
    entries = skills.list();
  } catch {
    return '';
  }
  if (!Array.isArray(entries)) return '';
  const named = entries
    .map((entry) => String((entry && entry.name) || ''))
    .filter((name) => name && name !== DEFAULT_SKILL_NAME)
    .sort((a, b) => (a === 'durable-preferences' ? -1 : b === 'durable-preferences' ? 1 : a.localeCompare(b)));
  const blocks = [];
  let used = 0;
  for (const name of named) {
    let rules;
    try {
      rules = skills.readRules(name);
    } catch {
      continue;
    }
    if (!Array.isArray(rules) || !rules.length) continue;
    const full = name === 'durable-preferences';
    const shown = full ? rules : rules.slice(-newestPerSkill);
    const header = full ? `${name}（${rules.length} 条）` : `${name}（共 ${rules.length} 条，只列最近 ${shown.length} 条）`;
    const lines = [header];
    for (const rule of shown) {
      const text = String((rule && rule.text) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push(`· ${text}`);
    }
    const block = lines.join('\n');
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  if (!blocks.length) return '';
  return `[learn] 你已经学过的东西——写下来就是为了下一次先用上：

${blocks.join('\n\n')}

完整清单：learn action=list；按任务找：learn_skills（它连规则正文一起搜）。`;
}

/**
 * The guard body, exported so it can be tested without a host.
 *
 * Returns a REASON STRING to deny, `undefined` to allow — the shape
 * `tools.guard()` expects. A guard is monotonic: nothing can force-allow a call
 * this one denied, so the refusal text is the only channel left, and it has to
 * carry the replacement command.
 *
 * SCOPE. The dedicated root is wholly this plugin's, so everything under it is
 * refused. The SHARED root is not: it holds skills other people and other plugins
 * wrote (`zz-user-probe` lives there on this machine), and a guard that refused
 * every path under `<dshHome>/skills` would be a plugin forbidding edits to files
 * it does not own. So the shared root is guarded per SKILL: only a name this
 * plugin created — or one of the four built-ins — is off limits there.
 */
export function guardSkillWrites(execution, { skills, managed } = {}) {
  const name = String(execution?.name || '');
  if (name !== 'write' && name !== 'edit') return undefined;
  const args = execution?.arguments;
  const target = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : '';
  if (!target) return undefined;

  const learnedDir = skills?.learnedDir;
  const flatRoot = skills?.legacyRoot;
  let hit = learnedDir && isInside(target, learnedDir) ? learnedDir : null;
  if (!hit && flatRoot && isInside(target, flatRoot)) {
    // First segment under the shared root is the skill name.
    const rest = normalizePath(target).slice(normalizePath(flatRoot).replace(/\/+$/, '').length + 1);
    const skillName = rest.split('/')[0];
    const ours =
      skillName &&
      (managed?.isManaged?.(skillName) === true || managed?.BUILTIN_PROTECTED?.includes?.(skillName) === true);
    if (ours) hit = flatRoot;
  }
  if (!hit) return undefined;

  return `技能库里的文件不走 ${name}：${target} 直接改会绕过脱敏、超长行折断、规则缩水保护和账本——写了等于没写，下次整理还会把它当没主的文件。改用 learn_skill_manage（create / update / read / delete / archive），或者用 learn action=note 记一条新规则。`;
}

/**
 * Register the hooks. Every one is optional and independently disposable.
 *
 * Returns `{ applied, disposers, reason }` — `applied` is the list of hook names
 * that actually registered, so the doctor can tell the truth about what is
 * wired instead of asserting it.
 */
export function createHostHooks({ ctx, skills, store, pendingOf } = {}) {
  const applied = [];
  const disposers = [];
  const fail = (what, error) => store?.warn?.(`host hook ${what} failed`, error);

  const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : null;
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      disposers.push(
        systemPrompt.section({ name: 'learn-discipline', order: 90, text: DISCIPLINE_SECTION, interpolate: false }),
      );
      applied.push('systemPrompt.section');
    } catch (error) {
      fail('systemPrompt.section', error);
    }
    try {
      // A second section rather than a template inside the first: this one is
      // allowed to be empty, and an empty section contributes no tokens.
      const text = () => {
        try {
          return queueNudge(typeof pendingOf === 'function' ? pendingOf() : []);
        } catch (error) {
          fail('queue nudge', error);
          return '';
        }
      };
      disposers.push(systemPrompt.section({ name: 'learn-queue', order: 91, text, interpolate: false }));
      applied.push('systemPrompt.section(queue)');
    } catch (error) {
      fail('systemPrompt.section(queue)', error);
    }
    try {
      // The third section is the one that makes the loop a loop. Without it the
      // model writes rules into a place it never reads: 20 sessions, 138 `learn*`
      // calls, 0 `learn_skills` calls, no `usage.json` at all. Empty when nothing
      // has been learned yet, so a fresh install pays nothing for it.
      const text = () => {
        try {
          return ruleExcerpt(skills);
        } catch (error) {
          fail('rule excerpt', error);
          return '';
        }
      };
      disposers.push(systemPrompt.section({ name: 'learn-rules', order: 92, text, interpolate: false }));
      applied.push('systemPrompt.section(rules)');
    } catch (error) {
      fail('systemPrompt.section(rules)', error);
    }
  }

  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : null;
  if (tools && typeof tools.guard === 'function') {
    try {
      disposers.push(tools.guard((execution) => guardSkillWrites(execution, { skills })));
      applied.push('tools.guard');
    } catch (error) {
      fail('tools.guard', error);
    }
  }

  return {
    applied,
    reason: applied.length ? `已挂上 ${applied.join('、')}` : '宿主没有提供这些扩展点（插件照常工作，只是少了这几道网）',
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.();
        } catch (error) {
          fail('dispose', error);
        }
      }
    },
  };
}
