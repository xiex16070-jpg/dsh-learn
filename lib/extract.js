/**
 * Defensive readers for the session event feed.
 *
 * The feed's exact payload shape is not part of the published plugin contract,
 * so every accessor tries the known spellings and degrades to `undefined`
 * instead of throwing. An observation we cannot parse is dropped; it is never
 * guessed at. Same discipline the host applies to its own `sessionIdOf`:
 * unknown is "no data", not "invent something".
 */

function stripNulls(value) {
  return value === null || value === undefined ? undefined : value;
}

function pick(...values) {
  for (const value of values) if (stripNulls(value) !== undefined) return value;
  return undefined;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** Join every plausible text carrier into plain text. */
function contentOf(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const candidates = [
    data.content,
    data.text,
    data.message?.content,
    data.result?.content,
    data.output?.content,
    raw.content,
    raw.message?.content,
    raw.text,
  ];
  for (const candidate of candidates) {
    const text = flatten(candidate);
    if (text) return text;
  }
  return '';
}

function flatten(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts = [];
  for (const block of value) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    else if (block && typeof block === 'object' && block.type === 'text' && typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

/**
 * The tool call id, which is how a `tool/result` is tied back to its `tool/call`.
 *
 * The result event does NOT carry the tool name — it carries only `source.callId`
 * and `toolCallId`. Without this join every observation is anonymous, which is
 * how the first live replay produced lessons reading `": Error: old_string was
 * not found in ..."` with an empty tool prefix, and why same-tool recovery
 * matching never fired.
 */
function callIdOf(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const value = pick(
    data.callId,
    data.toolCallId,
    data.message?.toolCallId,
    data.message?.source?.callId,
    data.source?.callId,
    raw.callId,
    raw.toolCallId,
  );
  return typeof value === 'string' ? value : '';
}

export function makeExtractor() {
  // callId → { name, args }, filled from `tool/call` and consumed by matching
  // `tool/result` events. Bounded so a long session cannot grow it without limit.
  const calls = new Map();
  const MAX_CALLS = 500;
  const remember = (id, value) => {
    if (!id) return;
    if (calls.size >= MAX_CALLS) {
      const oldest = calls.keys().next().value;
      calls.delete(oldest);
    }
    calls.set(id, { ...(calls.get(id) || {}), ...value });
  };

  return {
    content: (event) => contentOf(event),

    /** Record a `tool/call` so its later `tool/result` can be identified. */
    noteCall(event) {
      const id = callIdOf(event);
      const data = event?.data && typeof event.data === 'object' ? event.data : {};
      const name = pick(data.name, data.toolName);
      remember(id, {
        name: typeof name === 'string' ? name : '',
        args: this.args(event),
      });
    },

    callId: (event) => callIdOf(event),

    toolName(event) {
      const data = event?.data && typeof event.data === 'object' ? event.data : {};
      const value = pick(
        data.name,
        data.toolName,
        data.tool?.name,
        data.call?.name,
        data.message?.name,
        event?.name,
        event?.toolName,
      );
      if (typeof value === 'string' && value) return value;
      const known = calls.get(callIdOf(event));
      return known && typeof known.name === 'string' ? known.name : '';
    },

    failed(event) {
      const data = event?.data && typeof event.data === 'object' ? event.data : {};
      if (data.error !== undefined && data.error !== null) return true;
      if (data.isError === true || data.is_error === true) return true;
      if (data.message?.isError === true) return true;
      const status = pick(data.status, data.outcome?.status, data.result?.status);
      if (typeof status === 'string' && /error|fail|denied|abort/i.test(status)) return true;
      const text = contentOf(event);
      if (/^\s*Error:/m.test(text)) return true;
      if (/\[exit code: [1-9]\d*\]/.test(text)) return true;
      return false;
    },

    args(event) {
      const data = event?.data && typeof event.data === 'object' ? event.data : {};
      const value = pick(data.arguments, data.args, data.input, data.call?.arguments);
      const parse = (candidate) => {
        if (candidate && typeof candidate === 'object') return candidate;
        if (typeof candidate === 'string') {
          try {
            const parsed = JSON.parse(candidate);
            return parsed && typeof parsed === 'object' ? parsed : undefined;
          } catch {
            return undefined;
          }
        }
        return undefined;
      };
      const direct = parse(value);
      if (direct) return direct;
      const known = calls.get(callIdOf(event));
      return known ? known.args : undefined;
    },

    /** The skill a `skill` tool call loaded, in any of its spellings. */
    skillName(event) {
      const args = this.args(event);
      const value = pick(args?.name, args?.skill, args?.skill_name);
      if (typeof value === 'string' && value.trim()) return value.trim();
      const text = contentOf(event);
      const match = /(?:^|\n)#\s*([a-z0-9][a-z0-9-]*)/i.exec(text);
      return match ? match[1] : '';
    },

    cwd(raw) {
      const value = pick(raw?.header?.cwd, raw?.cwd, raw?.data?.cwd, raw?.data?.header?.cwd);
      return typeof value === 'string' ? value : undefined;
    },

    blocks(value) {
      return asArray(value);
    },
  };
}
