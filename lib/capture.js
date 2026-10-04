/**
 * Session capture — the observation window the reviewer reads.
 *
 * The reviewer must never need the raw transcript. This keeps a bounded,
 * already-distilled window per session — corrections, failures, fixes, durable
 * facts — and hands the reviewer that instead. Nothing here touches the session
 * store or the prompt, so capturing costs nothing against the prefix cache.
 *
 * Source discipline is enforced HERE, not at the call site, and it is the fix
 * for the worst bug this plugin ever had. `classifyText` is told whether the
 * text came from the user, the assistant, or a tool, and only the kinds that
 * source can legitimately raise are considered. Assistant narration can
 * therefore never become "the user prefers X" — which is exactly how the
 * plugin's own debug monologue once became its first stored preference.
 *
 * Lifetime: purely in-memory, capped by `capture.maxSessions` (LRU) and
 * `capture.maxItemsPerSession`. A restart loses the window, never the ledger.
 */

import {
  SIGNAL,
  SIGNAL_WEIGHT,
  KIND_LABEL,
  assistantObservationOk,
  classifyText,
  classifyToolOutcome,
  condense,
  desensitize,
  extractText,
  fingerprint,
  hasConcreteDetail,
  isMostlyRedacted,
  looksOneOff,
} from './text.js';

export { KIND_LABEL };

export class Capture {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, {id:string,items:object[],turn:number,updatedAt:number,score:number,cwd?:string,goal?:string}>} */
    this.sessions = new Map();
    this.seq = 0;
    this.lastEventAt = 0;
  }

  #window(sessionId, cwd) {
    const id = String(sessionId || '');
    if (!id) return null;
    let win = this.sessions.get(id);
    if (!win) {
      win = { id, items: [], turn: 0, updatedAt: Date.now(), score: 0, cwd, goal: '' };
      this.sessions.set(id, win);
      this.#prune();
    }
    win.updatedAt = Date.now();
    if (cwd && !win.cwd) win.cwd = cwd;
    return win;
  }

  #prune() {
    const max = this.config.capture.maxSessions;
    if (this.sessions.size <= max) return;
    const ordered = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const win of ordered.slice(0, this.sessions.size - max)) this.sessions.delete(win.id);
  }

  #push(win, item) {
    if (!win) return null;
    const maxChars = this.config.capture.maxItemChars;
    const text = condense(desensitize(item.text), maxChars);
    if (!text || isMostlyRedacted(text)) return null;
    this.lastEventAt = Date.now();
    const record = {
      id: `o${++this.seq}`,
      turn: win.turn,
      at: Date.now(),
      kind: item.kind,
      kinds: item.kinds || [item.kind],
      weight: SIGNAL_WEIGHT[item.kind] ?? 1,
      source: item.source,
      tool: item.tool,
      resolved: item.resolved,
      text,
      fp: fingerprint(text),
    };
    // Merge an identical observation instead of stacking duplicates: the same
    // lesson learned twice is ONE rule. `count` is what the reviewer reads to
    // decide "this happened again", so it must be real (the old `defer()` set
    // it to a constant 1 and the advertised merge never happened).
    const dup = win.items.find((other) => other.fp && other.fp === record.fp);
    if (dup) {
      dup.count = (dup.count || 1) + 1;
      dup.at = record.at;
      if (record.resolved === true) dup.resolved = true;
      return dup;
    }
    win.items.push(record);
    const overflow = win.items.length - this.config.capture.maxItemsPerSession;
    if (overflow > 0) win.items.splice(0, overflow);
    win.score += record.weight;
    return record;
  }

  /**
   * Real user turns only. The event feed carries plugin-injected reminders and
   * system notes as `user/message` too — memorizing those would make the agent
   * learn its own scaffolding back as if the user had asked for it, so the
   * filter lives here, not at the call site.
   */
  recordUserMessage(sessionId, content, meta = {}) {
    const kind = meta.source?.kind;
    if (kind && kind !== 'user') return null;
    const win = this.#window(sessionId, meta.cwd);
    if (!win) return null;
    win.turn += 1;
    const text = extractText(content);
    if (!text.trim()) return null;
    if (!win.goal) win.goal = condense(desensitize(text), 400);
    const kinds = classifyText(text, { source: 'user' });
    if (!kinds.length) return null;
    return this.#push(win, { kind: kinds[0], kinds, source: 'user', text });
  }

  /**
   * Assistant turns are the noisiest source: the model narrates its own plan
   * ("I need to verify the lockfile, then kick off the build") and a loose
   * pattern bank reads that prose as a constraint. Assistant text may only
   * evidence a technique or a skill defect, and even then must carry a concrete
   * artifact so the window holds something a future session can repeat.
   *
   * `assistantObservationOk` closes the hole those two conditions left: they
   * were both satisfied by narration, because narration is full of backticked
   * paths. The measured cost is in `lib/text.js` — 158 of 261 gate refusals
   * were this plugin rejecting its own prose. The gate is unchanged; the text
   * simply no longer reaches the window to be refused.
   */
  recordAssistantMessage(sessionId, content, meta = {}) {
    const win = this.#window(sessionId, meta.cwd);
    if (!win) return null;
    const text = extractText(content);
    if (!text.trim()) return null;
    const kinds = classifyText(text, { source: 'assistant' });
    if (!kinds.length) return null;
    if (!hasConcreteDetail(text)) return null;
    if (!assistantObservationOk(text, kinds[0])) return null;
    return this.#push(win, { kind: kinds[0], kinds, source: 'assistant', text });
  }

  recordToolResult(sessionId, { tool, failed, content, args, meta = {} }) {
    const win = this.#window(sessionId, meta.cwd);
    if (!win) return null;
    if (this.config.capture.ignoreTools.includes(tool)) return null;
    const text = extractText(content);
    const kind = classifyToolOutcome({ ok: !failed, summary: text, resolved: !failed });

    if (!failed) {
      // A success is only interesting if it CLOSED an open failure. That pairing
      // is the whole value of watching tools at all: "this broke, then this fixed
      // it". A success on its own is a transcript entry, and filing those is how
      // the first live run ended up proposing raw shell commands as techniques.
      const opened = win.items.filter((other) => other.tool === tool && other.resolved === false);
      if (!opened.length) {
        if (!this.config.capture.recordSuccesses) return null;
        const summary = summarizeCall(tool, args);
        if (!summary) return null;
        const record = this.#push(win, { kind: SIGNAL.TECHNIQUE, source: 'tool', tool, text: summary, resolved: true });
        if (record) record.count = (record.count || 1) + 1;
        return record;
      }
      const fixText = text && text.trim() ? condense(text, 200) : '';
      let promoted = null;
      for (const other of opened) {
        other.resolved = true;
        other.kind = SIGNAL.RECOVERED_FAILURE;
        other.kinds = [...new Set([...(other.kinds || []), SIGNAL.RECOVERED_FAILURE])];
        other.weight = Math.max(other.weight || 0, SIGNAL_WEIGHT[SIGNAL.RECOVERED_FAILURE]);
        // A failure that just got fixed is a DIFFERENT observation from the one
        // that was refused while it was still broken, so let the reviewer see it
        // again. This is the only thing that re-opens a consumed observation.
        other.filed = null;
        // The failure text is the lesson; the success text is the evidence that
        // it was solved, so it is attached rather than replacing it.
        if (fixText && !other.fixedBy) other.fixedBy = fixText;
        promoted = promoted || other;
      }
      return promoted;
    }

    if (!kind) return null;
    // Bound the body: a failing command can emit a page of output, and the
    // lesson is in its first lines. The gate refuses rambles anyway, but there
    // is no reason to carry a page of them into the queue first.
    const raw = text && text.trim() ? text : summarizeCall(tool, args) || `${tool} 失败`;
    const body = condense(raw, 400);
    const label = tool ? `${tool}: ` : '';
    return this.#push(win, { kind, source: 'tool', tool, resolved: false, text: `${label}${body}` });
  }

  /** Mark a whole session's open failures resolved (a later step fixed them). */
  markResolved(sessionId, tool) {
    const win = this.sessions.get(String(sessionId || ''));
    if (!win) return 0;
    let n = 0;
    for (const item of win.items) {
      if (item.resolved === false && (!tool || item.tool === tool)) {
        item.resolved = true;
        item.kind = SIGNAL.RECOVERED_FAILURE;
        item.kinds = [...new Set([...(item.kinds || []), SIGNAL.RECOVERED_FAILURE])];
        item.weight = Math.max(item.weight || 0, SIGNAL_WEIGHT[SIGNAL.RECOVERED_FAILURE]);
        item.filed = null;
        n += 1;
      }
    }
    return n;
  }

  window(sessionId) {
    return this.sessions.get(String(sessionId || '')) || null;
  }

  score(sessionId) {
    const win = this.window(sessionId);
    if (!win) return 0;
    return win.items.reduce((sum, item) => sum + item.weight, 0);
  }

  /** Observations the reviewer should look at, best first. */
  candidates(sessionId, minWeight = 1) {
    const win = this.window(sessionId);
    if (!win) return [];
    return [...win.items]
      .filter((item) => item.weight >= minWeight)
      .sort((a, b) => b.weight - a.weight || b.at - a.at);
  }

  /**
   * Turn the window into *proposals*: one per candidate observation, each
   * carrying the gate verdict so the queue can say WHY it is waiting instead of
   * silently dropping it. The reviewer proposes; it never writes.
   *
   * An observation that has already been filed is skipped. Without that, every
   * review tick re-filed the whole window and `hits` counted TICKS instead of
   * corroborations — the live run showed a stale line of prose sitting at
   * "hits: 8" after five minutes, which reads as eight independent confirmations.
   */
  proposals(sessionId, { minWeight = 2, maxProposals = 8 } = {}) {
    const win = this.window(sessionId);
    if (!win) return [];
    const seen = new Set();
    const out = [];
    for (const item of this.candidates(sessionId, minWeight)) {
      if (out.length >= maxProposals) break;
      if (!item.fp || seen.has(item.fp)) continue;
      if (item.filed) continue;
      seen.add(item.fp);
      const reasons = [];
      if (looksOneOff(item.text)) reasons.push('疑似一次性要求');
      if (item.resolved === false) reasons.push('失败尚未解决');
      out.push({
        id: item.id,
        kind: item.kind,
        kinds: item.kinds,
        source: item.source,
        tool: item.tool,
        statement: item.text,
        weight: item.weight,
        hits: item.count || 1,
        session: win.id,
        observedAt: new Date(item.at).toISOString(),
        notes: reasons,
      });
    }
    return out;
  }

  /**
   * Mark observations as filed, so the next review tick does not count them
   * again. Called with the proposal id each observation produced.
   */
  markFiled(sessionId, entries = []) {
    const win = this.window(sessionId);
    if (!win) return 0;
    let n = 0;
    for (const entry of entries) {
      const item = win.items.find((other) => other.id === entry.id);
      if (item && !item.filed) {
        item.filed = entry.proposalId || true;
        n += 1;
      }
    }
    return n;
  }

  clear(sessionId) {
    return this.sessions.delete(String(sessionId || ''));
  }

  /** Everything the reviewer sees, rendered as one bounded text block. */
  digest(sessionId, { maxChars = 6000 } = {}) {
    const win = this.window(sessionId);
    if (!win) return '';
    const lines = [];
    lines.push(`会话 ${win.id}｜轮次 ${win.turn}｜观测 ${win.items.length} 条`);
    if (win.cwd) lines.push(`工作目录 ${win.cwd}`);
    if (win.goal) lines.push(`本轮任务：${win.goal}`);
    lines.push('');
    const ordered = [...win.items].sort((a, b) => a.at - b.at);
    let used = lines.join('\n').length;
    for (const item of ordered) {
      const tags = [KIND_LABEL[item.kind] || item.kind, `w${item.weight}`, `源:${item.source || '?'}`];
      if (item.tool) tags.push(`工具:${item.tool}`);
      if (item.resolved === true) tags.push('已解决');
      if (item.resolved === false) tags.push('未解决');
      if (item.count > 1) tags.push(`×${item.count}`);
      const line = `- [${tags.join('|')}] ${item.text}`;
      if (used + line.length > maxChars) {
        lines.push('- …（窗口已截断）');
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  stats() {
    return {
      sessions: this.sessions.size,
      observations: [...this.sessions.values()].reduce((n, win) => n + win.items.length, 0),
    };
  }
}

/** A tool call is worth recording when it carries a command worth repeating. */
export function summarizeCall(tool, args) {
  if (!args || typeof args !== 'object') return '';
  const interesting = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'name'];
  for (const key of interesting) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return `${tool}(${key}=${condense(value, 160)})`;
  }
  return '';
}
