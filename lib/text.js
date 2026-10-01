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
  '(?:我(?:更)?(?:喜欢|偏好|习惯|倾向)|我一般|我通常|对我来说|我的习惯是|默认用|一律用)',
  '\\bi\\s+(?:prefer|usually|normally|generally|always\\s+use|tend\\s+to)\\b',
  '\\bmy\\s+(?:preference|habit|convention|style)\\s+is\\b',
].join('|'), 'i');

export const CORRECTION_RE = new RegExp([
  '(?:不对|不是这样|错了|搞错|你又|我说过|我说的是|别用|不要用|不应该|不该|重来|纠正|更正|更正一下)',
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

export const DURABLE_FACT_RE = new RegExp([
  '(?:环境|机器|系统|仓库|项目).{0,12}(?:是|用的是|固定在|位于|路径是)',
  '(?:必须|只能|不能用|不支持|依赖)\\s*[A-Za-z0-9_.\\-/]{2,}',
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
  '(?:未安装|没安装|没有安装|缺少|找不到|命令不存在|未配置|没有配置|未设置|凭据|未登录|没权限)',
  '\\b(?:command\\s+not\\s+found|not\\s+installed|no\\s+such\\s+file|permission\\s+denied|ENOENT|EPERM|EACCES|MODULE_NOT_FOUND|not\\s+configured|missing\\s+credential|not\\s+logged\\s+in)\\b',
].join('|'), 'i');

/** A flat denial ("X is broken", "the browser tool doesn't work"). */
export const NEGATIVE_CLAIM_RE = new RegExp([
  '(?:用不了|不能用|没法用|坏了|没反应|不可用|不支持|搞不定)',
  '\\b(?:doesn\'?t\\s+work|is\\s+broken|is\\s+useless|cannot\\s+be\\s+used|unusable|not\\s+available|no\\s+longer\\s+works)\\b',
].join('|'), 'i');

/** One-off, this-turn-only requests: correct to obey, wrong to remember. */
export const ONE_OFF_RE = new RegExp([
  '(?:这一次|这次|仅此一次|就这一个|临时|先这样|暂时)',
  '\\b(?:just\\s+this\\s+once|for\\s+now|this\\s+time\\s+only|temporarily)\\b',
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
  if (hasConcreteDetail(source) && source.length <= 200) return true;
  const directive = kind === SIGNAL.REMEMBER_REQUEST || kind === SIGNAL.USER_PREFERENCE;
  if (directive && source.length <= 120) return true;
  return false;
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

/** Both halves: what must never become a lesson, from any source. */
export const SELF_NARRATION_RE = new RegExp(
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

export function looksLikeIncidentReport(text) {
  return INCIDENT_REPORT_RE.test(String(text ?? ''));
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
 * The anti-capture gate — a pure function, so it is unit-testable and its
 * refusal reasons can be reported verbatim to the user.
 */
export function gateObservation(observation, { maxChars = 400, source = null } = {}) {
  const reasons = [];
  const statement = condense(observation && observation.statement, { maxChars: maxChars + 200 });
  const kind = observation && observation.kind;
  const origin = String(source ?? (observation && observation.source) ?? '').toLowerCase();
  if (!statement) reasons.push('没有可记录的陈述');
  if (statement.length < 8) reasons.push('陈述过短，信息量不足');
  if (statement.length > maxChars) reasons.push(`陈述过长（>${maxChars} 字）`);
  if (statement.length > 0 && isMostlyRedacted(statement)) reasons.push('几乎全是脱敏占位符');
  if (looksLikeCommandDump(statement)) {
    reasons.push('是一段命令/脚本原文，不是可迁移的做法');
  }
  // Deliberation only counts against agent-side text. A user writing "I need to…"
  // is stating a requirement; the agent writing it is thinking out loud.
  const agentSide = !NARRATION_EXEMPT.has(origin);
  if (META_DISCUSSION_RE.test(statement) || (agentSide && AGENT_DELIBERATION_RE.test(statement))) {
    reasons.push('是过程叙述或插件自身的讨论，不是可迁移的做法');
  }
  if (kind === SIGNAL.TOOL_FAILURE_OPEN) reasons.push('失败尚未解决，先不落盘（解决后再记做法）');
  if (looksOneOff(statement)) reasons.push('看起来是一次性要求，不是通用规则');
  // An incident report explains what happened ONCE. The rule that generalises
  // from it may be worth writing — but the report itself is not the rule, and
  // filing it produces an entry nobody can act on.
  if (looksLikeIncidentReport(statement)) {
    reasons.push('是在复述一次具体事故（不是可迁移的做法）');
  }
  if (looksLikeDataDump(statement)) {
    reasons.push('是工具输出的原文（清单/搜索结果/文件内容），不是可迁移的做法');
  }
  if (looksLikeStatusReport(statement)) {
    reasons.push('是一行状态/结果输出（通过或失败的计数），不是可迁移的做法');
  }
  // A tool observation's raw text is machine output, so the error-shape check is
  // applied AFTER the data-dump check: the word "failed" appearing inside a
  // quoted code block is not a diagnosis. What is left has to carry a real
  // error: an exception name, an errno, a stack frame, or an exit code.
  const toolSide = /tool/i.test(origin);
  if (toolSide && (kind === SIGNAL.RECOVERED_FAILURE || kind === SIGNAL.TOOL_FAILURE_OPEN) && !looksLikeError(statement)) {
    reasons.push('工具输出里读不出具体报错（不是一条能照做的规则）');
  }
  if (ENV_STATE_RE.test(statement) && kind !== SIGNAL.RECOVERED_FAILURE && kind !== SIGNAL.TECHNIQUE) {
    reasons.push('属于环境状态（缺依赖/未配置/无权限），用户可修复，不记为长期规则');
  }
  if (NEGATIVE_CLAIM_RE.test(statement) && !hasConcreteDetail(statement)) {
    reasons.push('只有否定断言、没有可迁移的做法或具体对象');
  }
  if (!isActionable(statement, kind)) reasons.push('缺少可迁移的做法或具体对象（不是一条能照做的规则）');
  return { ok: reasons.length === 0, reasons };
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
  INCIDENT_REPORT_RE,
  STATUS_REPORT_RE,
  DATA_DUMP_RE,
  ERROR_SHAPE_RE,
  looksLikeCommandDump,
  looksLikeIncidentReport,
  looksLikeStatusReport,
  looksLikeDataDump,
  looksLikeError,
};
