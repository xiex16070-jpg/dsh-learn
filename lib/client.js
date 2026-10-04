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
      return { key: spec.key, tone: spec.tone, name: spec.named === true ? skill : '', target: '', detail: '' };
    }

    /**
     * Translate one tool invocation into the entry it earns.
     * @param name - the tool the model called.
     * @param args - its parsed arguments, or `undefined` when the JSON did not parse.
     * @returns `{ key, tone, name, target, detail }`, or `null` for a call this recap does not report.
     */
    function describeCall(name, args) {
      const action = typeof args?.action === 'string' ? args.action : '';
      const skill = typeof args?.name === 'string' ? args.name : '';
      if (name === 'learn_skill_manage') {
        // `delete` archives unless the model passed `confirm: true` — the recap has the
        // arguments, so it says which of the two actually happened instead of printing
        // "unrecoverable" over a copy that is still on disk.
        if (action === 'delete' && args?.confirm !== true) return { key: 'skill.delete.recoverable', tone: 'warn', name: skill, target: '', detail: '' };
        return verb(SKILL_MANAGE[action], skill);
      }
      if (name === 'learn_review') return verb(REVIEW_ACTION[action]);
      if (name === 'learn_curator') return verb(CURATOR_ACTION[action]);
      if (name !== 'learn') return null;
      if (action === 'note') {
        const kind = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase().replace(/_/g, '-') : '';
        // `target` and `detail` only become certain when the result arrives — the host picks
        // the skill and may condense the wording — so this is the provisional pair that
        // `parseNoteOutcome` is allowed to overwrite.
        const statement = typeof args?.statement === 'string' ? args.statement : (typeof args?.text === 'string' ? args.text : '');
        return {
          key: NOTE_KIND[kind] ?? NOTE_PLAIN,
          tone: 'success',
          name: '',
          target: typeof args?.umbrella === 'string' ? args.umbrella.trim() : '',
          detail: statement.trim(),
        };
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

    /** @returns true when this text is a gate refusal rather than the answer to a write. */
    function isRefusedText(text) {
      return String(text).trimStart().startsWith(REFUSED_PREFIX);
    }

    /** @returns true when the call was refused by a gate rather than answered by a write. */
    function isRefusedResult(event) {
      return isRefusedText(resultText(event));
    }

    /**
     * The text a `tool/ptc-dispatch` carried, or `''`.
     *
     * The `ptc` agent preset runs every tool from inside `run_code`, so a dispatched tool gets
     * no `tool/call` of its own and no separate `tool/result`: the dispatch event carries the
     * call AND its answer together, under `data.name` / `data.arguments` / `data.isError` /
     * `data.content`. Measured on the live `--D-Download-youtube-ambilight-2.38.17--` session:
     * 471 `tool/call` events, every one of them `run_code`, and 939 `tool/ptc-dispatch` of
     * which 33 were `learn` — 16 of those wrote a rule. Reading only `tool/call` is why the
     * recap stayed empty in that workspace while the library was actually growing.
     */
    function dispatchText(event) {
      const content = event.data?.content;
      if (Array.isArray(content) && isRecord(content[0]) && typeof content[0].text === 'string') return content[0].text;
      const text = event.data?.text;
      return typeof text === 'string' ? text : '';
    }

    /**
     * Read the destination skill and the text back out of the sentence `lib/tools.js` printed.
     *
     * The recap does not re-derive where a lesson went. The host picks the destination skill
     * (or is given one) and may condense the wording before writing it, so the only honest
     * source is the answer the host already gave:
     *
     *   `已写入 <skill> 的规则 <id>：<rule>`   — a new rule landed  (`lib/tools.js:444`)
     *   `已并入既有规则（<skill> / <id>）：<rule>` — the same rule again (`lib/tools.js:441`)
     *   `未写入：<reason>`                    — a gate refused it   (`lib/tools.js:438`)
     *
     * Reading this is what lets the footnote answer "into which skill, and saying what"
     * instead of only "a note was filed".
     *
     * Only the first line of each form is read on purpose: `lib/tools.js` appends
     * `文件 <path>`, a warning, or `门槛明细：…` on the lines below, and none of that belongs
     * in a one-line footnote.
     *
     * `scripts/client-check.mjs` pins these patterns against the literals in `lib/tools.js`.
     *
     * @param text - the text of a `tool/result`.
     * @returns `{ wrote, target, detail, code }` — `wrote` is false unless the sentence was
     *   one of the two success forms, and either string field is `''` when there was nothing
     *   to read. `code` is the machine-readable half of a refusal, taken from the
     *   `门槛明细：` line, and `''` when the sentence carried none.
     */
    function parseNoteOutcome(text) {
      const head = String(text).trimStart();
      const wrote = /^已写入\s+(\S+)\s+的规则\s+(\S+)：([^\n]*)/.exec(head);
      if (wrote !== null) return { wrote: true, target: wrote[1], detail: wrote[3], code: '' };
      const merged = /^已并入既有规则（([^）]+?)）：([^\n]*)/.exec(head);
      if (merged !== null) return { wrote: true, target: merged[1].split('/')[0].trim(), detail: merged[2], code: '' };
      const refused = /^未写入：([^\n]*)/.exec(head);
      if (refused !== null) {
        return { wrote: false, target: '', detail: refused[1], code: refusalCode(head) };
      }
      return { wrote: false, target: '', detail: '', code: '' };
    }

    /**
     * Pull the first failing code out of the `门槛明细：` line.
     *
     * The refusal SENTENCE is written for the model — it has to explain how to pass, so it
     * runs to about ninety characters. The footnote is forty. Rendering the sentence meant
     * every refusal arrived cut in the middle of a word (`…超过 200…`). `lib/tools.js` now
     * puts the code on that line instead of the reason, and the code is exactly the width of
     * a glance. The full sentence is still on the first line, and still in the tooltip.
     *
     * @param head - the whole result text, already trimmed.
     */
    function refusalCode(head) {
      const line = /^门槛明细：([^\n]*)/m.exec(head);
      if (line === null) return '';
      for (const pair of line[1].split('；')) {
        const at = pair.indexOf('=');
        if (at === -1) continue;
        const value = pair.slice(at + 1).trim();
        if (value !== '' && value !== 'ok') return value;
      }
      return '';
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
     *
     * For a note the identity includes the destination and the text as well, so three
     * different rules written in one turn stay three lines: they are three things the
     * library now says, and collapsing them would hide exactly what the line is for.
     */
    function recordResult(state, event) {
      const callId = resultCallId(event);
      const entry = callId === '' ? undefined : state.pending.get(callId);
      if (entry === undefined) return state;
      return recordOutcome(state, entry, isFailedResult(event), resultText(event));
    }

    /**
     * Fold an answered call — call and answer in the SAME event — into the turn's entries.
     *
     * The `ptc` preset dispatches its tools from inside `run_code`, so the model's `learn`
     * call never appears as a top-level `tool/call`; it arrives once, already finished, as a
     * `tool/ptc-dispatch`. Nothing here waits for a result event, because there is none.
     *
     * Only calls this recap reports earn a line: `describeCall` returns `null` for the other
     * 906 dispatches of `read`/`grep`/`pwsh`/`write`, and those cost nothing.
     */
    function recordDispatch(state, event) {
      if (typeof event.data?.name !== 'string') return state;
      const entry = describeCall(event.data.name, parseArgs(event.data.arguments));
      if (entry === null) return state;
      return recordOutcome(state, entry, event.data?.isError === true, dispatchText(event));
    }

    /**
     * Decide the one line an answered call earns, and fold it into the entries.
     *
     * Shared by both shapes a call can arrive in — a `tool/call` joined to its `tool/result`,
     * and a single `tool/ptc-dispatch` — so the two can never disagree about what counts as a
     * write. The outcome rule and the identity rule below are the whole point of the recap;
     * having one copy of them is what keeps them honest.
     *
     * @param state - the turn state so far.
     * @param entry - the entry `describeCall` earned for this call.
     * @param failed - whether the host marked the call itself failed.
     * @param text - the answer the host gave.
     * @returns the folded state.
     */
    function recordOutcome(state, entry, failed, text) {
      // `entry.detail` is the wording the model PROPOSED; the result carries the wording that
      // actually landed, so the landed one wins. A refusal is the exception: what it gained
      // is nothing, and the useful detail is the gate's reason, not the statement it rejected.
      const parsed = failed ? { wrote: false, target: '', detail: '', code: '' } : parseNoteOutcome(text);
      // A note's outcome is decided by the sentence the host wrote, never by the ABSENCE of a
      // refusal marker. Only `已写入 …` and `已并入既有规则（…）` mean the rule landed; a gate
      // refusal, an injection refusal and a malformed call each print something else, and
      // painting any of them green is the one lie this recap must not tell. Every other verb
      // keeps the older reading, because a created skill answers with a sentence this file has
      // no reason to parse.
      const isNote = entry.key.startsWith('note.');
      const outcome = failed
        ? 'error'
        : (isNote ? (parsed.wrote ? 'ok' : 'refused') : (isRefusedText(text) ? 'refused' : 'ok'));
      const target = parsed.wrote ? parsed.target : (entry.target ?? '');
      const detail = outcome === 'ok' ? (parsed.detail !== '' ? parsed.detail : (entry.detail ?? '')) : parsed.detail;
      // Two notes of the same kind are two facts when they say different things, so the text
      // is part of the identity — a `×3` that hid three different rules would summarize
      // nothing, which is the opposite of what the footnote is for.
      const id = `${entry.key}\u0000${entry.name}\u0000${outcome}\u0000${target}\u0000${detail}`;
      const at = state.seen.get(id);
      const entries = state.entries.slice();
      if (at === undefined) {
        const tone = outcome === 'error' ? 'error' : (outcome === 'refused' ? 'warn' : entry.tone);
        entries.push({ id, key: entry.key, tone, name: entry.name, failed: outcome !== 'ok', count: 1, target, detail, code: parsed.code });
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
      // The `ptc` preset's shape: one event, call and answer together (see `recordDispatch`).
      if (event.type === 'tool/ptc-dispatch') return recordDispatch(state, event);
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
        // `tool/ptc-dispatch` MUST be matched too. Under the `ptc` preset the model's only
        // top-level tool is `run_code`, so a `learn` call is never a `tool/call` and has no
        // `tool/result` — miss this line and the recap is silently empty for the whole
        // workspace, which is exactly what the youtube-ambilight session looked like while
        // 16 rules were being written.
        if (event.type === 'tool/ptc-dispatch') return { id: String(turn), role: 'update' };
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
     * How much of a lesson's own text the footnote shows.
     *
     * A rule may be as long as `ACTIONABLE_MAX_CHARS` (200), which would push one entry onto
     * three or four rows and make the footnote louder than the answer above it. The cut is
     * display-only — `title` carries the sentence whole — so the two things worth seeing
     * (which skill took it, and what it now says) stay on one line.
     *
     * Forty, not eighty: the user's complaint was that the line was doing the model's reading,
     * and `→ tool-recovery：` plus the outcome already spends twelve of them. What the footnote
     * owes is "did it land, and where", not a recital of the rule.
     */
    const DETAIL_MAX_CHARS = 40;

    /**
     * Every refusal code this file can label, mirroring `REFUSAL_CODES` in `lib/text.js`.
     *
     * It is duplicated because the browser half is a SEPARATE bundle and cannot import the
     * host module, and it is checked rather than trusted: `scripts/client-check.mjs` imports
     * both lists and fails when one gains a code the other lacks. A code with no label would
     * print `refusal.not-actionable` in front of the user, which is worse than the long
     * sentence this table replaced.
     */
    const REFUSAL_CODES = [
      'empty', 'short', 'long', 'redacted', 'command-dump', 'meta-discussion', 'unresolved',
      'one-off', 'incident', 'data-dump', 'status', 'tool-envelope', 'no-error-shape',
      'env-state', 'negative-claim', 'durable-task-directive', 'durable-work-report',
      'durable-no-object', 'not-actionable', 'not-actionable-long', 'injection', 'routed', 'novel',
      'budget',
    ];

    /**
     * Cut a sentence at a clause boundary rather than at a character count.
     *
     * `slice(0, 79) + '…'` in Chinese or Japanese almost always lands inside a word, which is
     * how the user came to read `…超过 200…`. This walks back to the last clause mark within
     * the budget and only falls back to a hard cut when there is no boundary past the halfway
     * point (a long path or identifier has none).
     *
     * @param value - the text to cut.
     * @param max - the character budget.
     * @returns the text, cut and ellipsized only if it did not fit.
     */
    function clauseCut(value, max) {
      if (max <= 0 || value.length <= max) return value;
      const head = value.slice(0, max);
      for (const mark of ['：', '；', '。', '，', '、', '—', ' ', ': ', '; ', ', ']) {
        const at = head.lastIndexOf(mark);
        if (at >= Math.floor(max / 2)) return `${head.slice(0, at)}…`;
      }
      return `${head.slice(0, max - 1)}…`;
    }

    /**
     * What a refusal shows in the footnote: the label for its code, never the gate's sentence.
     *
     * @param entry - a folded entry.
     * @param t - the localized copy bound to this seat.
     * @returns the label, or `''` when the entry carries no code this file knows.
     */
    function refusalLabel(entry, t) {
      const code = typeof entry.code === 'string' ? entry.code : '';
      if (code === '' || !REFUSAL_CODES.includes(code)) return '';
      return t(`refusal.${code}`);
    }

    /**
     * One entry's sentence, in the two lengths the renderer needs.
     *
     * The shape is `<outcome> → <skill>：<what it says>`, e.g.
     * `已记下一条做法 → tool-recovery：先用 node --check 再提交`. An entry with nothing to
     * quote — a skill created, a curator run — stops after the outcome, and the sentence is
     * then exactly what it always was.
     *
     * The two lengths are two different texts for a refusal, not the same text cut twice: the
     * short one is the code's label and the long one is the gate's own sentence. A success is
     * one text cut at a clause boundary.
     *
     * @param entry - a folded entry.
     * @param t - the localized copy bound to this seat.
     * @param max - cut the lesson text at this many characters; `0` means "leave it whole".
     * @returns the sentence.
     */
    function sentence(entry, t, max) {
      const named = entry.name === '' ? t('name.unknown') : entry.name;
      let text = t(entry.failed === true ? `${entry.key}.failed` : entry.key, { name: named });
      const target = typeof entry.target === 'string' ? entry.target : '';
      const detail = typeof entry.detail === 'string' ? entry.detail.replace(/\s+/g, ' ').trim() : '';
      if (target !== '') text += t('detail.target', { name: target });
      // `max > 0` is what separates the tooltip from the line: the tooltip asks for the whole
      // thing, so it gets the gate's sentence even for a refusal.
      const shown = entry.failed === true && max > 0 ? (refusalLabel(entry, t) || clauseCut(detail, max)) : clauseCut(detail, max);
      if (shown !== '') text += t('detail.text', { text: shown });
      if (entry.count > 1) text += ` ×${entry.count}`;
      return text;
    }

    /**
     * The recap line for one completed turn.
     *
     * It reads nothing but `turn.data`, so it needs no hooks and costs nothing on the turns
     * that learned nothing. The `title` repeats the sentence UNCUT, because both a long skill
     * name and a long rule are ellipsized away in a one-line footnote.
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
        children.push(jsx('span', { style: SEPARATOR_STYLE, 'aria-hidden': 'true', children: '·' }, `sep:${index}`));
        children.push(jsx('span', {
          style: { color: TONE_COLOR[entry.tone] },
          title: sentence(entry, t, 0),
          children: sentence(entry, t, DETAIL_MAX_CHARS),
        }, `entry:${index}`));
      }
      return jsxs('div', { 'data-dsh-learn-recap': 'true', style: ROOT_STYLE, children });
    }

    const zh = {
      label: '学习',
      'name.unknown': '未命名',
      // How an entry names the skill it went into and quotes what it now says. The
      // punctuation lives here rather than in the renderer so the English line gets an
      // ASCII colon and the Chinese one keeps the full-width colon.
      'detail.target': ' → {name}',
      'detail.text': '：{text}',
      // Why a refusal gets its own short table instead of quoting the gate's sentence.
      //
      // The gate's reason is written for the MODEL: it has to explain how to pass, so it runs
      // to about ninety characters. The footnote is forty. Rendering the sentence meant every
      // refusal arrived cut in the middle of a word — the user saw `…超过 200…`. So the reason
      // stays long where the model reads it (the tool result), the code is what the footnote
      // shows, and the whole sentence is still in the tooltip.
      //
      // The keys mirror `REFUSAL_CODES` in `lib/text.js`. `scripts/client-check.mjs` imports
      // BOTH lists and fails if they diverge, because a code with no label here would render
      // as `refusal.not-actionable` in front of the user.
      'refusal.empty': '没写内容',
      'refusal.short': '太短',
      'refusal.long': '太长',
      'refusal.redacted': '被脱敏替换过',
      'refusal.command-dump': '是命令堆',
      'refusal.meta-discussion': '是插件自身的讨论',
      'refusal.unresolved': '失败还没解决',
      'refusal.one-off': '是一次性要求',
      'refusal.incident': '在复述一次事故',
      'refusal.data-dump': '是数据堆',
      'refusal.status': '是工作汇报',
      'refusal.tool-envelope': '是工具输出原文',
      'refusal.no-error-shape': '没有报错形状',
      'refusal.env-state': '是环境状态，不是做法',
      'refusal.negative-claim': '是「某工具不行」的断言',
      'refusal.durable-task-directive': '是一次性任务指令',
      'refusal.durable-work-report': '是工作汇报',
      'refusal.durable-no-object': '没有具体对象',
      'refusal.not-actionable': '读不出可迁移的做法',
      'refusal.not-actionable-long': '太长了',
      'refusal.injection': '命中指令注入特征',
      'refusal.routed': '落点不对',
      'refusal.novel': '和已有规则重复',
      'refusal.budget': '这类规则满了',
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
      'detail.target': ' → {name}',
      'detail.text': ': {text}',
      // Mirrors the Chinese table. Same rule: one short label per refusal code, kept in step
      // with `REFUSAL_CODES` in `lib/text.js` by `scripts/client-check.mjs`.
      'refusal.empty': 'empty',
      'refusal.short': 'too short',
      'refusal.long': 'too long',
      'refusal.redacted': 'redacted',
      'refusal.command-dump': 'a pile of commands',
      'refusal.meta-discussion': 'about the plugin itself',
      'refusal.unresolved': 'the failure was never fixed',
      'refusal.one-off': 'a one-off request',
      'refusal.incident': 'a retelling of one incident',
      'refusal.data-dump': 'a data dump',
      'refusal.status': 'a work report',
      'refusal.tool-envelope': 'raw tool output',
      'refusal.no-error-shape': 'no error shape',
      'refusal.env-state': 'environment state, not a technique',
      'refusal.negative-claim': 'a claim that a tool does not work',
      'refusal.durable-task-directive': 'a one-off task instruction',
      'refusal.durable-work-report': 'a work report',
      'refusal.durable-no-object': 'no concrete object',
      'refusal.not-actionable': 'no transferable technique',
      'refusal.not-actionable-long': 'too long',
      'refusal.injection': 'an instruction-injection signature',
      'refusal.routed': 'wrong home skill',
      'refusal.novel': 'already covered by a rule',
      'refusal.budget': 'this class is full',
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
