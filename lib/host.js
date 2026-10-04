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
 * THE STANCE IS HERMES'S. Its reviewer prompt (`agent/background_review.py`,
 * `_SKILL_REVIEW_PROMPT`) opens with "Be ACTIVE — most sessions produce at
 * least one skill update, even if small. A pass that does nothing is a missed
 * learning opportunity, not a neutral outcome" and closes with "'Nothing to
 * save.' is a real option but should NOT be the default." Its do-not-capture
 * list ("environment-dependent failures", "negative claims about tools",
 * "one-off task narratives") comes AFTER the expectation, not instead of it.
 *
 * The text this replaced did the opposite. It opened 「把『下一次还会用到』的
 * 东西写下来。值得写的：」 and spent two of its five paragraphs on what is NOT
 * worth writing, ending 「拒了就是拒了」. A measured read of the ledger on
 * 2026-10-04 says what a permission read as a prohibition produces: 861 review
 * passes, 18 proposals ever filed, and 5 rules from the automatic path against
 * 43 from the model's own `learn action=note`. The refusal list is still here —
 * Hermes keeps one too — but it comes after the expectation, and the
 * expectation carries a number: most turns, not some.
 */
export const DISCIPLINE_SECTION = `[learn] 学习回路

一个回合结束时问自己一句：这一轮里有没有「下一次还会用到」的东西？多数回合是有的，哪怕很小——一条排障路径、一个参数、一处偏好、一个刚被验证的做法。什么都不写是一次学习机会的浪费，不是中性结果；「没什么可记的」也是一个真实的答案，但它是例外，不是默认。

值得写的（learn action=note 的 kind）：
· 用户纠正了你的做法 / 风格 / 格式 / 详略，或明确要求你记住（记住 / 以后都 / 别再）→ kind=user-correction、remember-request，当场写，不要只口头答应。
· 失败后真正修好的做法 → kind=recovered-failure；顺手有效、下次还能用的做法或命令 → kind=technique。
· 本机 / 本仓库的固定事实（路径、版本、命令、开关）→ kind=durable-fact，且必须给出具体对象。
· 用户对输出形态的长期偏好 → kind=user-preference；某个已加载的技能本身是错的 → kind=skill-wrong，能改就直接用 learn_skill_manage 改掉。

不值得写的：这一轮才有的任务指令、过程叙述（「我先…然后…」）、工具输出原文、对本插件或某个正则自身的讨论、没有具体对象的说法。环境相关的偶发失败要记成「怎么装 / 怎么配」（安装命令、配置项、要设的环境变量），不要记成「这个工具不行」。

写法：命令名、参数、路径、文件名都用反引号括起来（\`--dry-run\`、\`lib/text.js\`）——门槛靠反引号里的东西认出「具体对象」，同一句话不加反引号会被拒。一条别超过 200 字，超了同样进不去，而且反引号加得再多也没用：长句里的路径会被当成顺带提到。有一条以上的事实就分开几条写。

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
