/**
 * The post-turn review — the heart of the plugin.
 *
 * The obvious way to ask "should any skill be saved after this turn?" is to
 * spend another model call on it. DSH gives us a cheaper primitive for the same
 * job: the session event feed plus a bounded, already-distilled observation
 * window (see `capture.js`). So the reviewer runs with ZERO extra model calls
 * and never mutates the conversation or the prompt — the two invariants that
 * matter (the prefix cache is never invalidated, self-improvement never blocks
 * a turn). The price is that a regex cannot judge meaning, which is why the
 * deterministic path proposes and only the model writes.
 *
 * What changed after the first version wrote its own debug monologue into the
 * user's preference skill:
 *
 *   The deterministic path no longer WRITES. It proposes. A regex can recall
 *   and score — it cannot judge whether a sentence is a transferable rule, and
 *   pretending otherwise put the policy text in the tool description while a
 *   pattern bank sat in the judgement seat. Proposals land in `pending.json`
 *   with the gate verdict attached, and the model promotes them through the
 *   validated `learn_skill_manage` path. The one path where the model IS present
 *   (`learn action=note`) writes immediately, because there the judgement has
 *   already been made by the thing that is actually qualified to make it.
 *
 * Every decision — proposed, promoted, merged, dropped, undone — lands in the
 * ledger with its reason and its session, so "why does this skill exist" and
 * "who wrote this rule" are always answerable.
 */

import { KIND_LABEL } from './capture.js';
import { buildSkillBody } from './skills.js';
import { ruleId } from './skills.js';
import { SHAPE_REFUSALS, SIGNAL, classifyText, condense, fingerprint, gateObservation, looksLikeIncidentReport, tokenize } from './text.js';

/** Class-level umbrellas. A lesson must fit one of these, or nothing is written. */
export const UMBRELLAS = Object.freeze({
  'durable-preferences': {
    title: '用户长期偏好',
    description: '用户对协作方式的长期要求：语言、格式、详略、流程与验证标准。命中「记住」「以后」时加载。',
    whenToUse: '当任务是按用户偏好交付（写代码、解释、汇报、排版）且不确定格式或详略取舍时',
  },
  'tool-recovery': {
    title: '工具/命令失败后的排查与恢复',
    description: '工具、命令或构建失败后真正修好它的做法：先看什么、按什么顺序排查、哪条命令能复原。命中「报错」时加载。',
    whenToUse: '当命令或工具报错、构建失败、行为不符合预期且需要恢复而不是绕开时',
  },
  'environment-facts': {
    title: '环境与项目约定',
    description: '当前环境与项目的持久事实：版本约束、路径与配置约定、只支持某种用法的限制。命中「必须」时加载。',
    whenToUse: '当要写配置、选依赖版本、决定路径或判断某个做法在本项目是否可行时',
  },
});

/** Kinds an explicit `note` may declare (the model knows better than a regex). */
const DECLARABLE_KINDS = new Set([
  SIGNAL.REMEMBER_REQUEST,
  SIGNAL.USER_PREFERENCE,
  SIGNAL.USER_CORRECTION,
  SIGNAL.DURABLE_FACT,
  SIGNAL.TECHNIQUE,
  SIGNAL.RECOVERED_FAILURE,
  SIGNAL.SKILL_WRONG,
]);

/** Soft ceiling on rules per umbrella; crossing it is reported, never silent. */
export const RULE_BUDGET = 24;
/** Duplicate detection on the proposal path. */
export const SIMILARITY_THRESHOLD = 0.6;

export function tokenSimilarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

/** Map a signal to its umbrella. Unknown ⇒ no home ⇒ no write. */
export function classifyRoute(kind, statement = '') {
  switch (kind) {
    case SIGNAL.REMEMBER_REQUEST:
    case SIGNAL.USER_PREFERENCE:
    case SIGNAL.USER_CORRECTION:
      return 'durable-preferences';
    case SIGNAL.SKILL_WRONG:
      return 'tool-recovery';
    case SIGNAL.DURABLE_FACT:
      return 'environment-facts';
    case SIGNAL.RECOVERED_FAILURE:
    case SIGNAL.TOOL_FAILURE_OPEN:
      return 'tool-recovery';
    case SIGNAL.TECHNIQUE:
      return /\b(?:版本|路径|配置|必须|只能|依赖|version|path|config)\b/i.test(statement)
        ? 'environment-facts'
        : 'tool-recovery';
    default:
      return null;
  }
}

/**
 * Render one rule line with its stable anchor. The anchor is what makes a rule
 * addressable: `learn action=undo` and consolidate need to name a rule that
 * survives edits elsewhere in the file, which a line number cannot do.
 */
export function renderRule({ text, meta = {} }) {
  const id = meta.id || ruleId(text);
  const where = [meta.at ? String(meta.at).slice(0, 10) : '', meta.session ? `会话 ${meta.session}` : '', meta.kind ? KIND_LABEL[meta.kind] || meta.kind : '']
    .filter(Boolean)
    .join(' · ');
  const provenance = where ? `（来自 ${where}）` : '';
  return `- ${condense(text, 400)}${provenance} <!-- r:${id} -->`;
}

/** Inverse of `renderRule`, for reading a stored line back. */
export function parseRuleLine(line) {
  const body = String(line || '').replace(/^\s*[-*]\s+/, '').trim();
  const anchor = /<!--\s*(?:r:)?([A-Za-z0-9_-]+)\s*-->/.exec(body);
  const withoutAnchor = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  const prov = /（来自\s*([^）]*)）\s*$/.exec(withoutAnchor);
  const text = prov ? withoutAnchor.slice(0, prov.index).trim() : withoutAnchor;
  const parts = prov ? prov[1].split('·').map((part) => part.trim()) : [];
  return {
    id: anchor ? anchor[1] : ruleId(text),
    text,
    at: parts[0] || '',
    session: (parts[1] || '').replace(/^会话\s*/, ''),
    kindLabel: parts[2] || '',
    raw: String(line || '').trim(),
  };
}

/** Best-effort map from a stored kind label back to a signal name. */
function kindFromLabel(label) {
  for (const [kind, text] of Object.entries(KIND_LABEL)) if (text === label) return kind;
  if (label === '技术手法' || label === '有效做法') return SIGNAL.TECHNIQUE;
  return '';
}

export function createReview({ config, store, skills, managed, curator, logger, capture, onAction }) {
  // The three review knobs the README documents as tunable, resolved once,
  // here. v0.2.3 shipped all three as placebos — `normalizeConfig` produced
  // them, the README's config table sold them, and nothing ever read them,
  // which is the exact shape this plugin's own rule forbids ("加一个键，必须
  // 同时加它的读者"). Reading them at the one place that owns the limits is
  // what makes the table true.
  const reviewConfig = (config && config.review) || {};
  const ruleBudget = Math.max(5, Number(reviewConfig.ruleBudget) || RULE_BUDGET);
  const similarityThreshold = Math.min(0.95, Math.max(0.3, Number(reviewConfig.similarity) || SIMILARITY_THRESHOLD));
  const maxProposalsPerRun = Math.max(1, Number(reviewConfig.maxProposals) || 8);

  /**
   * @param {object} lesson
   * @param {{checkNovel?: boolean}} [options] `checkNovel` is on for the proposal
   * path and off for the decision path. "This is already a rule" is a reason not
   * to queue a SECOND candidate; it is not a reason to refuse writing the rule,
   * because `remember` reinforces the existing line in exactly that case. Leaving
   * the check on there would turn the most ordinary event in the plugin — the
   * same lesson twice — into a refusal.
   */
  const gatesFor = (lesson, { checkNovel = true } = {}) => {
    const checks = [];
    const text = String(lesson.statement || '');
    const push = (id, ok, reason) => checks.push({ id, ok, reason: ok ? '' : reason });
    // `resolved` used to be passed here and read by nobody: whether a failure was
    // since fixed is decided at the observation window (`capture.js` rewrites the
    // item's `kind` to TOOL_FAILURE_OPEN), so by the time a lesson reaches the gate
    // the answer is already in `kind`. One parameter nobody reads is one more place
    // a future change can look wired up and not be.
    const gate = gateObservation(
      { statement: text, kind: lesson.kind },
      { maxChars: 400, source: lesson.source },
    );

    push('general', text.length >= 8 && text.length <= 400, text.length > 400 ? '陈述过长（>400 字）' : '陈述过短');
    // Shape, not kind: the old `directive ⇒ actionable` shortcut is gone, since
    // it made every length-passing ramble "actionable" by construction.
    //
    // This used to call `isActionable` by PROXY — it read the gate's refusal
    // reasons and matched them against `/可迁移|具体对象/`. v0.1's own comment
    // warned about exactly that shape ("a prefix match silently rots the moment
    // the other message is reworded"), and then v0.3.0 rewrote one of those
    // messages to explain backticks. It still happened to match, which is worse
    // than breaking: the two would have drifted apart with nothing to notice.
    // The gate now says which refusals mean "not a followable rule" BY CODE.
    push('actionable', !gate.codes.some((code) => SHAPE_REFUSALS.has(code)), '读不出可迁移的做法或具体对象');
    push('durable', true, '');
    push(
      'no-incident',
      !/\b(?:PR|issue|ticket)\s*#?\d+/i.test(text) && !/\b\d{4}-\d{2}-\d{2}\b/.test(text) && !looksLikeIncidentReport(text),
      '含日期、工单号，或是在复述一次具体事故',
    );
    const umbrella = lesson.umbrella || classifyRoute(lesson.kind, text);
    push('routed', Boolean(umbrella), '没有匹配的类级技能（不新建技能）');
    // Was `push('novel', true, '')` — a gate that could not fail, printed as if
    // it had been checked. It answers one question: is this already a rule?
    // A repeat of a still-PENDING candidate is not "not novel"; that path is
    // handled after the gates, where the item's hit count goes up instead.
    push('novel', !checkNovel || !writtenFingerprints().has(fingerprint(text)), '这条已经写成规则了（同样的候选不会再提一次）');
    return { checks, gate, umbrella };
  };

  /** Why a lesson was refused, in human terms. Shared by every capture path. */
  const gateReasons = (gate, checks) => {
    const failed = checks.filter((check) => !check.ok).map((check) => check.reason || check.id);
    const reasons = [...new Set([...(gate && !gate.ok ? gate.reasons : []), ...failed])].filter(Boolean);
    // Passing every gate must read as "no objection" — not as the generic
    // refusal text, which made a clean proposal look rejected on inspection.
    return reasons.join('；');
  };

  /** Existing rules across the umbrellas, for dedup and consolidation. */
  const allRules = () => {
    const out = [];
    for (const name of Object.keys(UMBRELLAS)) {
      if (!skills.exists(name)) continue;
      for (const rule of skills.readRules(name)) {
        const parsed = parseRuleLine(rule.raw);
        out.push({ umbrella: name, ...parsed, id: rule.id });
      }
    }
    return out;
  };

  /**
   * The fingerprints already written down as rules — as opposed to merely seen.
   *
   * This used to read the whole ledger and collect `fp` fields, which made it the
   * only unbounded reader in the plugin (399 rows / 857KB / 23 hours, and growing
   * without limit). It was also exported and never called, so the `novel` gate
   * above it was hardcoded `true` — every candidate the doctor ever printed said
   * `novel=ok`, including the ones it had refused a dozen times before. The
   * question it was trying to answer is narrower than "what have I ever seen":
   * it is "is this already a rule", and the answer lives in the sidecar plus the
   * rules on disk, both of which are bounded and cheap.
   */
  const writtenFingerprints = () => {
    const set = store.seenFingerprints();
    for (const rule of allRules()) set.add(fingerprint(rule.text));
    return set;
  };

  /** Everything already accounted for: rules, the sidecar, and the live queue. */
  const knownFingerprints = () => {
    const set = writtenFingerprints();
    for (const item of store.loadPending()) if (item.fp) set.add(item.fp);
    return set;
  };

  /** Nearest existing rule for a candidate, if it is close enough to be a dup. */
  const nearestRule = (statement, umbrella = null) => {
    let best = null;
    for (const rule of allRules()) {
      if (umbrella && rule.umbrella !== umbrella) continue;
      const score = tokenSimilarity(statement, rule.text);
      if (score >= similarityThreshold && (!best || score > best.score)) best = { ...rule, score };
    }
    return best;
  };

  // ------------------------------------------------------------- proposals

  /**
   * File a candidate as a PROPOSAL. Never writes a skill file. The return value
   * distinguishes a fresh proposal from a repeat, because "an existing proposal
   * was reinforced" is information the model needs to decide.
   */
  const propose = ({ statement, kind, source = 'auto', session = '', tool = '', weight = 1, umbrella = null, notes = [] }) => {
    const text = condense(statement, 400);
    if (!text) return { ok: false, reason: '没有陈述' };
    const decidedUmbrella = umbrella || classifyRoute(kind, text);
    const lesson = { statement: text, kind, umbrella: decidedUmbrella, source };
    const { checks, gate } = gatesFor(lesson);
    const reason = gateReasons(gate, checks);
    const passed = gate.ok && checks.every((check) => check.ok);
    // A candidate that cannot pass the gates is REFUSED, not queued. Filing it
    // anyway would leave the model reading through noise it can only reject —
    // and the gate exists precisely to keep that noise out of the queue.
    if (!passed) {
      store.appendLedger({
        action: 'review.refuse',
        umbrella: decidedUmbrella,
        kind,
        statement: condense(text, 200),
        reason,
        session,
        source,
      });
      return {
        ok: false,
        refused: true,
        statement: text,
        umbrella: decidedUmbrella,
        reason,
        checks: checks.map((check) => ({ id: check.id, ok: check.ok, reason: check.reason })),
      };
    }
    const fp = fingerprint(text);
    // Nothing is recorded in the sidecar here, on purpose. A queued candidate is
    // already persisted in `pending.json`, and re-proposing it must INCREMENT its
    // hit count rather than be refused for not being novel — that is what "the
    // same lesson twice merges" means. The sidecar holds written rules only, so
    // `novel` can answer its one question without ever silencing a repeat.
    // Resolve the duplicate BEFORE filing: the nearest-rule search reads the
    // skill files, and doing it afterwards would be a race with our own write.
    const duplicate = nearestRule(text, decidedUmbrella);

    const filed = store.updatePending((items) => {
      const existing = items.find((item) => item.fp === fp);
      if (existing) {
        // Real hit counting. The old `defer()` wrote a constant 1, so the
        // advertised "same lesson twice merges" never actually happened.
        existing.hits = (existing.hits || 1) + 1;
        existing.lastAt = new Date().toISOString();
        existing.sessions = [...new Set([...(existing.sessions || []), session].filter(Boolean))].slice(-10);
        return items;
      }
      items.push({
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        kind,
        source,
        session,
        tool,
        weight,
        umbrella: decidedUmbrella,
        statement: text,
        fp,
        hits: 1,
        sessions: session ? [session] : [],
        ok: true,
        reason: '',
        checks: checks.map((check) => ({ id: check.id, ok: check.ok, reason: check.reason })),
        duplicateOf: null,
        notes: [...notes],
      });
      return items;
    });
    const item = filed.find((entry) => entry.fp === fp);
    if (!item) return { ok: false, reason: '提案入队失败' };
    if (duplicate) {
      item.duplicateOf = {
        umbrella: duplicate.umbrella,
        id: duplicate.id,
        text: duplicate.text,
        score: Math.round((duplicate.score || 0) * 100) / 100,
      };
      item.notes = [
        ...new Set([
          ...item.notes,
          `与既有规则相似（${Math.round((duplicate.score || 0) * 100)}%）：${condense(duplicate.text, 80)}`,
        ]),
      ];
    }
    return { ...item, ok: true, reason: '', checks: item.checks };
  };

  /**
   * The automatic path: turn the capture window into proposals. Deterministic,
   * zero model calls, and — critically — unable to write.
   */
  const runReview = (sessionId, { dryRun = true, minWeight = 2, maxProposals = maxProposalsPerRun } = {}) => {
    const win = capture.window(sessionId);
    if (!win) return { ok: true, session: sessionId, proposals: [], note: '没有该会话的观测窗口' };
    const candidates = capture.proposals(sessionId, { minWeight, maxProposals });
    const filed = [];
    const skipped = [];
    const consumed = [];
    const promoted = [];
    for (const candidate of candidates) {
      if (dryRun) {
        filed.push({ dryRun: true, ...candidate, umbrella: classifyRoute(candidate.kind, candidate.statement) });
        continue;
      }
      // Audit (a): the queue had no consumer. It filled with candidates nobody
      // ever promoted, because promotion needed a second model call that nothing
      // in the loop ever summoned — 4 perfect candidates sat a full day and the
      // umbrellas stayed empty. ONE class does not need that call: a
      // REMEMBER_REQUEST that came out of the USER's own message. "用户明确要求
      // 记住" IS the verdict the model would give, so queueing it and waiting for
      // a confirmation produces latency without producing judgement. Everything
      // else still queues, because everything else still needs a decision.
      const userAsked = candidate.source === 'user' && candidate.kind === SIGNAL.REMEMBER_REQUEST;
      const result = userAsked
        ? remember({
            statement: candidate.statement,
            kind: candidate.kind,
            source: 'user-request',
            session: sessionId,
            note: '用户在本会话里明确要求记住：直接落盘，不等二次确认',
          })
        : propose({
            statement: candidate.statement,
            kind: candidate.kind,
            source: candidate.source === 'user' ? 'auto-user' : candidate.source === 'tool' ? 'auto-tool' : 'auto-assistant',
            session: sessionId,
            tool: candidate.tool || '',
            weight: candidate.weight,
            notes: candidate.notes,
          });
      // Either way the observation is DONE with: a filed proposal must not be
      // filed again next tick (that is what inflated `hits`), and a refusal must
      // not be re-litigated every tick (that is what produced 124 ledger rows
      // saying the same thing). A later state change re-opens it explicitly.
      if (candidate.id) consumed.push({ id: candidate.id, proposalId: (result && result.id) || null });
      if (result && result.ok) {
        if (userAsked) promoted.push({ statement: candidate.statement, umbrella: result.umbrella, ruleId: result.ruleId, reinforced: result.reinforced === true });
        else filed.push(result);
      } else {
        skipped.push({ statement: candidate.statement, reason: result ? result.reason : '未记录' });
      }
    }
    if (!dryRun && consumed.length && typeof capture.markFiled === 'function') {
      capture.markFiled(sessionId, consumed);
    }
    const report = {
      ok: true,
      session: sessionId,
      dryRun,
      observations: win.items.length,
      filed: filed.length,
      promoted,
      skipped,
      proposals: filed,
      // Every queued candidate carries the exact command that promotes it, so
      // "what do I do with these" has an answer inside the report itself.
      pending: store.loadPending().map((item) => ({ id: item.id, fp: item.fp, umbrella: item.umbrella, kind: item.kind, hits: item.hits, statement: condense(item.statement, 160), promote: `learn action=restore-pending fp=${item.fp}` })),
      pendingTotal: store.loadPending().length,
    };
    if (!dryRun) {
      // Counts plus a few samples, not the whole run.
      //
      // This row used to embed every filed proposal and every skipped statement,
      // and it was 78% of an 857KB ledger after 23 hours — `filed` alone carried
      // an id, an umbrella, an ok flag and a reason per candidate. The row exists
      // so that "what did the review do at 14:02" stays answerable; nobody has
      // ever needed the full roster in the ledger, because the queue itself is on
      // disk and the refused ones are one `learn action=pending` away. Samples
      // keep the row readable AND keep it from being the only record of a shape
      // that has since changed.
      store.appendLedger({
        action: 'review.propose',
        session: sessionId,
        dryRun: false,
        filedCount: filed.length,
        filed: filed.slice(0, 5).map((item) => ({ id: item.id, umbrella: item.umbrella, ok: item.ok })),
        promotedCount: promoted.length,
        promoted: promoted.slice(0, 5),
        skippedCount: skipped.length,
        skipped: skipped.slice(0, 5).map((item) => ({
          statement: condense(item.statement ?? item, 120),
          reason: item.reason || '',
        })),
      });
    }
    store.updateState((state) => {
      state.last_review_at = new Date().toISOString();
      state.reviews = (state.reviews || 0) + 1;
      state.proposals_filed = (state.proposals_filed || 0) + (dryRun ? 0 : filed.length);
      state.rules_written = (state.rules_written || 0) + (dryRun ? 0 : promoted.length);
      return state;
    });
    return report;
  };

  /** Explicit promotion of a queued proposal, with the model's own wording. */
  const promoteProposal = (id, { statement = '', session = '' } = {}) => {
    const items = store.loadPending();
    const item = items.find((entry) => entry.id === id || entry.fp === id);
    if (!item) return { ok: false, reason: `没有待定提案 ${id}` };
    return remember({
      statement: statement || item.statement,
      kind: item.kind,
      source: 'promoted',
      session: session || item.session,
      proposalId: item.id,
      note: '来自模型确认的提案',
    });
  };

  const dropProposal = (id, { reason = '' } = {}) => {
    let dropped = null;
    store.updatePending((items) => {
      const at = items.findIndex((entry) => entry.id === id || entry.fp === id);
      if (at === -1) return items;
      dropped = items[at];
      items.splice(at, 1);
      return items;
    });
    if (!dropped) return { ok: false, reason: `没有待定提案 ${id}` };
    store.appendLedger({ action: 'review.drop', proposalId: dropped.id, reason, statement: condense(dropped.statement, 200) });
    return { ok: true, dropped: { id: dropped.id, statement: dropped.statement } };
  };

  // -------------------------------------------------------------- decisions

  /**
   * Write or reinforce a rule. This is the ONE path that touches a skill file
   * for a lesson, and it is only reached with a statement the model chose.
   */
  const remember = ({ statement, kind = SIGNAL.TECHNIQUE, source = 'note', session = '', umbrella = null, proposalId = '', note = '' }) => {
    const text = condense(statement, 400);
    if (!text) return { ok: false, reason: '没有陈述' };
    if (kind && !DECLARABLE_KINDS.has(kind)) return { ok: false, reason: `kind 不可声明：${kind}` };
    const decidedUmbrella = umbrella || classifyRoute(kind, text);
    if (!decidedUmbrella || !UMBRELLAS[decidedUmbrella]) {
      return { ok: false, reason: `没有匹配的类级技能：kind=${kind}。只有 ${Object.keys(UMBRELLAS).join(' / ')} 三类长期存在，其余留在账本里。` };
    }
    const lesson = { statement: text, kind, umbrella: decidedUmbrella, source };
    const { checks, gate } = gatesFor(lesson, { checkNovel: false });
    if (!gate.ok || checks.some((check) => !check.ok)) {
      const reason = gateReasons(gate, checks);
      store.appendLedger({ action: 'review.refuse', umbrella: decidedUmbrella, kind, statement: condense(text, 200), reason, session, source });
      return { ok: false, reason, checks, refused: true };
    }

    // Dedup before writing: the same lesson learned twice is ONE rule, and a
    // paraphrase of an existing rule reinforces it instead of adding a twin.
    const duplicate = nearestRule(text, decidedUmbrella);
    if (duplicate && tokenSimilarity(text, duplicate.text) >= similarityThreshold) {
      store.appendLedger({
        action: 'review.reinforce',
        umbrella: duplicate.umbrella,
        ruleId: duplicate.id,
        statement: condense(text, 200),
        similarity: Math.round(tokenSimilarity(text, duplicate.text) * 100) / 100,
        session,
        source,
      });
      // Counted, not asserted. This reported a literal `hits: 2` — the same class
      // of lie as the constant-1 hit counter fixed in v0.2.0, just relocated to
      // the other side of the same decision: it said "twice" whether this was the
      // second time or the twentieth. The ledger is the record of how many times
      // a rule has been reinforced, and the row for THIS one was appended just
      // above, so a simple count is exact. It counts back only as far as the last
      // ledger rotation, which is why the number is reported as a floor.
      const hits = store.readLedger({ limit: 500 })
        .filter((row) => row.action === 'review.reinforce' && row.ruleId === duplicate.id).length;
      if (proposalId) dropProposal(proposalId, { reason: '已并入既有规则' });
      store.appendLesson({ umbrella: duplicate.umbrella, rule: duplicate.text, statement: text, reason: note, kind, session, source, action: 'reinforce', hits });
      store.rememberFingerprints([fingerprint(duplicate.text), fingerprint(text)]);
      return { ok: true, reinforced: true, umbrella: duplicate.umbrella, ruleId: duplicate.id, rule: duplicate.text, hits };
    }

    const budget = skills.exists(decidedUmbrella) ? skills.readRules(decidedUmbrella).length : 0;
    const overBudget = budget >= ruleBudget;
    const rules = ensureUmbrella(decidedUmbrella);
    const id = ruleId(text);
    const line = renderRule({ text, meta: { id, at: new Date().toISOString(), session, kind } });
    const body = buildSkillBody({
      title: UMBRELLAS[decidedUmbrella].title,
      description: UMBRELLAS[decidedUmbrella].description,
      rules: [...rules.map((rule) => rule.raw), line],
    });
    const written = writeUmbrella(decidedUmbrella, body, { session, source });
    if (!written.ok) return { ok: false, reason: (written.refused || []).join('；') || '写入失败' };

    if (proposalId) dropProposal(proposalId, { reason: '已提升为规则' });
    // The sidecar is what makes `novel` answerable without re-reading the ledger:
    // a rule that has been written is a fingerprint nobody needs to propose again.
    store.rememberFingerprints([fingerprint(text)]);
    store.appendLesson({ umbrella: decidedUmbrella, rule: text, statement: text, reason: note, kind, session, source, ruleId: id, action: 'create' });
    store.appendLedger({
      action: 'review.write',
      umbrella: decidedUmbrella,
      ruleId: id,
      kind,
      source,
      session,
      statement: condense(text, 200),
      budget,
      overBudget,
      reason: note || '',
    });
    if (onAction) {
      try {
        onAction({ action: 'learn', umbrella: decidedUmbrella, ruleId: id, kind });
      } catch {
        /* an observer must never break a write */
      }
    }
    return {
      ok: true,
      created: true,
      umbrella: decidedUmbrella,
      ruleId: id,
      rule: text,
      file: skills.fileFor(decidedUmbrella),
      budget,
      overBudget,
      ...(overBudget ? { warning: `${decidedUmbrella} 已有 ${budget} 条规则（软上限 ${ruleBudget}）。建议先 consolidate：同类规则该合并，否则这类技能会变成没人读的长清单。` } : {}),
    };
  };

  /** Ensure an umbrella skill exists with its own frontmatter. */
  /**
   * Adopt an umbrella that this plugin made with an older version.
   *
   * v0.1.0 had no ownership sidecar, so `durable-preferences` exists on disk with
   * no record of who wrote it — and the migration path refuses to move a skill it
   * cannot prove it made. Which is correct: a plugin must not relocate files it
   * did not author. So we prove it instead of assuming it, by comparing the
   * description against the template this plugin ships. A user who happened to
   * name their own skill `durable-preferences` would have written their own
   * description, and is left alone.
   */
  const claimExisting = (name) => {
    if (!managed || managed.isManaged(name)) return false;
    const spec = UMBRELLAS[name];
    if (!spec) return false;
    const skill = skills.read(name);
    if (!skill) return false;
    // `skills.read()` returns the parsed frontmatter under `meta`; the flat
    // `description` only exists on `skills.list()` rows. Reading the wrong one
    // here compared `''` against the template and silently refused every
    // adoption, which is how a plugin-authored umbrella stayed "external".
    const described = String(skill.meta?.description ?? skill.description ?? '').trim();
    if (described !== spec.description.trim()) return false;
    managed.claim(name, {
      adopted: true,
      kind: 'umbrella',
      source: 'adopted',
      rules: skills.readRules(name).length,
      file: skill.file,
    });
    return true;
  };

  const ensureUmbrella = (name) => {
    if (!skills.exists(name)) {
      const spec = UMBRELLAS[name];
      const body = buildSkillBody({ title: spec.title, description: spec.description, rules: [] });
      const written = skills.write(name, {
        description: spec.description,
        body,
        meta: { 'learn-when': spec.whenToUse },
      });
      if (!written.ok) return [];
      if (managed) managed.claim(name, { kind: 'umbrella', source: 'builtin', rules: 0, file: written.file });
      return [];
    }
    // It already exists — possibly from a version that kept no ownership record.
    claimExisting(name);
    return skills.readRules(name);
  };

  const writeUmbrella = (name, body, { session = '', source = '', dropRules = false } = {}) => {
    const written = skills.write(name, {
      description: UMBRELLAS[name].description,
      body,
      dropRules,
      meta: { 'learn-when': UMBRELLAS[name].whenToUse, ...(session ? { session } : {}) },
    });
    if (written.ok && managed) {
      managed.claim(name, { kind: 'umbrella', source: source || 'learn', rules: skills.readRules(name).length, file: written.file });
    }
    return written;
  };

  /**
   * Fold near-duplicate rules in one umbrella into the newest wording. Token
   * similarity is enough here — merging two phrasings of one preference is not
   * a judgement call that needs a model, and asking for one would make the
   * action unusable during an unattended curator pass.
   */
  const consolidate = ({ umbrella = null, dryRun = true, threshold = similarityThreshold, maxMerges = 20 } = {}) => {
    const targets = umbrella ? [umbrella] : Object.keys(UMBRELLAS);
    const report = [];
    for (const name of targets) {
      if (!skills.exists(name)) continue;
      const rules = skills.readRules(name).map((rule) => ({ ...parseRuleLine(rule.raw), id: rule.id }));
      const removed = new Set();
      const merges = [];
      for (let i = 0; i < rules.length && merges.length < maxMerges; i += 1) {
        if (removed.has(rules[i].id)) continue;
        for (let j = i + 1; j < rules.length; j += 1) {
          if (removed.has(rules[j].id)) continue;
          const score = tokenSimilarity(rules[i].text, rules[j].text);
          if (score < threshold) continue;
          // Keep the longer wording: it usually carries the qualifier that made
          // the rule useful, and dropping it loses the reason it was learned.
          const [keep, drop] = rules[i].text.length >= rules[j].text.length ? [rules[i], rules[j]] : [rules[j], rules[i]];
          removed.add(drop.id);
          merges.push({ umbrella: name, into: keep.id, dropped: drop.id, droppedText: drop.text, score: Math.round(score * 100) / 100 });
        }
      }
      if (!merges.length) {
        report.push({ umbrella: name, rules: rules.length, merges: [] });
        continue;
      }
      if (dryRun) {
        report.push({ umbrella: name, rules: rules.length, merges, dryRun: true });
        continue;
      }
      const kept = rules.filter((rule) => !removed.has(rule.id));
      const body = buildSkillBody({
        title: UMBRELLAS[name].title,
        description: UMBRELLAS[name].description,
        rules: kept.map((rule) => renderRule({ text: rule.text, meta: { id: rule.id, at: rule.at, session: rule.session, kind: kindFromLabel(rule.kindLabel) } })),
      });
      // Consolidation exists to make the rule list SHORTER, so the shrink guard
      // is told explicitly that the reduction is intended.
      const written = writeUmbrella(name, body, { source: 'consolidate', dropRules: true });
      if (!written.ok) {
        report.push({ umbrella: name, rules: rules.length, merges: [], error: (written.refused || []).join('；') });
        continue;
      }
      store.appendLedger({ action: 'review.consolidate', umbrella: name, kept: kept.length, dropped: removed.size, merges });
      report.push({ umbrella: name, rules: rules.length, after: kept.length, merges });
    }
    return { ok: true, dryRun, report };
  };

  /** What this plugin learned about one skill: rules, provenance, usage. */
  const historyOf = (name) => {
    const skillName = String(name || '');
    if (!skills.exists(skillName)) return { ok: false, reason: `技能不存在：${skillName}` };
    const rules = skills.readRules(skillName).map((rule) => ({ ...parseRuleLine(rule.raw), id: rule.id }));
    // Bounded on purpose. This read the whole ledger and then kept the last 40
    // matches, so a 857KB file was parsed in full to produce 40 rows — and it is
    // the call behind `learn action=history`, i.e. the one a user makes while
    // something looks wrong. 2000 rows back is far more than 40 matching events
    // for any single skill, and it is a constant instead of a growth curve.
    const events = store.readLedger({ limit: 2000 }).filter((entry) => {
      if (entry.umbrella !== skillName) return false;
      return ['review.write', 'review.reinforce', 'review.consolidate', 'review.undo', 'review.drop', 'review.refuse'].includes(entry.action);
    });
    const lessons = store.readLessons({ limit: 500 }).filter((lesson) => lesson.umbrella === skillName);
    const usageRecord = managed ? managed.usageOf(skillName) : { loads: 0, sessions: [] };
    return {
      ok: true,
      name: skillName,
      file: skills.fileFor(skillName),
      description: (skills.read(skillName) || {}).meta?.description || '',
      rules,
      usage: { loads: usageRecord.loads || 0, lastLoadAt: usageRecord.lastAt || '', sessions: (usageRecord.sessions || []).length },
      events: events.slice(-40).reverse(),
      lessons: lessons.slice(-20).reverse(),
      budget: { used: rules.length, limit: ruleBudget },
    };
  };

  /** Remove one rule, leaving the rest of the skill untouched. */
  const undoRule = (name, id, { reason = '' } = {}) => {
    const skillName = String(name || '');
    if (!skills.exists(skillName)) return { ok: false, reason: `技能不存在：${skillName}` };
    const result = skills.removeRule(skillName, id);
    if (!result.ok) return result;
    if (managed) managed.claim(skillName, { rules: skills.readRules(skillName).length });
    store.appendLedger({
      action: 'review.undo',
      umbrella: skillName,
      ruleId: id,
      statement: condense(result.removed.text, 200),
      remaining: result.remaining,
      reason: reason || '用户/模型要求撤回',
    });
    return { ok: true, umbrella: skillName, removed: result.removed, remaining: result.remaining };
  };

  /** The plain answer to "what did you learn this time?". */
  const summary = ({ session = '', limit = 10 } = {}) => {
    // `limit` argues for itself. The summary counts writes and shows the last few;
    // it does not need the beginning of time, and reading it should not get slower
    // every day the plugin runs.
    const ledger = store.readLedger({ limit: 1000 });
    const writes = ledger.filter((entry) => entry.action === 'review.write' && (!session || entry.session === session));
    const proposals = store.loadPending();
    const usage = curator ? curator.usage() : {};
    const perUmbrella = {};
    for (const name of Object.keys(UMBRELLAS)) {
      if (!skills.exists(name)) continue;
      perUmbrella[name] = {
        rules: skills.readRules(name).length,
        loads: (usage[name] && usage[name].loads) || 0,
        protected: true,
      };
    }
    const archived = ledger.filter((entry) => entry.action === 'curator.run').slice(-1)[0] || null;
    return {
      ok: true,
      learned: writes.slice(-limit).reverse().map((entry) => ({
        at: entry.at,
        umbrella: entry.umbrella,
        ruleId: entry.ruleId,
        statement: entry.statement,
        session: entry.session || '',
        source: entry.source || '',
      })),
      totalRules: writes.length,
      pending: proposals.length,
      pendingReady: proposals.filter((item) => item.ok).length,
      umbrellas: perUmbrella,
      lastCurator: archived ? { at: archived.at, reason: archived.reason || '', moved: (archived.moved || []).length } : null,
      files: Object.keys(perUmbrella).map((name) => skills.fileFor(name)),
    };
  };

  /** Honest check of whether the plugin is wired into the host correctly. */
  const doctor = ({ skillsRoot = null, learnedDir = null, customRoots = [], live = false, activeRoot = null, hostHooks = null } = {}) => {
    const issues = [];
    const checks = [];
    const add = (id, ok, detail) => {
      checks.push({ id, ok, detail });
      if (!ok) issues.push(detail);
    };
    const roots = skills.list();
    add('root', true, `技能写入位置：${activeRoot || skills.activeRoot()}${live ? '（专用目录已生效）' : `（专用目录还没被技能目录覆盖，专用目标 ${skills.learnedDir}）`}`);
    add('skills', roots.length > 0, roots.length ? `可见技能 ${roots.length} 个：${roots.map((entry) => entry.name).join(', ')}` : '技能根里没有技能');
    const hostSeesRoot = customRoots.some((root) => String(root).replace(/[\\/]+$/, '').toLowerCase() === String(skills.learnedDir).replace(/[\\/]+$/, '').toLowerCase());
    add(
      'host-root',
      // A patched profile is not the same thing as a host that can see the
      // folder: the loader reads skill roots at startup, so only the live probe
      // (a throwaway skill reported back by the host's own catalog) counts.
      live,
      live
        ? `宿主已把 ${skills.learnedDir} 编入原生技能目录（探测通过）`
        : hostSeesRoot
          ? `本插件已注册技能提供者（${skills.learnedDir}），但宿主技能目录里还没看到探针技能：重启 DSH 后再跑一次自检。`
          : `宿主还不知道 ${skills.learnedDir}：技能文件在，但不会出现在原生技能目录里，也不会被 /名字 加载。这个根由本插件在激活时用 ctx.skills.registerProvider() 自注册——先重启 DSH；重启后仍然如此，说明宿主的 skills 服务没有就绪。`,
    );
    const stranded = skills.list({ includeLegacy: true }).filter((entry) => entry.legacy);
    // A skill the user wrote by hand belongs in the shared root and will never be
    // moved, so its presence there is not a fault to report. Only our own
    // leftovers are — otherwise the self-check stays red forever and stops
    // meaning anything.
    const legacy = stranded.filter(
      (entry) => managed?.isManaged?.(entry.name) === true || managed?.BUILTIN_PROTECTED?.includes(entry.name) === true,
    );
    add(
      'legacy',
      legacy.length === 0,
      legacy.length
        ? `还有 ${legacy.length} 个本插件自己的技能留在共享根（<dshHome>/skills）：${legacy.map((entry) => entry.name).join(', ')}。专用目录生效后 learn action=organize 会把它们收拢过去；手工写的技能不动。`
        : stranded.length
          ? `共享根里还有 ${stranded.length} 个技能（${stranded.map((entry) => entry.name).join(', ')}），不是本插件创建的，位置由你说了算，不动`
          : '没有遗留技能',
    );
    for (const name of Object.keys(UMBRELLAS)) {
      if (!skills.exists(name)) continue;
      const count = skills.readRules(name).length;
      add(`budget:${name}`, count <= ruleBudget, count > ruleBudget ? `${name} 有 ${count} 条规则，超过软上限 ${ruleBudget}，建议 consolidate` : `${name}：${count} 条规则`);
    }
    if (managed) {
      const tracked = managed.names();
      const missing = tracked.filter((name) => !skills.exists(name));
      add('sidecar', missing.length === 0, missing.length ? `managed.json 记录了不存在的技能：${missing.join(', ')}（可能是手工删除）` : `managed.json 跟踪 ${tracked.length} 个技能：${tracked.join(', ') || '（空）'}`);
    }
    // The host extension points are reported, not asserted — with ONE exception.
    // The prompt sections are advisory: a build whose `systemPrompt` service is
    // missing still works, it just cannot be told the criteria. But `tools.guard`
    // is what makes the discipline section's own sentence true — 「技能是唯一被校
    // 验的写入口」. Without the guard that sentence is a claim the plugin cannot
    // back, and the model can `edit` a SKILL.md straight past every check and the
    // ledger. So the guard is load-bearing and the sections are not.
    if (hostHooks !== null) {
      const applied = Array.isArray(hostHooks?.applied) ? hostHooks.applied : [];
      const guarded = applied.includes('tools.guard');
      add(
        'host-hooks',
        guarded,
        applied.length
          ? `宿主扩展点已挂上 ${applied.length} 个：${applied.join('、')}${guarded ? '' : '——但 tools.guard 不在其中，「技能只能经 learn_skill_manage 修改」这句话就只是提示词里的说法，拦不住直接 write / edit'}`
          : `宿主扩展点一个都没挂上${hostHooks?.reason ? `：${hostHooks.reason}` : ''}——判断标准没进提示词，技能文件也拦不住直接编辑`,
      );
    }
    return { ok: issues.length === 0, checks, issues };
  };

  return {
    UMBRELLAS,
    /** The limits actually in force, so callers report them instead of guessing. */
    limits: { ruleBudget, similarity: similarityThreshold, maxProposals: maxProposalsPerRun },
    gatesFor,
    gateReasons,
    allRules,
    nearestRule,
    knownFingerprints,
    propose,
    runReview,
    promoteProposal,
    dropProposal,
    remember,
    consolidate,
    historyOf,
    undoRule,
    summary,
    doctor,
    ensureUmbrella,
    claimExisting,
    claimUnowned: () => Object.keys(UMBRELLAS).filter((name) => claimExisting(name)),
  };
}
