#!/usr/bin/env node
/**
 * Replay a real DSH session through the plugin and report what it would learn.
 *
 * Every other test in this directory feeds the plugin text that a human chose.
 * This one feeds it a session that actually happened, in the order it happened,
 * through the real event handler — which is the only way to answer the question
 * the unit tests cannot: does it work on my conversations?
 *
 * A session file is a sequence of concatenated zstd frames, one per append, so
 * `zstdDecompressSync` on the whole file returns only the first frame. Each
 * frame is decoded separately here.
 *
 * Usage:
 *   node scripts/replay-session.mjs                      # newest session
 *   node scripts/replay-session.mjs --latest 5           # the newest 5
 *   node scripts/replay-session.mjs --session <file>
 *   node scripts/replay-session.mjs --dsh-home <dir>     # throwaway library
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
/**
 * `--name=value` and `--name value` both work. A flag with no value is `true`.
 * Accepting the spaced form matters: `--dsh-home C:\some\dir` used to resolve to
 * the boolean `true`, which `String()` turned into a directory literally named
 * `true` in the current working directory — a silent, very confusing misfire.
 */
const flag = (name, fallback = null) => {
  const eq = args.findIndex((entry) => entry.startsWith(`${name}=`));
  if (eq !== -1) return args[eq].slice(name.length + 1);
  const bare = args.indexOf(name);
  if (bare === -1) return fallback;
  const next = args[bare + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};

// ------------------------------------------------------------- zstd framing

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeSessionFile(file) {
  const raw = readFileSync(file);
  const offsets = [];
  let at = raw.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = raw.indexOf(ZSTD_MAGIC, at + 1);
  }
  if (!offsets.length) return raw.toString('utf8');
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const frame = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length);
    try {
      parts.push(zlib.zstdDecompressSync(frame).toString('utf8'));
    } catch {
      // A magic sequence inside compressed payload, not a frame boundary.
    }
  }
  return parts.join('');
}

export function readEvents(file) {
  return decodeSessionFile(file)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ------------------------------------------------------------- session discovery

function findSessions(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          found.push({ file: full, mtime: statSync(full).mtimeMs, size: statSync(full).size });
        } catch {
          /* raced away */
        }
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

// ------------------------------------------------------------- cordis stub

function makeCtx(logs) {
  const handlers = new Map();
  const tools = new Map();
  const services = new Map();
  const ctx = {
    logger: {
      info: (msg) => logs.push(`[info] ${msg}`),
      warn: (msg) => logs.push(`[warn] ${msg}`),
      error: (msg) => logs.push(`[error] ${msg}`),
      debug: () => {},
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    effect(fn) {
      try {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch {
        return () => {};
      }
    },
    get: (name) => services.get(name),
    set: (name, value) => services.set(name, value),
    provide: (name, value) => services.set(name, value),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    skills: undefined,
  };
  return { ctx, handlers, tools };
}

function emit(handlers, session, event) {
  for (const handler of handlers.get('session/event') || []) handler(session, event);
}

// ------------------------------------------------------------- main

const dshHome = String(flag('--dsh-home', join(process.env.TEMP || homedir(), `learn-replay-${process.pid}`)));
process.env.DSH_HOME = dshHome;
process.env.DSH_PROFILE_DIR = join(dshHome, 'profile');

const { normalizeConfig } = await import('../lib/config.js');
const { applyImpl } = await import('../lib/index.js');

const sessionsRoot = String(flag('--sessions', join(homedir(), '.dsh', 'sessions')));
let files = [];
const explicit = flag('--session');
if (explicit && explicit !== true) files = [String(explicit)];
else {
  const count = Number(flag('--latest', 1)) || 1;
  files = findSessions(sessionsRoot).slice(0, count).map((entry) => entry.file);
}

if (!files.length) {
  console.log(`没有找到会话文件（在 ${sessionsRoot} 下）`);
  process.exit(0);
}

const logs = [];
const { ctx, handlers, tools } = makeCtx(logs);

const config = normalizeConfig({ dshHome });
applyImpl(ctx, { dshHome });

console.log(`回放库：${dshHome}`);
console.log(`注册工具：${[...tools.keys()].join(', ')}`);
console.log('');

for (const file of files) {
  const events = readEvents(file);
  const sessionId = (events.find((event) => event.type === 'session') || {}).id || file;
  const counts = { user: 0, assistant: 0, tool: 0 };
  for (const event of events) {
    if (event.type === 'user/message') counts.user += 1;
    if (event.type === 'assistant/message') counts.assistant += 1;
    if (event.type === 'tool/result') counts.tool += 1;
    emit(handlers, { id: sessionId }, event);
  }
  console.log(`${sessionId}`);
  console.log(`  事件 ${events.length}（用户 ${counts.user} · 助手 ${counts.assistant} · 工具 ${counts.tool}）`);
}

// The plugin debounces its review; run it now instead of waiting.
const learn = tools.get('learn');
const review = tools.get('learn_review');
if (!learn || !review) {
  console.log('工具没有注册成功，无法继续');
  process.exit(1);
}

const call = async (definition, params) => {
  const value = await definition.execute(params, { session: { id: 'replay' } });
  const clean = JSON.parse(JSON.stringify(value));
  return typeof clean === 'string' ? clean : JSON.stringify(clean, null, 2);
};

// `--tool learn --args '{"action":"status"}'` inspects one tool against the
// replayed library instead of running the default review sequence.
const only = flag('--tool');
if (only) {
  const definition = tools.get(only);
  if (!definition) {
    console.log(`没有这个工具：${only}。已注册：${[...tools.keys()].join(', ')}`);
    process.exit(1);
  }
  let params = {};
  const raw = flag('--args');
  if (raw) {
    try {
      params = JSON.parse(raw);
    } catch (error) {
      console.log(`--args 不是合法 JSON：${error.message}`);
      process.exit(1);
    }
  }
  console.log(await call(definition, params));
  console.log('');
  console.log(`（回放库留在 ${dshHome}，检查完可以整个删掉。）`);
  process.exit(0);
}

console.log('');
console.log('=== 自动审查（只提出候选，不写文件）===');
const dry = await call(review, { action: 'dry-run' });
console.log(String(dry));

console.log('');
console.log('=== 如果现在真的跑一次，会提出什么 ===');
const real = await call(review, { action: 'run' });
console.log(String(real).slice(0, 4000));

console.log('');
console.log('=== 队列 ===');
console.log(String(await call(learn, { action: 'pending' })).slice(0, 4000));

console.log('');
console.log(`（回放库留在 ${dshHome}，检查完可以整个删掉。）`);
