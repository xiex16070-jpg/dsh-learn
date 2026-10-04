/**
 * Signal classification: deciding what is worth remembering, and — more
 * importantly — what is not.
 *
 * Read this before touching a pattern bank. The first version of this file
 * contained a bare `\bremember\b|\balways\b|\bnever\b` in the "user stated a
 * durable preference" bank. The result was that the plugin's very first stored
 * preference was its own English debug monologue ("I'm checking how the always
 * pattern matches against assistant-plan text..."), captured while it was
 * debugging this very file. Three design rules came out of that:
 *
 *   1. Never match a bare adverb. `always`/`never` occur constantly in prose
 *      *about* behaviour. A durable claim must have an imperative or habitual
 *      frame ("以后都…", "from now on…"), or it is not a claim at all.
 *   2. Classify by SOURCE. Assistant text is reasoning about the work; it can
 *      evidence a technique or a skill error, never a user preference.
 *   3. A wrong "actionable" verdict is the expensive one. The old code made
 *      `directive ⇒ actionable` unconditionally true, which quietly turned
 *      every length-passing statement into a rule. Actionability is now judged
 *      on shape: short, with a concrete handle, or written as an imperative.
 *
 * The deterministic layer's job is RECALL and SCORING, never authoring. It
 * proposes; the model disposes. Anything else puts a regex in the judgement
 * seat, which is exactly the failure this file used to be.
 */

export const SIGNAL = {
  REMEMBER_REQUEST: 'REMEMBER_REQUEST',
  USER_CORRECTION: 'USER_CORRECTION',
  USER_PREFERENCE: 'USER_PREFERENCE',
  SKILL_WRONG: 'SKILL_WRONG',
  RECOVERED_FAILURE: 'RECOVERED_FAILURE',
  DURABLE_FACT: 'DURABLE_FACT',
  TECHNIQUE: 'TECHNIQUE',
  TOOL_FAILURE_OPEN: 'TOOL_FAILURE_OPEN',
};

export const SIGNAL_WEIGHT = {
  [SIGNAL.REMEMBER_REQUEST]: 6,
  [SIGNAL.USER_CORRECTION]: 5,
  [SIGNAL.USER_PREFERENCE]: 4,
  [SIGNAL.SKILL_WRONG]: 4,
  [SIGNAL.RECOVERED_FAILURE]: 4,
  [SIGNAL.DURABLE_FACT]: 3,
  [SIGNAL.TECHNIQUE]: 2,
  [SIGNAL.TOOL_FAILURE_OPEN]: 1,
};

/**
 * Which signals a given source may raise. Assistant turns are the agent's own
 * reasoning; letting them claim USER_PREFERENCE or REMEMBER_REQUEST is how the
 * contamination happened, so the whitelist is narrow and explicit.
 */
export const SOURCE_KINDS = {
  user: ['REMEMBER_REQUEST', 'USER_CORRECTION', 'USER_PREFERENCE', 'DURABLE_FACT'],
  assistant: ['TECHNIQUE', 'SKILL_WRONG', 'RECOVERED_FAILURE'],
  tool: ['RECOVERED_FAILURE', 'TECHNIQUE', 'TOOL_FAILURE_OPEN'],
};

export const KIND_LABEL = {
  [SIGNAL.REMEMBER_REQUEST]: '用户要求记住',
  [SIGNAL.USER_CORRECTION]: '用户纠正',
  [SIGNAL.USER_PREFERENCE]: '用户偏好',
  [SIGNAL.SKILL_WRONG]: '技能有错',
  [SIGNAL.RECOVERED_FAILURE]: '失败后修复',
  [SIGNAL.DURABLE_FACT]: '环境事实',
  [SIGNAL.TECHNIQUE]: '有效做法',
  [SIGNAL.TOOL_FAILURE_OPEN]: '未解决的失败',
};

export const SENSITIVE_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已脱敏]'],
  [/\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[令牌已脱敏]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT 已脱敏]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[邮箱已脱敏]'],
  [/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]'],
  [/\b\d{17}[\dXx]\b/g, '[身份证号已脱敏]'],
  [/\b(?:password|passwd|pwd|secret|token|apikey|api_key|access_key)\s*[=:]\s*\S+/gi, '$1=[已脱敏]'],
  [/(?:密码|口令|密钥|令牌|凭据|私钥)\s*[=:：]\s*\S+/g, '$1[已脱敏]'],
];

export function desensitize(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Whether there is nothing left but redaction placeholders.
 *
 * This used to be a bare length test (`stripped.length < 6`), which flagged any
 * short body as "fully redacted" — a three-character Chinese skill body tripped
 * it, and a two-character CJK statement is a legitimate rule here. A body can
 * only be *mostly redacted* if it actually contains a placeholder, so require
 * one, and measure length in code points rather than UTF-16 units.
 */
export function isMostlyRedacted(text) {
  const source = String(text ?? '');
  if (!/\[[^\]]*已脱敏\]/.test(source)) return false;
  const stripped = source.replace(/\[[^\]]*已脱敏\]/g, '').replace(/[\s\p{P}]/gu, '');
  return [...stripped].length < 6;
}

/** One compact, comparable line: what gets stored and fingerprinted. */
export function condense(text, { maxChars = 240 } = {}) {
  const oneLine = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Order-insensitive shingle fingerprint, for cheap dedup. */
export function fingerprint(text, { size = 40 } = {}) {
  const tokens = tokenize(text).slice(0, size);
  if (!tokens.length) return '';
  const sorted = [...tokens].sort();
  let hash = 0x811c9dc5;
  for (const token of sorted) {
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const words = source.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,4}/g) || [];
  return words.filter((word) => word.length > 1 || /[\u4e00-\u9fff]/.test(word));
}

export function extractText(value, { depth = 0, maxChars = 4000 } = {}) {
  if (value === null || value === undefined || depth > 4) return '';
  if (typeof value === 'string') return value.slice(0, maxChars);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, { depth: depth + 1, maxChars })).filter(Boolean).join('\n').slice(0, maxChars);
  }
  if (typeof value === 'object') {
    const preferred = ['text', 'content', 'message', 'output', 'result', 'stdout', 'stderr', 'error', 'command', 'path', 'name', 'id'];
    const parts = [];
    for (const key of preferred) {
      if (key in value) {
        const part = extractText(value[key], { depth: depth + 1, maxChars });
        if (part) parts.push(part);
      }
    }
    if (!parts.length) {
      for (const item of Object.values(value)) {
        const part = extractText(item, { depth: depth + 1, maxChars });
        if (part) parts.push(part);
        if (parts.join('\n').length > maxChars) break;
      }
    }
    return parts.join('\n').slice(0, maxChars);
  }
  return '';
}

// ------------------------------------------------------------------ patterns

/**
 * An explicit request to remember. Requires an imperative or a habitual marker
 * — never a bare adverb. Each alternative is anchored on something only a
 * request can contain.
 */
export const REMEMBER_RE = new RegExp([
  '(?:记住|记下|记一下|别忘了|以后都|下次要|以后要|以后请|之后都|都要这样|按这个来|照这个做)',
  '\\b(?:remember|memorize|note)\\s+(?:this|that|it|to|that\\s+i)\\b',
  '\\bkeep\\s+in\\s+mind\\b',
  '\\bfrom\\s+now\\s+on\\b',
  '\\bgoing\\s+forward\\b',
  '\\bfor\\s+future\\s+reference\\b',
  '\\bin\\s+the\\s+future\\s*,?\\s+(?:please|always|do|use|prefer)',
  '^(?:always|never)\\s+[a-z]',
].join('|'), 'im');

/** A habit stated as a fact about the user, not a one-off request. */
export const PREFERENCE_RE = new RegExp([
  '(?:我(?:更)?(?:喜欢|偏好|习惯|倾向)|我一般|我通常|对我来说|我的习惯是|默认用|一律用|我想让你|我希望你|我要你|我的要求是|我的规范是|统一用|统一都|约定是|规范是|我们约定)',
  '\\bi\\s+(?:prefer|usually|normally|generally|always\\s+use|tend\\s+to)\\b',
  '\\bi\\s+(?:want|need|expect)\\s+you\\s+to\\b',
  '\\bmy\\s+(?:preference|habit|convention|style)\\s+is\\b',
].join('|'), 'i');

/**
 * A standing correction. The verb is what matters, not the adverb: 「别用 X」 and
 * 「别再拿 X 了」 are the same rule, and only the first one used to be visible.
 * Measured 2026-10-04: 「别再拿 robocopy 做镜像了，上次它把 `docs/shots` 目录清空了。」
 * — a correction with a mechanism and a handle — classified as NOTHING, so it
 * never reached the window at all. 「不要提交」 missed for the same reason
 * (the bank had 「不要用」, not 「不要」 + verb).
 */
export const CORRECTION_RE = new RegExp([
  '(?:不对|不是这样|错了|搞错|你又|我说过|我说的是|别用|不要用|别再|不要再|不用再|以后别|下次别|不要这么|不要这样|别这么|别这样|这样不行|这不行|不应该|不该|重来|纠正|更正|更正一下)',
  '\\b(?:that\'?s|this\\s+is)\\s+(?:wrong|incorrect|not\\s+what)\\b',
  '\\bno\\s*,?\\s+(?:i\\s+(?:said|meant)|use|do\\s+not|don\'?t)\\b',
  '\\byou\\s+(?:should|shouldn\'?t|must|mustn\'?t)\\b',
  '\\bi\\s+(?:already\\s+)?(?:told|said|asked)\\s+you\\b',
].join('|'), 'i');

export const SKILL_WRONG_RE = new RegExp([
  '(?:技能|skill|SKILL\\.md).{0,20}(?:过时|不对|失效|有误|写错|错)',
  '(?:过时|失效|有误|不准确|不对)的?(?:技能|文档|说明|步骤)',
  '\\bskill\\b[^.\n]{0,30}\\b(?:is\\s+wrong|outdated|stale|incorrect|no\\s+longer)\\b',
  '\\b(?:wrong|outdated|stale)\\b[^.\n]{0,20}\\bskill\\b',
].join('|'), 'i');

/**
 * A durable property of this machine, repo or workspace.
 *
 * The first alternative used to require one of 环境|机器|系统|仓库|项目 and one of
 * six copulas. 「本机 Python 在 `C:\…\python.exe`。」 named neither 机器 nor 是, and
 * 「这个工作区里截图放在 `docs\shots\` 下」 named no word in the list at all — both
 * are exactly the durable facts the umbrella exists to hold, and both were
 * invisible. The subject list now includes the words people actually use
 * (本机 / 工作区 / 本项目), the verb list includes 放在 / 装在 / 在, and the whole
 * alternative demands a concrete object immediately after the verb — without
 * that tail, 「这个项目有问题，在 `lib/text.js` 里」 would read as a fact.
 */
export const DURABLE_FACT_RE = new RegExp([
  '(?:本机|这台机器|本仓库|这个仓库|本项目|这个项目|工作区|环境|机器|系统|仓库|项目)[^。\\n]{0,16}'
    + '(?:是|用的是|固定在|位于|路径是|放在|装在|在)\\s*(?:`|[A-Za-z]:\\\\|/[\\w.]|[A-Za-z0-9_]+\\\\)',
  '(?:必须|只能|不能用|不支持|依赖)\\s*[A-Za-z0-9_.\\-/]{2,}',
  // The identification shape — 「`dsh` 是 deepseek harness」. Found by sampling the
  // 149 real user messages the classifier still could not see: this was one of
  // the only genuine misses in the sample, and it is the purest kind of durable
  // fact there is (what a named thing in this workspace actually is). Requires a
  // backticked handle on the left, so a task instruction cannot reach it.
  '`[^`\\n]{2,}`\\s*(?:是|指的是|叫做|表示|代表)',
  '\\b(?:requires?|only\\s+supports?|does\\s+not\\s+support|must\\s+(?:be|use|run))\\b',
  '\\b(?:node|python|pnpm|npm|rust|go)\\s*(?:version|版本)?\\s*[<>=]{1,2}\\s*\\d',
].join('|'), 'i');

export const TECHNIQUE_RE = new RegExp([
  '(?:做法是|做法|办法是|办法|改成|换成|改用|先.{1,30}再|可以这样|这样就能|修好了|解决了|workaround)',
  '\\b(?:the\\s+fix\\s+is|fixed\\s+by|solved\\s+by|instead\\s+use|turned\\s+out|the\\s+workaround)\\b',
].join('|'), 'i');

export const FAILURE_RE = new RegExp([
  '(?:失败|报错|错误|不行|无法|拒绝|超时|崩溃)',
  '\\b(?:failed|error|exception|refused|timed?\\s*out|crash|denied|EPERM|ENOENT|EBADENGINE|exit\\s+code\\s+[1-9])\\b',
].join('|'), 'i');

export const SUCCESS_RE = new RegExp([
  '(?:成功|通过|搞定|好了|可以了|正常了)',
  '\\b(?:succeeded|passed|works|working|fixed|green|all\\s+good)\\b',
].join('|'), 'i');

/**
 * A transient environment condition — a missing binary, an unconfigured
 * credential, a fresh-install error. Real, but not a durable lesson: the user
 * fixes it and the rule becomes a lie. Ported from the "do not capture" policy.
 */
export const ENV_STATE_RE = new RegExp([
  '(?:未安装|没安装|没有安装|缺少|找不到|命令不存在|未配置|没有配置|未设置|凭据|未登录|没权限|不存在|没有权限|无权限|访问不了|拿不到|不可访问)',
  '\\b(?:command\\s+not\\s+found|not\\s+installed|no\\s+such\\s+file|permission\\s+denied|ENOENT|EPERM|EACCES|MODULE_NOT_FOUND|not\\s+configured|missing\\s+credential|not\\s+logged\\s+in)\\b',
  // 「It may not exist or you may not have access to it」 — the shape a model
  // selection error arrives in, and the reason it used to become a durable fact
  // about `environment-facts`. Hermes files this class under 「环境相关的偶发
  // 失败」: capture how to install or configure, never that a thing is absent.
  '\\b(?:may\\s+not\\s+exist|does\\s+not\\s+exist|doesn\'?t\\s+exist|no\\s+access\\s+to|not\\s+available|unavailable|isn\'?t\\s+configured)\\b',
].join('|'), 'i');

/** A flat denial ("X is broken", "the browser tool doesn't work"). */
export const NEGATIVE_CLAIM_RE = new RegExp([
  '(?:用不了|不能用|没法用|坏了|没反应|不可用|不支持|搞不定)',
  '\\b(?:doesn\'?t\\s+work|is\\s+broken|is\\s+useless|cannot\\s+be\\s+used|unusable|not\\s+available|no\\s+longer\\s+works)\\b',
].join('|'), 'i');

/**
 * One-off, this-turn-only requests: correct to obey, wrong to remember.
 *
 * 临时 used to stand alone here, and it fired on 「把 `%TEMP%` 下的**临时**探针删掉」 —
 * a durable rule about temp files, refused as 「看起来是一次性要求」. The marker is
 * only a one-off when it modifies the ACTION (临时改/临时用), not when it modifies
 * a noun, so the alternative now names the verbs it needs.
 */
export const ONE_OFF_RE = new RegExp([
  '(?:这一次|这次|仅此一次|就这一个|临时(?:改|用|设|调整|这样|这么|先)|先这样|暂时)',
  '\\b(?:just\\s+this\\s+once|for\\s+now|this\\s+time\\s+only|temporarily)\\b',
].join('|'), 'i');

/**
 * Someone telling THIS RUN what to do — a second-person imperative.
 *
 * Distinct from a preference and distinct from an environment fact, and until
 * now nothing could tell them apart. The live queue held
 * `"You are writing ONE new file and nothing else. Do not edit any other file in
 * the repo; do not touch …"` filed as `DURABLE_FACT` in `environment-facts`, and
 * it passed every gate. That is the worst possible survivor: promoted once, it
 * becomes a standing self-constraint in `environment-facts` that every future
 * session reads as a property of the world — "you may only ever write one file".
 *
 * `ONE_OFF_RE` does not catch it ("nothing else" is not in the list, and the
 * sentence never says 这一次), and `AGENT_DELIBERATION_RE` cannot either: it is
 * scoped away from user-side sources on purpose, because a user saying "I need
 * to…" is stating a requirement rather than thinking out loud. The missing
 * predicate was never a narration check. It is address — this text is not about
 * the world, it is addressed AT the agent.
 */
export const TASK_DIRECTIVE_RE = new RegExp([
  "\\byou\\s+are\\s+(?:writing|editing|creating|adding|going\\s+to|to\\s+\\w+)\\b",
  "\\byou\\s+(?:must|should|may|will|need\\s+to)\\s+(?:only\\s+)?(?:write|edit|create|add|touch|modify|use)\\b",
  "\\b(?:do\\s+not|don'?t|never)\\s+(?:edit|touch|modify|change|write|create|delete|rename|move)\\b",
  "\\bonly\\s+(?:edit|touch|modify|change|write|create|add|use)\\b",
  '^(?:write|edit|create|add|implement|refactor|fix|update|rename|delete|remove)\\s+\\w+',
  '(?:别动|不要动|不许动|不要碰|别碰|不要改|别改|不要动其他|只写|只改|只能改|只创建|只新建|只需要改|限你|你必须)',
  // --- widened after the audit: 9 of 16 realistic one-turn instructions reached
  // `environment-facts` through the alternatives above. The three that got in are
  // the shapes below, all Chinese, all addressed at the agent, none of them a fact
  // about the world: `把…修好，然后重跑…确认没有回归`, `把…改成…，改完告诉我`,
  // `不要修改 _agent-learning\ 下的任何文件，只在 %TEMP% 的副本里做实验`.
  '(?:不要|别|不许|禁止|不用)(?:再)?(?:去)?(?:修改|更改|改动|变动|更动|新增|添加|删除|删掉|触碰|覆盖|重命名|移动)',
  '(?:把|将)[^。；\\n]{0,30}?(?:改|换|删|加|写|修|调|移|重命名|新建|创建|替换|实现|补上|补全|补齐|完善|完成|对齐|同步|更新|去掉|安装|配置|重跑)',
  // 「读取 X，结合…尝试完成…工作」 and 「参考 <url> 的说明，把 manifest 补全」 —
  // both leaked through the user-side fallback on the real corpus, and both are
  // a request to DO something with a source, not a statement about the world.
  '(?:读取|参考|根据|结合|依据|按照|对照)[^。；\\n]{0,40}?(?:完成|实现|检查|核对|生成|整理|分析|写|改|做|补|更新|对齐|修)',
  '(?:改|写|做|跑|试|查|确认|验证|检查|修复|实现|补|加|删|换|重跑|重写|重做|测试)(?:完|好|之后|以后|了)?\\s*(?:告诉|通知|汇报|说一声|回)我',
  '(?:只在|仅限于|仅限|限制在)[^。；\\n]{0,20}(?:里|中|内|下)',
  // The 「在 X 里加上 Y」 shape. Found by the user-side fallback: 「在 `lib/client.js`
  // 里加上 `refusalLabel` 函数」 carries a handle and is not one-off, so nothing
  // above stopped it — and it is unambiguously an instruction for THIS run.
  '(?:在|向|往)[^。；\\n]{0,30}?(?:里|中|内|下|上|处)\\s*(?:加|加上|添加|新增|写|写入|改|改成|删|删掉|去掉|插入|补|补上|建|新建|创建|放|放置|替换)',
  '^(?:读|看|查|跑|试|改|写|验证|检查|确认|核对|审|扫|搜|找|修|加|删|换|测试|分析|整理|实现|补)[^。；\\n]{0,6}(?:一下|一遍|一眼)',
  '(?:确认|检查|核对|看看|验证|读)[^。；\\n]{0,20}(?:还在|还在不在|有没有|是否|没有回归)',
  '^(?:把|将|请|帮我|帮忙|给我|重跑|重写|重做|重试|记得|注意)',
].join('|'), 'i');

/**
 * A concrete handle worth storing: a path, command, flag, or identifier.
 *
 * The bare-CONSTANT alternative (`ELECTRON_RUN_AS_NODE`, `DSH_HOME`, …) earns
 * its place: environment variables and constants are exactly the kind of named
 * object that makes a lesson followable, and without it real lessons such as
 * "从子进程环境里删掉 ELECTRON_RUN_AS_NODE" were judged to have no handle.
 * It requires at least one underscore after a leading capital, so ordinary
 * prose ("OK", "PDF") cannot satisfy it by accident.
 */
export const ARTIFACT_RE = /(?:[A-Za-z]:\\[^\s"'`]+|\/[\w./-]{3,}|`[^`\n]{2,}`|\b[\w.-]+\.(?:js|mjs|ts|py|json|ya?ml|md|toml|lock|exe|dll|asar)\b|\b[A-Z_]{3,}=\S+|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b\w+\.\w+\(\)|--[a-z][\w-]{2,})/;

/** Procedural shape: a sequence, or an imperative that names an action. */
const PROCEDURAL_RE = new RegExp([
  '(?:先|然后|接着|再|最后).{0,40}(?:再|然后|最后|即可|就能)',
  '(?:改|加|删|换|跑|执行|运行|安装|配置|设置|检查|验证|搜|读).{0,30}(?:文件|命令|脚本|配置|参数|变量|目录|测试|日志)',
  '\\b(?:run|set|add|remove|edit|patch|install|configure|check|verify|read|search|wrap|escape)\\s+\\w+',
  '\\d+\\s*(?:步|steps?)',
].join('|'), 'i');

export function hasConcreteDetail(text) {
  return ARTIFACT_RE.test(String(text ?? ''));
}

export function looksOneOff(text) {
  return ONE_OFF_RE.test(String(text ?? ''));
}

/**
 * How long a statement may be and still count as "one rule you can follow".
 *
 * Named because the refusal message has to quote the number: the first version
 * hard-coded `200` in the check and said nothing about it in the message, so a
 * writer who was already over the limit was told they were missing a concrete
 * object instead. A threshold nobody can see is a threshold that only rejects.
 */
export const ACTIONABLE_MAX_CHARS = 200;

/**
 * Whether a statement is a *rule* rather than a record of one incident.
 *
 * This used to be `DIRECTIVE_KINDS.has(kind)`, which made the check vacuous for
 * the highest-weight signals and let a 600-character ramble through as
 * "actionable". Shape is now required, and a directive still has to be either
 * procedural or carry a concrete handle.
 */
export function isActionable(text, kind) {
  const source = condense(text, { maxChars: 400 });
  if (source.length < 8) return false;
  if (PROCEDURAL_RE.test(source)) return true;
  if (hasConcreteDetail(source) && source.length <= ACTIONABLE_MAX_CHARS) return true;
  const directive = kind === SIGNAL.REMEMBER_REQUEST || kind === SIGNAL.USER_PREFERENCE;
  if (directive && source.length <= 120) return true;
  return false;
}

/**
 * Whether the AGENT's own prose is worth putting in the window at all.
 *
 * `recordAssistantMessage` used to accept any assistant text where
 * `classifyText(text, { source: 'assistant' })` fired an explicit bank and
 * `hasConcreteDetail` found a handle. Narration satisfies both: it is full of
 * backticked identifiers, and "Now let me look at `lib/text.js`" reads as a
 * technique to a pattern bank. The window then filled with text the gate was
 * always going to refuse.
 *
 * Measured over the ledger's whole life (2026-10-04): 261 `review.refuse` rows,
 * of which **158 (60%) were the plugin rejecting the assistant's own prose** —
 * "Now let me compress …", "Let me also check `SIGNAL_WEIGHT` …" — while the
 * whole automatic path filed 18 proposals and produced 5 rules. The code
 * comment above `recordAssistantMessage` already calls assistant turns 「the
 * noisiest source」; this is what it means in practice.
 *
 * These are the SAME shape tests `gateObservation` applies to agent-side text,
 * moved to where the text ENTERS, so the queue only ever holds something that
 * could still become a rule. It is deliberately not a change to the gate: every
 * observation this refuses would have been refused later anyway, at the cost of
 * a ledger row and a candidate scan on every tick.
 *
 * Hermes draws the same line from the other side — its reviewer reads the
 * conversation, so the assistant's reasoning is EVIDENCE there rather than a
 * candidate; see `_DO_NOT_CAPTURE_BLOCK` in `agent/background_review.py`.
 */
export function assistantObservationOk(text, kind) {
  const source = String(text ?? '');
  if (!source.trim()) return false;
  // Deliberation first: "let me…", "now I have…", "next I'll…" is thinking out
  // loud, and it is the single most common shape of the noise.
  if (META_DISCUSSION_RE.test(source)) return false;
  if (AGENT_DELIBERATION_RE.test(source)) return false;
  if (looksOneOff(source)) return false;
  if (looksLikeStatusReport(source)) return false;
  if (looksLikeCommandDump(source)) return false;
  if (!hasConcreteDetail(source)) return false;
  return isActionable(source, kind);
}

/** A question about the world, not a statement about how work is done. */
const QUESTION_RE = new RegExp([
  '[?？]\\s*$',
  '^(?:什么|哪|怎么|为什么|如何|是否|能不能|可不可以|有没有|是不是|多少)',
  '\\b(?:how|what|why|where|which|who|is|are|does|do|can|could|should|would)\\b\\s+\\S',
].join('|'), 'im');

/**
 * A standing prohibition or habit.
 *
 * Narrower than it looks, and deliberately so: this one OVERRIDES another
 * refusal (`incident`, below) and decides between the two user-side kinds, so
 * every alternative has to be something only a RULE can contain. The 别 family
 * is spelled out rather than written as `别[\u4e00-\u9fa5]`, because that would
 * fire on 特别.
 */
export const STANDING_INSTRUCTION_RE = new RegExp([
  '(?:别再|别用|别拿|别把|别写|别改|别这么|别这样|别直接|别看|不要[\\u4e00-\\u9fa5]|不用再|不必再|以后别|下次别|不应该|不该)',
  '(?<![特分个级别区差别])别[\\u4e00-\\u9fa5]',
  '(?:以后|之后|下次|每次|一律|统一|都要|坚决|绝对不)',
  '\\b(?:always|never|from\\s+now\\s+on|every\\s+time|do\\s+not|don\'?t)\\b',
].join('|'), 'i');

/**
 * A property of the environment, said as a statement of fact rather than a rule.
 *
 * There is no heuristic here on purpose. The first draft had a
 * `STATE_OF_WORLD_RE` tie-break, and it mis-routed 「跑测试用 `node scripts\selftest.mjs`。」
 * to `durable-preferences` because 「用」 was not in its verb list — chasing the
 * verb list is the same losing game the four banks were already playing. The
 * question the two kinds actually answer is narrower: is this a standing
 * instruction about how the agent should WORK (`USER_CORRECTION`), or is it a
 * fact this workspace holds (`DURABLE_FACT`)? `STANDING_INSTRUCTION_RE` answers
 * the first, and everything else is the second.
 */
export function userStatementKind(text) {
  const value = String(text ?? '');
  return STANDING_INSTRUCTION_RE.test(value) ? SIGNAL.USER_CORRECTION : SIGNAL.DURABLE_FACT;
}

/**
 * Whether a USER statement is a lesson, whatever idiom it happens to use.
 *
 * This is the fix for the largest measured hole in the whole loop. The four
 * banks above are keyed on roughly fifteen Chinese phrasings; a probe of
 * ordinary sentences (2026-10-04) found that only 2 of 8 survived
 * `classifyText(text, { source: 'user' })`. Losing them at that point is worse
 * than losing them at the gate: `recordUserMessage` returns `null` before
 * `#push`, so the sentence never enters the window, `win.turn` still increments,
 * `triggerObservations: 3` is never reached and `scheduleReview()` never fires.
 * A user phrased a real correction in their own words and the whole loop stayed
 * silent — which is the complaint 「这几轮对话还是没有任何学习」 stated exactly.
 *
 * Hermes does not have this failure mode because it never pattern-matches at
 * all: `_SKILL_REVIEW_PROMPT` reads the conversation with a model and calls
 * style, tone, format and verbosity complaints FIRST-CLASS skill signals. This
 * plugin has no model in the loop, so the honest equivalent is to stop demanding
 * an idiom: a user message that is not a task instruction, carries a concrete
 * object, and would be actionable as a rule IS a candidate.
 *
 * The second existing fallback cannot cover this. It is guarded by
 * `source !== 'assistant'`, but it ALSO requires `allowed.has(SIGNAL.TECHNIQUE)`,
 * and `SOURCE_KINDS.user` has never contained `TECHNIQUE` — so for user text it
 * is dead code, and every user sentence that is a procedure rather than one of
 * the four bank shapes is invisible by construction.
 *
 * What keeps this from swallowing task instructions is `TASK_DIRECTIVE_RE`
 * (address: text aimed AT the agent), `looksOneOff`, `QUESTION_RE` and the
 * requirement that the statement be actionable as a rule — the same bank whose
 * widening took one-turn instructions from 9/16 to 0/16 in v0.3.2. The kind
 * stays inside `SOURCE_KINDS.user`, so nothing here can raise a signal the
 * whitelist forbids.
 */
export function userStatementOk(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  if (META_DISCUSSION_RE.test(value)) return false;
  if (AGENT_DELIBERATION_RE.test(value)) return false;
  if (SELF_NARRATION_RE.test(value)) return false;
  if (looksOneOff(value)) return false;
  if (looksLikeCommandDump(value)) return false;
  if (looksLikeStatusReport(value)) return false;
  if (looksLikeIncidentReport(value)) return false;
  if (TASK_DIRECTIVE_RE.test(value)) return false;
  if (QUESTION_RE.test(value)) return false;
  if (!hasConcreteDetail(value)) return false;
  return isActionable(value, SIGNAL.DURABLE_FACT) || isActionable(value, SIGNAL.USER_CORRECTION);
}

/**
 * Classify one observation. `source` gates which kinds are even considered:
 * assistant text cannot assert a user preference, by construction.
 */
export function classifyText(text, { source = 'user' } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return [];
  const allowed = new Set(SOURCE_KINDS[source] || SOURCE_KINDS.user);
  const hits = [];
  const test = (kind, re) => {
    if (!allowed.has(kind)) return;
    re.lastIndex = 0;
    if (re.test(value)) hits.push(kind);
  };
  test(SIGNAL.REMEMBER_REQUEST, REMEMBER_RE);
  test(SIGNAL.USER_CORRECTION, CORRECTION_RE);
  test(SIGNAL.USER_PREFERENCE, PREFERENCE_RE);
  test(SIGNAL.SKILL_WRONG, SKILL_WRONG_RE);
  test(SIGNAL.DURABLE_FACT, DURABLE_FACT_RE);
  test(SIGNAL.TECHNIQUE, TECHNIQUE_RE);
  // Shape fallback: a text the banks missed can still BE a technique. Restricted
  // to non-assistant sources, because assistant prose about reading and searching
  // satisfies any "procedural" shape you can write — that is how the live run
  // filed "Now let me look inside D:\..." as a reusable technique. Assistant text
  // now needs an EXPLICIT technique frame (做法是/改成/这样就能/…) or it is not a
  // lesson; deliberation is excluded first so narration cannot enter here either.
  if (
    !hits.includes(SIGNAL.TECHNIQUE) &&
    allowed.has(SIGNAL.TECHNIQUE) &&
    source !== 'assistant' &&
    !SELF_NARRATION_RE.test(value) &&
    !looksOneOff(value) &&
    PROCEDURAL_RE.test(value) &&
    hasConcreteDetail(value)
  ) {
    hits.push(SIGNAL.TECHNIQUE);
  }
  // The user-side fallback. Last, so an explicit bank always wins and the kind
  // is never downgraded from a habitual request to a plain correction.
  if (!hits.length && source === 'user' && userStatementOk(value)) {
    hits.push(userStatementKind(value));
  }
  return hits.sort((a, b) => SIGNAL_WEIGHT[b] - SIGNAL_WEIGHT[a]);
}

/**
 * Deliberation: first-person process narration, or meta-discussion of the
 * plugin's own machinery.
 *
 * This pattern is the P0-1 regression turned into a rule. The very first skill
 * v0.1.0 ever wrote was the plugin's own English debugging monologue, because a
 * bare `always` in reasoning prose matched REMEMBER_RE. Narrowing REMEMBER_RE
 * fixes the *classification* half; this fixes the *gate* half, because a caller
 * can assert a kind directly (and the auto path does exactly that), which would
 * otherwise walk a ramble straight past a shape check that only looks at length.
 */
export const META_DISCUSSION_RE = new RegExp([
  '\\bthe\\s+(?:false\\s+positive|regex|pattern|candidate|signal-to-noise|noise)\\b',
  '\\btool[\\s-]?result\\b|\\bserialization\\b|\\blossless\\s+JSON\\b',
  '\\bassistant\\s+(?:reasoning|messages?|prose)\\b',
  // Quoting this plugin's OWN refusal wording. Pointing the finished gates at the
  // live queue left exactly two survivors, and one sentence killed both: a text
  // that contains "不是可迁移的做法" is by construction a copy of what this plugin
  // printed — either its purge report (a listing of refused candidates) or the
  // agent's own write-up about the plugin. Neither is a rule a reader can act on.
  // Applied to every source, not just agent-side text: no user phrases a
  // preference in this plugin's gate vocabulary.
  '读不出可迁移的做法|不是可迁移的做法|不是一条能照做的规则',
  // Round three of the same class. The two phrasing rules above can see "the
  // regex" and "the false positive"; they cannot see the agent discussing the
  // gate BY ITS OWN INTERNAL NAMES, which is what a model actually writes when
  // it reads this source: "Now I understand `isActionable`: - `PROCEDURAL_RE`
  // needs: 先/然后/接着/再/最后 …". Backticked identifiers are not prose, so a
  // phrase list will always be one round behind. Naming the internals is the
  // only predicate that does not have to guess: nothing outside this plugin has
  // a reason to write `gateObservation` or `looksLikeToolEnvelope` in a lesson,
  // and the one thing that does is the discussion of how they work.
  '\\b(?:isActionable|hasConcreteDetail|gateObservation|classifyText|classifyToolOutcome|condense|desensitize|fingerprint|PROCEDURAL_RE|AGENT_DELIBERATION_RE|META_DISCUSSION_RE|SELF_NARRATION_RE|ARTIFACT_RE|ONE_OFF_RE|ARTIFACT_RE|SOURCE_KINDS|SIGNAL_PATTERNS|CURATOR_INVARIANTS|looksLike[A-Z]\\w+)\\b',
].join('|'), 'i');

/**
 * The deliberation GRAMMAR, not a phrase list.
 *
 * The first version of this pattern enumerated six specific phrasings, and the
 * live run broke it immediately: "Now let me look inside D:\\..." and
 * "Found ... — that defines the workspace" are not in any phrase list, they are
 * just what planning prose looks like. So the rule is structural instead —
 * first-person intent, first-person progressive, a planning opener, a past-tense
 * report opening, or talk about the request rather than about a rule.
 *
 * Scoped to agent-side sources (see `gateObservation`): a USER writing
 * "I need to always run the tests first" is stating a preference, not narrating.
 */
export const AGENT_DELIBERATION_RE = new RegExp([
  '\\blet\\s+(?:me|us)\\b',
  "\\blet'?s\\s+\\w+",
  "\\bI(?:'ll|\\s+will|\\s+should|\\s+could|\\s+can|\\s+need\\s+to|\\s+want\\s+to|\\s+have\\s+to|\\s+must)\\b",
  "\\bI(?:'m|\\s+am)\\b",
  "\\b(?:now|then|next|first|also|finally|instead)\\s*,?\\s*(?:let\\s+me|I(?:'ll|\\s+will))\\b",
  '\\bthe\\s+user\\s+(?:wants|asked|said|requests|is\\s+asking|needs)\\b',
  '\\bthat\\s+(?:defines|tells|means|explains|would\\s+tell|will\\s+tell)\\b',
  '^(?:found|deleted|created|wrote|read|checked|updated|set|ran|moved|copied|removed|fixed|added|changed|verified|confirmed|done|got\\s+it)\\b',
  '\\bactually\\b',
  '(?:让我|我们来|我先|接下来我|我需要|我要|我会|我看看|我检查|我确认|先看看)',
].join('|'), 'i');

/**
 * A report of work already done.
 *
 * Found by running `scripts/purge-noise.mjs` against the live queue after the
 * gates were sharpened: `最终审查完成。这轮我把 v0.3.0 的 16 个模块 + 浏览器半边 +
 * 脚本全读了 …` passed every check and was headed for `environment-facts`. It is
 * not second-person (so `TASK_DIRECTIVE_RE` misses it) and it is full of concrete
 * objects (so `hasConcreteDetail` is satisfied) — what it is not is a fact. It is
 * a first-person account of a past activity, and once promoted it becomes a
 * permanent claim that somebody once read sixteen modules.
 */
export const WORK_REPORT_RE = new RegExp(
  [
    '(?:我|我们)[^。；\\n]{0,30}?(?:全读|读完|读遍|跑完|跑过|亲手跑|审完|审查完|检查完|改完|修完|写完|验证完|对过|比对过|重判过|过了一遍)',
    '(?:审查|检查|整理|核对|验证|修复|重构|排查|分析|复核|审计)\\s*(?:已经)?\\s*(?:完成|完毕|结束)',
    '(?:已|已经)\\s*(?:完成|修复|改好|跑完|写完|读完|看完|审完|过完)',
  ].join('|'),
);

/** Both halves: what must never become a lesson, from any source. */export const SELF_NARRATION_RE = new RegExp(
  `${AGENT_DELIBERATION_RE.source}|${META_DISCUSSION_RE.source}`,
  'i',
);

/**
 * A shell/script body is a transcript, not a lesson.
 *
 * The live run filed a 240-character PowerShell script as a "technique" because
 * the command succeeded. Nothing about a command that already ran is
 * transferable; only the *reason* it was needed is.
 */
export function looksLikeCommandDump(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (/^(?:#!|:\s*\$|\$env:|\$\w+\s*=|set\s+-|@['"]?\s*$)/i.test(value)) return true;
  const meta = (value.match(/[$`|;{}()[\]]/g) || []).length;
  const letters = (value.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  return meta >= 8 && meta > letters * 0.25;
}

/** Sources where first-person language is a statement, not narration. */
const NARRATION_EXEMPT = new Set(['user', 'auto-user', 'model', 'explicit', 'manual', 'note']);

/**
 * A story about ONE past incident is not a rule.
 *
 * "Small subdir recycling works once the process cwd is set to C:\. So the
 * earlier failure was because the process's current directory was D:\AI\..."
 * — every word of that is true and none of it is transferable: it explains what
 * happened once, to this directory, on this machine. The `no-incident` gate only
 * looked for ticket numbers and dates, which misses the most common shape of
 * incident report there is.
 */
export const INCIDENT_REPORT_RE = new RegExp([
  // Every alternative must point at ONE identifiable past event. Generic causal
  // connectives ("was because", "原因是") are deliberately NOT here: they carry
  // most of the useful lessons as well as most of the noise.
  '\\bthe\\s+(?:earlier|previous|last|first)\\s+(?:failure|error|attempt|problem|run|time|try)\\b',
  '\\bthat\\s+was\\s+why\\b',
  '\\bso\\s+the\\s+(?:earlier|previous)\\b',
  '\\b(?:this|it|that)\\s+(?:failed|broke|went\\s+wrong)\\s+(?:because|when|after|once)\\b',
  '(?:刚才|上次|之前那次|上一次|先前)',
].join('|'), 'i');

/**
 * A rule that carries its own WHY mentions a past event ON PURPOSE, and the
 * gate was refusing those as incident reports.
 *
 * Hermes's `_LESSON_LAYER_BLOCK` defines a pitfall as 「a generalizable rule +
 * one clause of WHY (the mechanism), imperative」 — the shape this refusal was
 * throwing away. Measured 2026-10-04: 「别再拿 robocopy 做镜像了，上次它把
 * `docs/shots` 目录清空了。」 is a prohibition with its mechanism and a handle,
 * and it came back `codes: ["incident"]`, 「是在复述一次具体事故」. The old
 * predicate fired on 上次 and stopped there.
 *
 * The discriminator is not the past tense — it is whether the sentence also
 * contains a standing instruction. 「上次构建失败了」 is a narrative; 「别再 X，
 * 上次它 Y」 is a rule with evidence. Only the first is an incident report.
 */
export function looksLikeIncidentReport(text) {
  const value = String(text ?? '');
  if (!INCIDENT_REPORT_RE.test(value)) return false;
  return !STANDING_INSTRUCTION_RE.test(value);
}

/**
 * A tool's raw OUTPUT is evidence; it is never the lesson.
 *
 * Found by pointing the finished gates at the live queue instead of at a
 * fixture: four of the sixteen queued candidates were `read`/`grep` envelopes —
 * `: Found 1 match _agent-learning\lib\capture.js Line 143: recordToolResult(...)`
 * and `<path>…</path> <type>file</type> <content> 1: # Your patch layer…` — and
 * every one of them passed, because the page of data happened to contain the
 * word "failed" somewhere inside the code it was quoting.
 *
 * The line-numbered alternative needs TWO numbered lines before it fires, so a
 * lesson that merely opens with "1:" is not mistaken for a listing.
 */
export const DATA_DUMP_RE = new RegExp([
  '<path>[\\s\\S]{0,600}?</path>',
  '</?content>',
  '\\b(?:Found|找到)\\s+\\d+\\s+match(?:es)?\\b',
  '(?:^|\\n)\\s*\\d+\\s*[:|]\\s+\\S[\\s\\S]*?(?:\\n\\s*\\d+\\s*[:|]\\s+\\S)',
  // This plugin's own candidate listing. `[KIND/source]` is the exact shape the
  // queue dump prints (and the JSONL ledger stores), so a text carrying one is a
  // copy of machine output, not a lesson — even when no `<path>` or numbered
  // line survives the 240-character condensation.
  '\\[(?:TECHNIQUE|RECOVERED_FAILURE|TOOL_FAILURE_OPEN|USER_CORRECTION|USER_PREFERENCE|DURABLE_FACT|REMEMBER_REQUEST|SKILL_WRONG)\\s*/\\s*(?:auto-tool|auto-assistant|auto-user|assistant|user|tool|model|explicit|note)\\]',
].join('|'), 'i');

export function looksLikeDataDump(text) {
  return DATA_DUMP_RE.test(String(text ?? ''));
}

/**
 * A status line records THAT something passed or failed; it never records what
 * to do about it.
 *
 * The live run filed `": syntax ok\n250/251 checks passed, 1 FAILED\nFAIL capture
 * — tool success is captured\n[exit code: 1]"` as a recovered failure with
 * weight 4 — the highest weight the plugin assigns. It is a build log. A lesson
 * has to name a problem a reader could recognise, not report a score.
 */
export const STATUS_REPORT_RE = new RegExp([
  '\\b\\d+\\s*/\\s*\\d+\\s+(?:checks?|tests?|cases?|assertions?)\\s+passed\\b',
  '\\b\\d+\\s+(?:failed|passed|errors?|warnings?)\\b',
  '\\[exit code: \\d+\\]',
  '\\b(?:npm|pnpm|yarn|node)\\s+(?:ERR!|error)\\b',
  '\\b(?:build|compilation|compile)\\s+(?:succeeded|failed|ok)\\b',
  '\\b(?:all\\s+)?(?:tests?|checks?)\\s+passed\\b',
  '\\b\\d+\\s+passing\\b',
  // A CI job's own verdict, seen live as `status: 'completed', conclusion:
  // 'failure', … ##[group]Checking out the ref`. Same defect as a test summary:
  // it reports that something went wrong, and nothing about what to do.
  "\\b(?:conclusion|outcome|status)\\s*:\\s*'?(?:success|failure|cancelled|completed|skipped)'?",
  '##\\[(?:error|group|endgroup|warning|debug)\\]',
].join('|'), 'i');

export function looksLikeStatusReport(text) {
  return STATUS_REPORT_RE.test(String(text ?? ''));
}

/**
 * Does this text name a problem a reader could recognise?
 *
 * A tool observation only becomes a lesson when its text carries a diagnosis.
 * The live run produced the counter-example: a plugin inspection command whose
 * OUTPUT (a listing of pending proposal ids and field names) was filed as a
 * recovered failure of weight 4, because the word "fail" appeared somewhere in
 * a page of data. "Something went wrong" is not a lesson; "ENOENT on
 * scripts/selftest.mjs" is.
 */
export const ERROR_SHAPE_RE = new RegExp([
  '\\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\\b',
  '\\b(?:ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EMFILE|ENOSPC)\\b',
  '\\bat\\s+\\S+\\s*\\(',                       // a stack frame
  '\\b(?:no such file|not found|cannot|can\'t|unable to|refused|denied|timed? ?out|crash(?:ed)?|broken)\\b',
  '\\b(?:failed|failure|fails)\\b',
  '(?:报错|失败|错误|异常|找不到|无法|不被允许|超时|崩溃)',
].join('|'), 'i');

export function looksLikeError(text) {
  return ERROR_SHAPE_RE.test(String(text ?? ''));
}

/**
 * The host's own tool envelope is not a lesson.
 *
 * `edit: Error: cannot modify "…\package.json": file has not been read — read
 * the file, then retry` passed every gate the plugin had. It names a real file,
 * it reads like a procedure, and the word "cannot" satisfied the error-shape
 * check — so all four candidates sitting in the live queue were this one shape,
 * every one of them produced by editing the plugin's own source.
 *
 * It is not a lesson. It is a tool telling the model to obey a rule the tool's
 * own schema already states, aimed at whatever file happened to be open, and it
 * heals on the next attempt. What makes it recognisable is the envelope — a
 * bare `<tool>: Error: …` — plus either a machine path or one of the known
 * self-healing edit messages. A bare envelope with neither is left alone,
 * because `node: Error: Cannot find module 'x'` IS a diagnosis worth keeping.
 */
export const TOOL_ENVELOPE_RE = /^\s*[\w.-]{1,40}:\s*(?:Error|error)\s*:\s*[\s\S]+$/;
/** A path that exists on this machine — `C:\…`, `\\server\…`. Not an example. */
export const MACHINE_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`|,;]+/;
export const TRANSIENT_TOOL_ERROR_RE = new RegExp(
  [
    'old_string\\s+(?:was\\s+)?not found',
    'old_string\\s+matched\\s+\\d+\\s+times',
    'more specific old_string',
    'file (?:has )?changed since it was read',
    'file has not been read',
    'read the file, then retry',
  ].join('|'),
  'i',
);

export function looksLikeToolEnvelope(text) {
  const raw = String(text ?? '');
  if (!TOOL_ENVELOPE_RE.test(raw)) return false;
  // The path check is what separates "the tool complained about my file" from
  // "the program I ran explained why it died".
  return MACHINE_PATH_RE.test(raw) || TRANSIENT_TOOL_ERROR_RE.test(raw);
}

/** An edit failure the very next attempt fixes. Never worth remembering. */
export function looksTransientToolError(text) {
  return TRANSIENT_TOOL_ERROR_RE.test(String(text ?? ''));
}

/**
 * The refusal codes that mean "this is not a followable rule".
 *
 * A refusal used to be a string and nothing else, so the one other module that
 * needed to ask this question — `lib/review.js`, labelling its per-gate detail —
 * read the refusal TEXT and matched it against `/可迁移|具体对象/`. v0.1's own
 * comment in that file warned about the shape ("a prefix match silently rots the
 * moment the other message is reworded") and then v0.3.0 rewrote one of those
 * messages to explain backticks. It still happened to match, which is the worst
 * outcome available: the two checks would have drifted apart silently.
 *
 * Codes are the contract. Rewording a refusal for the user can no longer change
 * what anything else concludes from it, and the set below is asserted against the
 * behaviour it replaces in `scripts/selftest.mjs`.
 */
export const SHAPE_REFUSALS = new Set([
  'command-dump',
  'meta-discussion',
  'incident',
  'data-dump',
  'status',
  'tool-envelope',
  'negative-claim',
  'not-actionable',
  'durable-no-object',
  // Added after the audit: a work report was produced by the gate but left out of
  // this set, so `actionable` stayed ok and a refused candidate could report six
  // checks green out of six — the one thing a "why was this refused" report must
  // never do. Its reason sentence contains neither 「可迁移」 nor 「具体对象」, which
  // is exactly why a wording match could not have caught it.
  'durable-work-report',
  // Its own code for the same reason as `durable-work-report`: "concrete but too
  // long" and "no concrete object at all" are two different corrections.
  'not-actionable-long',
]);

/**
 * Every code the plugin can refuse with, in one frozen list.
 *
 * The recap renders the CODE, not the sentence: a reason is written for the model
 * (it has to say how to pass) and is far too long for a footnote, while the code
 * is exactly the width of a glance. The browser half cannot import this module —
 * it is a separate bundle — so it keeps its own `refusal.<code>` strings, and
 * `scripts/client-check.mjs` imports BOTH and fails if a code has no label in
 * either language. Adding a refusal without a label is the failure mode this list
 * exists to make impossible.
 *
 * `injection` is not produced by this function: `lib/tools.js` refuses an
 * injected statement before the gate ever runs. It is listed here because the
 * recap still has to render it.
 */
export const REFUSAL_CODES = Object.freeze([
  'empty',
  'short',
  'long',
  'redacted',
  'command-dump',
  'meta-discussion',
  'unresolved',
  'one-off',
  'incident',
  'data-dump',
  'status',
  'tool-envelope',
  'no-error-shape',
  'env-state',
  'negative-claim',
  'durable-task-directive',
  'durable-work-report',
  'durable-no-object',
  'not-actionable',
  'not-actionable-long',
  'injection',
  // These two are not gate refusals: `lib/review.js` decides them after the gate passes,
  // and names them by check id. They are listed here because the recap renders them.
  'routed',
  'novel',
  // Not a gate refusal either: the umbrella has reached `RULE_BUDGET` and the write is
  // refused until `consolidate` makes room.
  'budget',
]);

/**
 * The anti-capture gate — a pure function, so it is unit-testable and its
 * refusal reasons can be reported verbatim to the user.
 *
 * Returns `{ ok, reasons, codes }`: `reasons` is prose for a human, `codes` is
 * the stable machine-readable half. They are pushed together and stay parallel,
 * so a reader that only wants "was it refused, and why" never has to parse the
 * prose.
 */
export function gateObservation(observation, { maxChars = 400, source = null } = {}) {
  const reasons = [];
  const codes = [];
  const refuse = (code, reason) => {
    codes.push(code);
    reasons.push(reason);
  };
  const statement = condense(observation && observation.statement, { maxChars: maxChars + 200 });
  const kind = observation && observation.kind;
  const origin = String(source ?? (observation && observation.source) ?? '').toLowerCase();
  if (!statement) refuse('empty', '没有可记录的陈述');
  if (statement.length < 8) refuse('short', '陈述过短，信息量不足');
  if (statement.length > maxChars) refuse('long', `陈述过长（>${maxChars} 字）`);
  if (statement.length > 0 && isMostlyRedacted(statement)) refuse('redacted', '几乎全是脱敏占位符');
  if (looksLikeCommandDump(statement)) {
    refuse('command-dump', '是一段命令/脚本原文，不是可迁移的做法');
  }
  // Deliberation only counts against agent-side text. A user writing "I need to…"
  // is stating a requirement; the agent writing it is thinking out loud.
  const agentSide = !NARRATION_EXEMPT.has(origin);
  if (META_DISCUSSION_RE.test(statement) || (agentSide && AGENT_DELIBERATION_RE.test(statement))) {
    refuse('meta-discussion', '是过程叙述或插件自身的讨论，不是可迁移的做法');
  }
  if (kind === SIGNAL.TOOL_FAILURE_OPEN) refuse('unresolved', '失败尚未解决，先不落盘（解决后再记做法）');
  if (looksOneOff(statement)) refuse('one-off', '看起来是一次性要求，不是通用规则');
  // An incident report explains what happened ONCE. The rule that generalises
  // from it may be worth writing — but the report itself is not the rule, and
  // filing it produces an entry nobody can act on.
  if (looksLikeIncidentReport(statement)) {
    refuse('incident', '是在复述一次具体事故（不是可迁移的做法）');
  }
  if (looksLikeDataDump(statement)) {
    refuse('data-dump', '是工具输出的原文（清单/搜索结果/文件内容），不是可迁移的做法');
  }
  if (looksLikeStatusReport(statement)) {
    refuse('status', '是一行状态/结果输出（通过或失败的计数），不是可迁移的做法');
  }
  if (looksLikeToolEnvelope(statement)) {
    refuse('tool-envelope', '是宿主工具的一次自愈报错（工具说明已写明做法），不是可迁移的做法');
  }
  // A tool observation's raw text is machine output, so the error-shape check is
  // applied AFTER the data-dump check: the word "failed" appearing inside a
  // quoted code block is not a diagnosis. What is left has to carry a real
  // error: an exception name, an errno, a stack frame, or an exit code.
  const toolSide = /tool/i.test(origin);
  if (toolSide && (kind === SIGNAL.RECOVERED_FAILURE || kind === SIGNAL.TOOL_FAILURE_OPEN) && !looksLikeError(statement)) {
    refuse('no-error-shape', '工具输出里读不出具体报错（不是一条能照做的规则）');
  }
  if (ENV_STATE_RE.test(statement) && kind !== SIGNAL.RECOVERED_FAILURE && kind !== SIGNAL.TECHNIQUE) {
    refuse('env-state', '属于环境状态（缺依赖/未配置/无权限），用户可修复，不记为长期规则');
  }
  if (NEGATIVE_CLAIM_RE.test(statement) && !hasConcreteDetail(statement)) {
    refuse('negative-claim', '只有否定断言、没有可迁移的做法或具体对象');
  }
  // `DURABLE_FACT` is the one kind whose whole claim is "this is how the world
  // is", so it is the one kind worth being strict about. A fact has to name
  // something you could go and look at; and it must not be addressed at the
  // agent, because a task instruction filed as an environment fact outlives the
  // task and quietly becomes a constraint on every later session.
  // `USER_PREFERENCE` is deliberately untouched: "以后都用中文回复我" is
  // addressed at the agent too, and it is exactly what should be kept.
  if (kind === SIGNAL.DURABLE_FACT) {
    if (TASK_DIRECTIVE_RE.test(statement)) {
      refuse('durable-task-directive', '是对这一轮的任务指令（第二人称祈使），不是环境事实：这样的句子进了 environment-facts 会变成以后每个会话都要遵守的假约束');
    } else if (WORK_REPORT_RE.test(statement)) {
      // The third shape, and the one the purge tool found by being run: a report
      // of work already done is not a fact about the world. `最终审查完成。这轮我
      // 把 v0.3.0 的 16 个模块…全读了` passed every gate — it is not second-person,
      // and it is stuffed with concrete objects — so it was queued for
      // `environment-facts`, where it would have become a permanent claim that
      // somebody once read sixteen modules. Reports expire; environment facts are
      // standing constraints.
      refuse('durable-work-report', '是一份「我做了什么」的汇报，不是环境事实：汇报讲的是过去某个时点，而 environment-facts 是以后每次都要成立的前提');
    } else if (!hasConcreteDetail(statement)) {
      refuse('durable-no-object', '环境事实得给得出具体对象（路径、版本、端点、开关），否则它只是当时的说法');
    }
  }
  if (!isActionable(statement, kind)) {
    // The refusal has to say how to pass, not just that it failed. A live test
    // found the whole difference between refused and accepted was BACKTICKS:
    // "把 `Tee-Object -FilePath` 接在 `Select-Object -First` 之后…" was filed,
    // and the identical sentence without the backticks was refused. `ARTIFACT_RE`
    // is how `hasConcreteDetail` finds a handle, and a bare cmdlet name in prose
    // is not one it can see. Telling the model that is the difference between a
    // dead end and a corrected sentence.
    //
    // SECOND TIME THIS MESSAGE WAS THE BUG, one level deeper: filing a 217-character
    // durable fact FULL of backticked paths was refused with this same "缺少具体对象"
    // sentence. `isActionable` accepts a concrete detail only while the text is
    // `<= 200` chars, so the handles were there and the length was the problem. A
    // model reading the old text would have added more backticks forever. So the
    // branch now says which of the two it is — and still does not widen the gate:
    // the cap exists so one filename cannot carry a paragraph into the library.
    const tooLongButConcrete = hasConcreteDetail(statement);
    if (tooLongButConcrete) {
      // Its own code. Both branches used to push `not-actionable`, which meant the
      // two fixes a reader can be told to make — "add a handle" and "cut it in
      // half" — arrived under one label. The recap prints the code, so one label
      // for two fixes is one label too few.
      refuse('not-actionable-long', `具体对象有，但太长了：${statement.length} 字，超过 ${ACTIONABLE_MAX_CHARS} 字就不算「一条能照做的规则」——长句里的路径会被当成顺带提到，而不是这条规则的对象。拆成几条，每条一句、${ACTIONABLE_MAX_CHARS} 字以内再记。`);
    } else {
      refuse('not-actionable', '缺少可迁移的做法或具体对象（不是一条能照做的规则）：要么写成步骤（先…然后…），要么把命令名、参数、路径、文件名用反引号括起来——门槛就是靠反引号里的东西认出「具体对象」的，例如 `--dry-run`、`lib/text.js`。');
    }
  }
  return { ok: reasons.length === 0, reasons, codes };
}

/**
 * Resolve a tool call's outcome into a signal, if any.
 *
 * A SUCCESSFUL call deliberately yields nothing. The first live run taught this
 * the hard way: `resolved && SUCCESS_RE → TECHNIQUE` filed the raw command text
 * of every command that worked, because "it succeeded" is a fact about the
 * transcript, not a fact about the world. Only trouble is worth remembering —
 * and the fix for trouble is the best signal there is.
 */
export function classifyToolOutcome({ ok, summary, resolved = false } = {}) {
  const text = String(summary ?? '');
  if (!text) return null;
  // Stop the envelope before it becomes an observation at all. The gate would
  // refuse it too, but a refusal still costs a ledger row and a scan of the
  // candidate window every tick — and this shape arrives constantly, since the
  // model edits files all day.
  if (looksLikeToolEnvelope(text)) return null;
  if (resolved && FAILURE_RE.test(text)) return SIGNAL.RECOVERED_FAILURE;
  if (!ok && FAILURE_RE.test(text)) return SIGNAL.TOOL_FAILURE_OPEN;
  return null;
}

export const SIGNAL_PATTERNS = {
  REMEMBER_RE,
  PREFERENCE_RE,
  CORRECTION_RE,
  SKILL_WRONG_RE,
  DURABLE_FACT_RE,
  TECHNIQUE_RE,
  FAILURE_RE,
  SUCCESS_RE,
  ENV_STATE_RE,
  NEGATIVE_CLAIM_RE,
  ONE_OFF_RE,
  ARTIFACT_RE,
  SELF_NARRATION_RE,
  AGENT_DELIBERATION_RE,
  META_DISCUSSION_RE,
  TASK_DIRECTIVE_RE,
  INCIDENT_REPORT_RE,
  STATUS_REPORT_RE,
  DATA_DUMP_RE,
  ERROR_SHAPE_RE,
  TOOL_ENVELOPE_RE,
  MACHINE_PATH_RE,
  TRANSIENT_TOOL_ERROR_RE,
  looksLikeCommandDump,
  looksLikeIncidentReport,
  looksLikeStatusReport,
  looksLikeDataDump,
  looksLikeError,
  looksLikeToolEnvelope,
  looksTransientToolError,
};
