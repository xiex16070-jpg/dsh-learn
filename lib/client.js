/**
 * The browser half of dsh-learn — a quiet, colored recap under the turn that earned it.
 *
 * WHY THIS FILE EXISTS
 *
 * The learning loop already runs headless in `lib/review.js`: it watches the session
 * event feed and files candidates without spending a single extra model call. But a loop
 * you cannot see is a loop you do not trust — you cannot tell a quiet turn from a broken
 * plugin. So this module reads the SAME two events the host already delivers to the
 * browser and prints what the turn actually did to the skill library.
 *
 * Three rules shape everything below.
 *
 * It invents nothing. An entry exists only once a `tool/result` came back for its
 * `tool/call`, and a call that reported `isError` is printed as failed. A recap that
 * showed success for a failed write would be worse than no recap at all: it is exactly
 * the surface the user is asked to trust.
 *
 * It adds no work. No model calls, no session events, no HTTP, no host-side changes —
 * the fold is a pure function of events the browser already has, and a turn that
 * learned nothing publishes nothing.
 *
 * It is a footnote, not a card. The assistant message owns the turn; this is one line
 * of small type in its shadow, not a panel competing with it.
 *
 * The host loads this file through `window.__ModuleLoader__`, so there is no bundler,
 * no build step, and no top-level `import`/`export` — only `react/jsx-runtime`, which
 * is the one dependency the frame hands us.
 *
 * CONTRACTS COPIED FROM, NOT GUESSED AT
 *
 * `@deepseek-ai/dsh-client-ui-deliverables/lib/client.js` occupies the same seat and
 * folds the same two events, so its shapes are the reference here: the no-build frame
 * at `:1-10`, the Conversation Definition with neither `target` nor `buildViewNode` at
 * `:1155-1242`, and the `conversation.chat.turnTail` registration at `:2265-2290`.
 *
 * The two asymmetries below are the host's, and are copied deliberately:
 *   `tool/call` carries its identity at `event.data.callId`, but `tool/result` carries
 *   it at `event.data.message.source.callId` (`…dsh-client-ui-deliverables/lib/client.js:1211`
 *   against `:1219`).
 *   The registry already wraps `events.register` in its own `ctx.effect`
 *   (`…dsh-client-ui-conversation/lib/client.js:2623-2633`), so this file's extra wrap is
 *   belt-and-braces — and is what the sibling seat plugin does
 *   (`…dsh-client-ui-plan/lib/client.js:628`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-learn',
  factory: (require) => {
    const { jsx, jsxs } = require('react/jsx-runtime');

    /** Locale namespace; also the slot id, so the seat and its copy share one name. */
    const NS = 'dsh-learn';

    /**
     * The Conversation Definition kind. Three contracts pin this string to itself: it keys
     * the context, it is the `key` the registry validates on published Location data
     * (`…dsh-client-ui-conversation/lib/client.js:2511-2519`), and it is the `turn.data` key
     * the component reads.
     */
    const KIND = 'learn-recap';

    /** The seat every completed turn renders; shared with the deliverables and plan plugins. */
    const SEAT = 'conversation.chat.turnTail';

    /**
     * Tones, resolved to alias tokens that exist in both the light and the dark theme.
     * `success` is for a write that landed, `warn` for one that removes something the user
     * may still want, `idle` for a run that only looked, `error` for a call that failed.
     */
    const TONE_COLOR = {
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    /**
     * `learn_skill_manage` actions, by the action the model asked for.
     * `read` is absent on purpose: reading a skill changes no file, and a recap of what
     * the turn did to the library should not log that the model looked something up.
     * `named` marks the entries whose sentence needs the skill's name to be true.
     */
    const SKILL_MANAGE = {
      create: { key: 'skill.create', tone: 'success', named: true },
      update: { key: 'skill.update', tone: 'success', named: true },
      delete: { key: 'skill.delete', tone: 'warn', named: true },
      archive: { key: 'skill.archive', tone: 'warn', named: true },
    };

    /**
     * The `kind` of a `learn action=note` call, normalized (lowercased, underscores folded
     * to hyphens) so both `remember-request` and `REMEMBER_REQUEST` land on the same entry.
     * The kind is the honest part of the sentence: the plugin records HOW the lesson was
     * earned, and flattening them all to "learned something" would throw that away.
     */
    const NOTE_KIND = {
      'remember-request': 'note.remember-request',
      'user-correction': 'note.user-correction',
      'user-preference': 'note.user-preference',
      'durable-fact': 'note.durable-fact',
      technique: 'note.technique',
      'recovered-failure': 'note.recovered-failure',
      'skill-wrong': 'note.skill-wrong',
    };

    /** A note the model did not label still wrote a rule; say so without inventing a reason. */
    const NOTE_PLAIN = 'note.plain';

    /**
     * The remaining `learn` actions that change something. Every pure read is absent for the
     * same reason `read` is absent above: `status`, `list`, `view`, `pending`, `history`,
     * `doctor` and `graph` leave the library exactly as they found it.
     */
    const LEARN_ACTION = {
      undo: { key: 'learn.undo', tone: 'warn' },
      consolidate: { key: 'learn.consolidate', tone: 'success' },
      organize: { key: 'learn.organize', tone: 'success' },
      pin: { key: 'learn.pin', tone: 'success', named: true },
      archive: { key: 'learn.archive', tone: 'warn', named: true },
      'restore-pending': { key: 'learn.restore', tone: 'success' },
    };

    /** `learn_review` proposes and never writes, hence the idle tone. */
    const REVIEW_ACTION = {
      run: { key: 'review.run', tone: 'idle' },
      'dry-run': { key: 'review.dry-run', tone: 'idle' },
    };

    /** `learn_curator` moves files between folders; it never authors or destroys a lesson. */
    const CURATOR_ACTION = {
      run: { key: 'curator.run', tone: 'idle' },
      pause: { key: 'curator.pause', tone: 'idle' },
      resume: { key: 'curator.resume', tone: 'idle' },
    };

    /** Frozen so an empty turn always hands back the SAME array and never churns the renderer. */
    const NOTHING = Object.freeze([]);

    /** @returns true for a plain object — the only shape a tool's arguments may be read from. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Read the model's tool arguments. The host hands over whatever the model emitted, and a
     * malformed payload must cost the entry its detail, never the whole recap — so the parse
     * failure returns `undefined` instead of throwing.
     * @param raw - the `arguments` field of a `tool/call`.
     * @returns the parsed record, or `undefined` when there is nothing usable to read.
     */
    function parseArgs(raw) {
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return isRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      return isRecord(raw) ? raw : undefined;
    }

    /**
     * Turn one verb spec into the entry it earns.
     * @param spec - a row of one of the tables above, or `undefined` for an action we do not report.
     * @param skill - the `name` argument, when the sentence needs it.
     * @returns an entry, or `null` when this call changed nothing and deserves no line.
     */
    function verb(spec, skill) {
      if (spec === undefined) return null;
      return { key: spec.key, tone: spec.tone, name: spec.named === true ? skill : '' };
    }

    /**
     * Translate one tool invocation into the entry it earns.
     * @param name - the tool the model called.
     * @param args - its parsed arguments, or `undefined` when the JSON did not parse.
     * @returns `{ key, tone, name }`, or `null` for a call this recap does not report.
     */
    function describeCall(name, args) {
      const action = typeof args?.action === 'string' ? args.action : '';
      const skill = typeof args?.name === 'string' ? args.name : '';
      if (name === 'learn_skill_manage') {
        // `delete` archives unless the model passed `confirm: true` — the recap has the
        // arguments, so it says which of the two actually happened instead of printing
        // "unrecoverable" over a copy that is still on disk.
        if (action === 'delete' && args?.confirm !== true) return { key: 'skill.delete.recoverable', tone: 'warn', name: skill };
        return verb(SKILL_MANAGE[action], skill);
      }
      if (name === 'learn_review') return verb(REVIEW_ACTION[action]);
      if (name === 'learn_curator') return verb(CURATOR_ACTION[action]);
      if (name !== 'learn') return null;
      if (action === 'note') {
        const kind = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase().replace(/_/g, '-') : '';
        return { key: NOTE_KIND[kind] ?? NOTE_PLAIN, tone: 'success', name: '' };
      }
      return verb(LEARN_ACTION[action], skill);
    }

    /** `tool/result` carries the call identity at `message.source.callId`. */
    function resultCallId(event) {
      const source = event.data?.message?.source;
      return isRecord(source) && typeof source.callId === 'string' ? source.callId : '';
    }

    /** `tool/result` marks a failed call at `message.isError`. */
    function isFailedResult(event) {
      return event.data?.message?.isError === true;
    }

    /**
     * The first characters of the text a `tool/result` carried, or `''`.
     *
     * Read only when a call already earned a line, and never parsed beyond this one question:
     * the recap reports what the turn did, and the only thing it needs from the result is
     * whether the library actually changed.
     */
    function resultText(event) {
      const content = event.data?.message?.content;
      if (Array.isArray(content) && isRecord(content[0]) && typeof content[0].text === 'string') return content[0].text;
      const text = event.data?.message?.text;
      return typeof text === 'string' ? text : '';
    }

    /**
     * A gate refusal is ordinary text, not an error.
     *
     * This is measured, not assumed: the session log shows `isError=false` on a refused
     * `learn action=note` AND on a successful one, so the host does not mark the difference.
     * `lib/tools.js` writes `未写入：<reason>` for a refusal and `已写入 …` for a write, and
     * this file reads that marker so a refusal is never printed as a green "记住一条做法"
     * line — the recap is the user's only view of what the library gained, and being
     * optimistic in exactly the case that failed is the one lie it must not tell.
     *
     * `scripts/client-check.mjs` asserts this constant still matches the literal
     * `lib/tools.js` writes, so the two cannot drift apart without a red test.
     */
    const REFUSED_PREFIX = '未写入';

    /** @returns true when the call was refused by a gate rather than answered by a write. */
    function isRefusedResult(event) {
      return resultText(event).trimStart().startsWith(REFUSED_PREFIX);
    }

    /**
     * Remember a `tool/call` so its result can be joined back to it later in the turn.
     *
     * A call this recap does not report is dropped here rather than at the result, so an
     * unreported result costs nothing at all.
     */
    function recordCall(state, event) {
      const entry = describeCall(event.data?.name, parseArgs(event.data?.arguments));
      if (entry === null) return state;
      const pending = new Map(state.pending);
      pending.set(String(event.data?.callId), entry);
      return { ...state, pending };
    }

    /**
     * Fold a `tool/result` into the turn's entries.
     *
     * A result with no recorded call is ignored: it belongs to a tool this recap does not
     * report, or to a call whose `tool/call` fell outside the window the browser has loaded.
     *
     * Repetition collapses — a model that retries a failed `update` should not print two
     * identical lines — but only within the same OUTCOME. There are three, and they are
     * three facts: the write landed (`ok`), the host reported the call failed (`error`),
     * and a gate refused it (`refused`, which arrives as ordinary text — see
     * `isRefusedResult`). A refused write followed by a successful one is two facts, and
     * hiding the refusal would be the one lie this file exists to prevent.
     */
    function recordResult(state, event) {
      const callId = resultCallId(event);
      const entry = callId === '' ? undefined : state.pending.get(callId);
      if (entry === undefined) return state;
      const outcome = isFailedResult(event) ? 'error' : (isRefusedResult(event) ? 'refused' : 'ok');
      const id = `${entry.key}\u0000${entry.name}\u0000${outcome}`;
      const at = state.seen.get(id);
      const entries = state.entries.slice();
      if (at === undefined) {
        const tone = outcome === 'error' ? 'error' : (outcome === 'refused' ? 'warn' : entry.tone);
        entries.push({ id, key: entry.key, tone, name: entry.name, failed: outcome !== 'ok', count: 1 });
      } else entries[at] = { ...entries[at], count: entries[at].count + 1 };
      const seen = new Map(state.seen);
      if (at === undefined) seen.set(id, entries.length - 1);
      return { ...state, entries, seen };
    }

    /**
     * Fold one matched event into the turn state.
     *
     * The registry calls `update` only after `start` has produced a state, and it throws if
     * either returns `undefined` (`…dsh-client-ui-conversation/lib/client.js:2580-2583`) — so
     * every branch returns a state object, and the branches that changed nothing return the
     * SAME one, which is also what keeps the published value reference-stable.
     */
    function foldEvent(state, event) {
      if (event.type === 'tool/call') return recordCall(state, event);
      if (event.type === 'tool/result') return recordResult(state, event);
      return state;
    }

    /**
     * The turn fold: one context per turn, one entry per change the turn actually made.
     *
     * It declares neither `target` nor `buildViewNode`, because it contributes Location data
     * and no view node — the registry throws when a definition declares exactly one of them
     * (`…dsh-client-ui-conversation/lib/client.js:2688-2690`).
     */
    const recapDefinition = {
      kind: KIND,

      /**
       * @param event - one session event.
       * @returns the context key and the role, or `null` to leave the event alone.
       */
      match: (event) => {
        const turn = event.data?.turn;
        if (typeof turn !== 'number') return null;
        if (event.type === 'turn/start') return { id: String(turn), role: 'start' };
        if (event.type === 'tool/call' || event.type === 'tool/result') return { id: String(turn), role: 'update' };
        return null;
      },

      /** @returns the starting state: nothing learned yet, and every call still unanswered. */
      start: (_context, match) => ({
        turn: match.event.data.turn,
        pending: new Map(),
        entries: NOTHING,
        seen: new Map(),
      }),

      /** @returns the folded state, never `undefined`. */
      update: (context, match) => foldEvent(context.state, match.event),

      /**
       * Publish the entries for the renderer to read off `turn.data`.
       *
       * The unchanged case returns the `previous` object itself, because the engine skips
       * publication on reference equality (`…dsh-client-ui-conversation/lib/client.js:2542`)
       * while the published object is otherwise re-validated and re-rendered on every fold.
       *
       * @param context - the snapshot the registry builds: `{ key, kind, id, matches, start, state, current }`.
       * @param scope - `step` or `turn`; this recap only exists per turn.
       * @param previous - the object published for this scope last time, or `null`.
       * @returns the Location data, or `null` when there is nothing to show.
       */
      buildLocationData: (context, scope, previous) => {
        if (scope !== 'turn' || context.state === undefined) return null;
        const entries = context.state.entries;
        if (previous != null && previous.key === KIND && previous.turn === context.state.turn && previous.value.entries === entries) return previous;
        return { kind: 'turn', turn: context.state.turn, key: KIND, value: { entries } };
      },
    };

    /** Quiet footnote: no border, no fill, nothing that competes with the message above it. */
    const ROOT_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      columnGap: '6px',
      rowGap: '2px',
      marginTop: '6px',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    };

    /** The leading word, in the brand color, so the line is identifiable at a glance. */
    const LABEL_STYLE = { flex: 'none', fontWeight: 500, color: 'var(--dsw-alias-brand-primary)' };

    /** The separator is punctuation, not content: it stays in the muted color. */
    const SEPARATOR_STYLE = { flex: 'none', color: 'var(--dsw-alias-label-secondary)' };

    /**
     * The recap line for one completed turn.
     *
     * It reads nothing but `turn.data`, so it needs no hooks and costs nothing on the turns
     * that learned nothing. The `title` repeats the untruncated sentence, because a long
     * skill name in a one-line footnote will otherwise be ellipsized away.
     *
     * @param props - the tail owner's props plus the localized copy bound to this seat.
     * @returns the recap, or `null` when the turn left the library alone.
     */
    function LearnRecapTail({ turn, t }) {
      const entries = turn?.data?.get?.(KIND)?.entries;
      if (entries === undefined || entries.length === 0) return null;
      const children = [jsx('span', { style: LABEL_STYLE, children: t('label') }, 'label')];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const named = entry.name === '' ? t('name.unknown') : entry.name;
        let text = t(entry.failed === true ? `${entry.key}.failed` : entry.key, { name: named });
        if (entry.count > 1) text += ` ×${entry.count}`;
        children.push(jsx('span', { style: SEPARATOR_STYLE, 'aria-hidden': 'true', children: '·' }, `sep:${index}`));
        children.push(jsx('span', { style: { color: TONE_COLOR[entry.tone] }, title: text, children: text }, `entry:${index}`));
      }
      return jsxs('div', { 'data-dsh-learn-recap': 'true', style: ROOT_STYLE, children });
    }

    const zh = {
      label: '学习',
      'name.unknown': '未命名',
      'skill.create': "技能 '{name}' 已创建",
      'skill.create.failed': "技能 '{name}' 创建失败",
      'skill.update': "技能 '{name}' 已修补",
      'skill.update.failed': "技能 '{name}' 修补失败",
      'skill.delete': "技能 '{name}' 已永久删除（归档副本也没了）",
      'skill.delete.failed': "技能 '{name}' 删除失败",
      'skill.delete.recoverable': "技能 '{name}' 已删除（归档里还留着一份，能移回来）",
      // Both delete paths failing means the same thing, so they say the same thing —
      // the English pair already did.
      'skill.delete.recoverable.failed': "技能 '{name}' 删除失败",
      'skill.archive': "技能 '{name}' 已归档",
      'skill.archive.failed': "技能 '{name}' 归档失败",
      // One sentence per kind, and the outcome word is the only thing that changes —
      // the shape the harness itself uses for tool activity (`已加载技能` / `技能加载失败`,
      // `apps/desktop/src/i18n/zh.ts:4947-4956`). The 0.3.3 copy put an imperative
      // (`记住一条…`) beside a report (`…没能记下`) in the same line, so a turn that both
      // saved and refused a note read as 「记住又不记住」.
      'note.remember-request': '已记下一条用户要求',
      'note.remember-request.failed': '没能记下这条用户要求',
      'note.user-correction': '已记下一条用户纠正',
      'note.user-correction.failed': '没能记下这条用户纠正',
      'note.user-preference': '已记下一条用户偏好',
      'note.user-preference.failed': '没能记下这条用户偏好',
      'note.durable-fact': '已记下一条环境事实',
      'note.durable-fact.failed': '没能记下这条环境事实',
      'note.technique': '已记下一条做法',
      'note.technique.failed': '没能记下这条做法',
      'note.recovered-failure': '已记下一条排障做法',
      'note.recovered-failure.failed': '没能记下这条排障做法',
      'note.skill-wrong': '已记下一条技能纠错',
      'note.skill-wrong.failed': '没能记下这条技能纠错',
      'note.plain': '已记下一条',
      'note.plain.failed': '没能记下这一条',
      'learn.undo': '已撤回一条规则',
      'learn.undo.failed': '没能撤回这条规则',
      'learn.consolidate': '已整合一类规则',
      'learn.consolidate.failed': '没能整合这类规则',
      'learn.organize': '已收拢遗留技能',
      'learn.organize.failed': '没能收拢遗留技能',
      'learn.pin': "技能 '{name}' 已置顶",
      'learn.pin.failed': "技能 '{name}' 置顶失败",
      'learn.archive': "技能 '{name}' 已归档",
      'learn.archive.failed': "技能 '{name}' 归档失败",
      'learn.restore': '候选已提升',
      'learn.restore.failed': '候选提升失败',
      'review.run': '已跑一次自动审查（只提案，不写文件）',
      'review.run.failed': '自动审查没能跑完',
      'review.dry-run': '已跑一次审查预演',
      'review.dry-run.failed': '审查预演没能跑完',
      'curator.run': '已跑一次闲置维护',
      'curator.run.failed': '闲置维护没能跑完',
      'curator.pause': '闲置维护已暂停',
      'curator.pause.failed': '闲置维护没能暂停',
      'curator.resume': '闲置维护已恢复',
      'curator.resume.failed': '闲置维护没能恢复',
    };

    const en = {
      label: 'learn',
      'name.unknown': 'unnamed',
      'skill.create': "skill '{name}' created",
      'skill.create.failed': "could not create skill '{name}'",
      'skill.update': "skill '{name}' patched",
      'skill.update.failed': "could not patch skill '{name}'",
      'skill.delete': "skill '{name}' deleted for good",
      'skill.delete.failed': "could not delete skill '{name}'",
      'skill.delete.recoverable': "skill '{name}' deleted (a copy stays in the archive)",
      'skill.delete.recoverable.failed': "could not delete skill '{name}'",
      'skill.archive': "skill '{name}' archived",
      'skill.archive.failed': "could not archive skill '{name}'",
      'note.remember-request': 'saved a standing request',
      'note.remember-request.failed': 'could not save the standing request',
      'note.user-correction': 'saved a correction',
      'note.user-correction.failed': 'could not save the correction',
      'note.user-preference': 'saved a preference',
      'note.user-preference.failed': 'could not save the preference',
      'note.durable-fact': 'saved an environment fact',
      'note.durable-fact.failed': 'could not save the environment fact',
      'note.technique': 'saved a technique',
      'note.technique.failed': 'could not save the technique',
      'note.recovered-failure': 'saved a recovery',
      'note.recovered-failure.failed': 'could not save the recovery',
      'note.skill-wrong': 'saved a skill correction',
      'note.skill-wrong.failed': 'could not save the skill correction',
      'note.plain': 'saved a rule',
      'note.plain.failed': 'could not save the rule',
      'learn.undo': 'withdrew a rule',
      'learn.undo.failed': 'could not withdraw the rule',
      'learn.consolidate': 'merged a class of rules',
      'learn.consolidate.failed': 'could not merge the rules',
      'learn.organize': 'gathered the legacy skills',
      'learn.organize.failed': 'could not gather the legacy skills',
      'learn.pin': "pinned skill '{name}'",
      'learn.pin.failed': "could not pin skill '{name}'",
      'learn.archive': "archived skill '{name}'",
      'learn.archive.failed': "could not archive skill '{name}'",
      'learn.restore': 'promoted a candidate',
      'learn.restore.failed': 'could not promote the candidate',
      'review.run': 'ran a review (proposals only)',
      'review.run.failed': 'the review failed',
      'review.dry-run': 'ran a review dry run',
      'review.dry-run.failed': 'the review dry run failed',
      'curator.run': 'ran idle housekeeping',
      'curator.run.failed': 'idle housekeeping failed',
      'curator.pause': 'paused idle housekeeping',
      'curator.pause.failed': 'could not pause idle housekeeping',
      'curator.resume': 'resumed idle housekeeping',
      'curator.resume.failed': 'could not resume idle housekeeping',
    };

    /** Services this plugin needs: the seat, the dictionaries, and the event feed to fold. */
    const inject = ['slots', 'locale', 'uiConversation'];

    /**
     * Bind the copy, register the fold, and take the seat.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-learn: dictionaries');
      // The registry already scopes a registered Definition to the plugin lifetime
      // (`…dsh-client-ui-conversation/lib/client.js:2623-2633`); this wrap only makes the
      // disposal explicit here, and matches what the sibling seat plugin does.
      ctx.effect(() => ctx.uiConversation.events.register(recapDefinition), 'dsh-learn: conversation definition');
      // `order` IS a recognized descriptor field: the shipped Client template passes it
      // (`cordis-plugin-development/templates/decoration/client.js:16-18` →
      // `ctx.slots.register({ name: 'conversation.composer.dock', id: 'my-decoration', order: 5 }, …)`).
      // A high order puts the recap after whatever else tails the turn, so it reads as the
      // last word on the turn rather than interrupting another plugin's footer.
      ctx.slots.inject(SEAT, () => ctx.slots.register({ name: SEAT, id: NS, order: 500, locale: NS }, LearnRecapTail));
    }

    return { apply, inject, name: NS };
  },
});
