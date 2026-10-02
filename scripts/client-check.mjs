/**
 * Self-test for the browser half, `lib/client.js`.
 *
 *   node scripts/client-check.mjs
 *
 * The file cannot be `import`ed: it is a plain side-effect script whose whole
 * top level is one `window.__ModuleLoader__.load({ id, factory })` call. So this
 * harness supplies the smallest possible stand-in for that frame, then drives
 * the REAL `match` / `start` / `update` / `buildLocationData` over simulated
 * session events and renders the REAL component with a fake `jsx`.
 *
 * What this proves: the fold — which tool call earns a line, which one is
 * deduped, whether a failed call is coloured as a failure, and that a turn with
 * nothing to report publishes nothing. What it CANNOT prove: the appearance.
 * There is no browser here, and an emulated renderer is not a substitute for
 * looking at the thing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.LEARN_CLIENT_TARGET ?? join(HERE, '..', 'lib', 'client.js');

let checks = 0;
const failures = [];
function ok(label, condition, detail) {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? label : `${label} — ${detail}`);
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- module frame
let frame = null;
globalThis.window = { __ModuleLoader__: { load(value) { frame = value; } } };
await import(pathToFileURL(TARGET).href);
ok('the file registers exactly one module frame', frame !== null);
eq('frame id', frame?.id, 'dsh-learn');
ok('frame exposes a factory', typeof frame?.factory === 'function');

const jsx = (type, props, key) => ({ type, props: key === undefined ? { ...props } : { ...props, key } });
const jsxs = jsx;
const seenRequires = [];
function fakeRequire(id) {
  seenRequires.push(id);
  if (id === 'react/jsx-runtime') return { jsx, jsxs };
  throw new Error(`client.js required something it is not allowed to require: ${id}`);
}
const plugin = frame.factory(fakeRequire);
eq('every require is react/jsx-runtime and nothing else', seenRequires.join(','), 'react/jsx-runtime');
eq('plugin name', plugin.name, 'dsh-learn');
eq('injected services', plugin.inject.join(','), 'slots,locale,uiConversation');
eq('apply is a function', typeof plugin.apply, 'function');

// ---------------------------------------------------------------- fake ctx
let definition = null;
let dictionaries = null;
let slotDescriptor = null;
let seatName = null;
let Tail = null;
const effectLabels = [];
const ctx = {
  locale: { register(ns, dicts) { dictionaries = { ns, ...dicts }; } },
  uiConversation: { events: { register(def) { definition = def; } } },
  slots: {
    inject(seat, fn) { seatName = seat; return fn(); },
    register(descriptor, component) { slotDescriptor = descriptor; Tail = component; },
  },
  effect(fn, label) { effectLabels.push(label); return fn(); },
};
plugin.apply(ctx);

eq('locale namespace registered', dictionaries?.ns, 'dsh-learn');
eq('seat', seatName, 'conversation.chat.turnTail');
eq('slot descriptor name', slotDescriptor?.name, 'conversation.chat.turnTail');
eq('slot descriptor id', slotDescriptor?.id, 'dsh-learn');
eq('slot descriptor locale', slotDescriptor?.locale, 'dsh-learn');
// `order` is a REAL descriptor field, not a guess: the shipped Client template passes it —
// cordis-plugin-development/templates/decoration/client.js:16-18
//   ctx.slots.register({ name: 'conversation.composer.dock', id: 'my-decoration', order: 5 }, Decoration)
ok('slot descriptor declares the briefed `order: 500`', slotDescriptor?.order === 500);
ok('slot descriptor carries only known keys',
  Object.keys(slotDescriptor ?? {}).every((k) => ['name', 'id', 'order', 'locale'].includes(k)));
ok('the registration goes through slots.inject, keyed by the seat', seatName === 'conversation.chat.turnTail');
ok('a definition was registered', definition !== null);
ok('effects were labelled', effectLabels.length === 2, effectLabels.join(' | '));
eq('definition kind', definition.kind, 'learn-recap');
ok('definition declares neither target nor buildViewNode', !('target' in definition) && !('buildViewNode' in definition));

// `t` THROWS on a missing key, which is how dictionary completeness gets tested.
function makeT(lang) {
  const dict = dictionaries[lang];
  return (key, params) => {
    if (!Object.prototype.hasOwnProperty.call(dict, key)) throw new Error(`MISSING ${lang} KEY: ${key}`);
    return params === undefined ? dict[key] : dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
  };
}
const zhKeys = Object.keys(dictionaries.zh);
const enKeys = Object.keys(dictionaries.en);
eq('zh and en cover the same keys', zhKeys.slice().sort().join(','), enKeys.slice().sort().join(','));

// ---------------------------------------------------------------- fold driver
const KIND = 'learn-recap';
function call(turn, callId, name, args) {
  return { type: 'tool/call', data: { turn, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}
function result(turn, callId, failed, text) {
  const content = typeof text === 'string' ? [{ type: 'text', text }] : undefined;
  return {
    type: 'tool/result',
    data: {
      turn,
      message: {
        source: { callId },
        ...(failed === true ? { isError: true } : {}),
        ...(content === undefined ? {} : { content }),
      },
    },
  };
}
function startEvent(turn) { return { type: 'turn/start', data: { turn } }; }

function fold(events) {
  let state;
  let started = false;
  for (const event of events) {
    const matched = definition.match(event);
    if (matched === null || matched === undefined) continue;
    const match = { ...matched, event };
    if (match.role === 'start') {
      state = definition.start({}, match);
      started = true;
      if (state === undefined) throw new Error(`start returned undefined after ${event.type}`);
    } else if (state !== undefined) {
      // Mirrors the registry exactly: it calls `update` only into a started context
      // (dsh-client-ui-conversation/lib/client.js:2200-2202), so a stray update match
      // before any start is recorded and then silently ignored.
      state = definition.update({ state }, match);
      if (state === undefined) throw new Error(`update returned undefined after ${event.type}`);
    }
  }
  return { state, started };
}

function publish(state, turn, previous) {
  return definition.buildLocationData({ state }, 'turn', previous === undefined ? null : previous);
}

function render(value, lang) {
  // `turn.data` holds the `value` from buildLocationData under the definition's key —
  // verified against dsh-client-ui-deliverables/lib/client.js:1250, which reads
  // `owner.turn.data.get("deliverables")?.changes` off exactly that object.
  const turn = { data: new Map(value === null ? [] : [[KIND, value.value]]) };
  const tree = Tail({ turn, seq: 1, openFile() {}, t: makeT(lang) });
  return tree;
}
function texts(tree) {
  if (tree === null) return [];
  const out = [];
  for (const child of tree.props.children) {
    if (typeof child?.props?.children === 'string') out.push(child.props.children);
  }
  return out;
}
function entriesOf(tree) {
  if (tree === null) return [];
  return tree.props.children.filter((child) => typeof child?.props?.title === 'string');
}

// ---------------------------------------------------------------- 1. a real turn
const turn7 = fold([
  startEvent(7),
  call(7, 'c1', 'learn_skill_manage', { action: 'create', name: 'tool-recovery' }),
  result(7, 'c1'),
  call(7, 'c2', 'learn', { action: 'note', kind: 'REMEMBER_REQUEST', statement: 'x' }),
  result(7, 'c2'),
]);
ok('turn started', turn7.started);
const v7 = publish(turn7.state, 7);
eq('published kind', v7.kind, 'turn');
eq('published key equals the definition kind', v7.key, KIND);
eq('published turn', v7.turn, 7);
eq('two entries', v7.value.entries.length, 2);
eq('create entry key', v7.value.entries[0].key, 'skill.create');
eq('create entry tone', v7.value.entries[0].tone, 'success');
eq('note entry key', v7.value.entries[1].key, 'note.remember-request');

const lines7 = texts(render(v7, 'zh'));
eq('rendered as label + 2 entries + 2 separators', lines7.length, 5);
eq('leading label in zh', lines7[0], '学习');
eq('separator', lines7[1], '·');
eq('first sentence', lines7[2], "技能 'tool-recovery' 已创建");
eq('second sentence', lines7[4], '记住一条用户要求');
const en7 = texts(render(v7, 'en'));
eq('leading label in en', en7[0], 'learn');
eq('first sentence in en', en7[2], "skill 'tool-recovery' created");
const spans = entriesOf(render(v7, 'zh'));
ok('every entry carries a hover title', spans.length === 2 && spans.every((s) => typeof s.props.title === 'string'));
eq('root marker attribute', render(v7, 'zh').props['data-dsh-learn-recap'], 'true');

// ---------------------------------------------------------------- 2. reference stability
const again = publish(turn7.state, 7, v7);
ok('unchanged state republishes the SAME object', again === v7);
const afterOneMore = fold([startEvent(7), call(7, 'c1', 'learn_skill_manage', { action: 'create', name: 'x' }), result(7, 'c1'), call(7, 'c9', 'learn', { action: 'pin', name: 'y' }), result(7, 'c9')]);
ok('a changed state publishes a NEW object', publish(afterOneMore.state, 7, v7) !== v7);
eq('buildLocationData returns null for the step scope', definition.buildLocationData({ state: turn7.state }, 'step', null), null);
eq('buildLocationData publishes a safe integer turn', definition.buildLocationData({ state: { turn: 1, entries: [] } }, 'turn', null).turn, 1);
eq('buildLocationData returns null with no state', definition.buildLocationData({}, 'turn', null), null);

// ---------------------------------------------------------------- 3. a failure is never a success
const failed = fold([startEvent(8), call(8, 'c1', 'learn_skill_manage', { action: 'update', name: 'a' }), result(8, 'c1', true)]);
const v8 = publish(failed.state, 8);
eq('failed entry tone', v8.value.entries[0].tone, 'error');
eq('failed entry key is the success key', v8.value.entries[0].key, 'skill.update');
const lines8 = texts(render(v8, 'zh'));
eq('failed sentence is the failure sentence', lines8[2], "技能 'a' 修补失败");

// ---------------------------------------------------------------- 4. dedup within one outcome, split across outcomes
const twice = fold([
  startEvent(9),
  call(9, 'c1', 'learn_skill_manage', { action: 'update', name: 'a' }), result(9, 'c1'),
  call(9, 'c2', 'learn_skill_manage', { action: 'update', name: 'a' }), result(9, 'c2'),
]);
const v9 = publish(twice.state, 9);
eq('a repeat collapses to one entry', v9.value.entries.length, 1);
eq('the repeat is counted', v9.value.entries[0].count, 2);
eq('the count is rendered', texts(render(v9, 'zh'))[2], "技能 'a' 已修补 ×2");

const retried = fold([
  startEvent(10),
  call(10, 'c1', 'learn_skill_manage', { action: 'update', name: 'a' }), result(10, 'c1', true),
  call(10, 'c2', 'learn_skill_manage', { action: 'update', name: 'a' }), result(10, 'c2'),
]);
const v10 = publish(retried.state, 10);
eq('a failure then a success stays two entries', v10.value.entries.length, 2);
eq('first is the error', v10.value.entries[0].tone, 'error');
eq('second is the success', v10.value.entries[1].tone, 'success');

// ---------------------------------------------------------------- 5. reads say nothing
const reads = fold([
  startEvent(11),
  call(11, 'c1', 'learn', { action: 'status' }), result(11, 'c1'),
  call(11, 'c2', 'learn', { action: 'list' }), result(11, 'c2'),
  call(11, 'c3', 'learn', { action: 'view', name: 'x' }), result(11, 'c3'),
  call(11, 'c4', 'learn', { action: 'pending' }), result(11, 'c4'),
  call(11, 'c5', 'learn', { action: 'history', name: 'x' }), result(11, 'c5'),
  call(11, 'c6', 'learn', { action: 'doctor' }), result(11, 'c6'),
  call(11, 'c7', 'learn', { action: 'graph' }), result(11, 'c7'),
  call(11, 'c8', 'learn_skill_manage', { action: 'read', name: 'x' }), result(11, 'c8'),
  call(11, 'c9', 'learn_curator', { action: 'status' }), result(11, 'c9'),
  call(11, 'c10', 'learn_curator', { action: 'dry-run' }), result(11, 'c10'),
  call(11, 'c11', 'learn_skills', { query: 'x' }), result(11, 'c11'),
  call(11, 'c12', 'skill', { name: 'x' }), result(11, 'c12'),
]);
eq('pure reads produce no entries', publish(reads.state, 11).value.entries.length, 0);
eq('a turn that only read renders nothing', render(publish(reads.state, 11), 'zh'), null);

// ---------------------------------------------------------------- 6. every reportable action, both outcomes, both languages
const cases = [
  ['learn_skill_manage', { action: 'create', name: 's' }], ['learn_skill_manage', { action: 'update', name: 's' }],
  ['learn_skill_manage', { action: 'delete', name: 's' }], ['learn_skill_manage', { action: 'archive', name: 's' }],
  ['learn', { action: 'note', kind: 'remember-request' }], ['learn', { action: 'note', kind: 'user-correction' }],
  ['learn', { action: 'note', kind: 'user-preference' }], ['learn', { action: 'note', kind: 'durable-fact' }],
  ['learn', { action: 'note', kind: 'technique' }], ['learn', { action: 'note', kind: 'recovered-failure' }],
  ['learn', { action: 'note', kind: 'skill-wrong' }], ['learn', { action: 'note', kind: 'unknown-kind' }],
  ['learn', { action: 'note', kind: 'SKILL_WRONG' }],
  ['learn', { action: 'undo', name: 's' }], ['learn', { action: 'consolidate' }], ['learn', { action: 'organize' }],
  ['learn', { action: 'pin', name: 's' }], ['learn', { action: 'archive', name: 's' }], ['learn', { action: 'restore-pending' }],
  ['learn_review', { action: 'run' }], ['learn_review', { action: 'dry-run' }],
  ['learn_curator', { action: 'run' }], ['learn_curator', { action: 'pause' }], ['learn_curator', { action: 'resume' }],
];
let rendered = 0;
for (const [tool, args] of cases) {
  for (const isError of [false, true]) {
    const events = [startEvent(20), call(20, 'x', tool, args)];
    if (isError) events.push(result(20, 'x', true)); else events.push(result(20, 'x'));
    const state = fold(events).state;
    const value = publish(state, 20);
    eq(`${tool} ${args.action}${isError ? ' (failed)' : ''} produced one entry`, value.value.entries.length, 1);
    for (const lang of ['zh', 'en']) {
      const line = texts(render(value, lang))[2];
      ok(`${tool} ${args.action}${isError ? ' (failed)' : ''} renders in ${lang}`, typeof line === 'string' && line.length > 0, String(line));
      ok(`${tool} ${args.action} in ${lang} interpolated the name`, !String(line).includes('{name}'), String(line));
      rendered += 1;
    }
  }
}
eq('every case rendered', rendered, cases.length * 4);

// ---------------------------------------------------------------- 7. hostile input
const hostile = fold([
  startEvent(30),
  call(30, 'c1', 'learn_skill_manage', '{ not json'),
  result(30, 'c1'),
  call(30, 'c2', 'learn', 'null'),
  result(30, 'c2'),
  call(30, 'c3', 'learn', { action: 'note' }),
  result(30, 'c3'),
  call(30, 'c4', 'learn_skill_manage', { action: 'create' }),
  result(30, 'c4'),
  { type: 'tool/result', data: { turn: 30, message: { source: { callId: 'never-seen' } } } },
  { type: 'tool/result', data: { turn: 30 } },
]);
const v30 = publish(hostile.state, 30);
eq('unparsable arguments produce no entry and do not throw', v30.value.entries.length, 2);
eq('a note with no kind falls back', v30.value.entries[0].key, 'note.plain');
eq('a named verb with no name falls back', v30.value.entries[1].key, 'skill.create');
eq('the unnamed fallback is spelled out', texts(render(v30, 'zh'))[4], "技能 '未命名' 已创建");
eq('the unnamed fallback in en', texts(render(v30, 'en'))[4], "skill 'unnamed' created");

// The host hands over whatever the model emitted. None of these may crash the fold or
// invent an entry; `isRecord` plus optional-chained reads make every one of them total.
const oddPayloads = ['null', '[1,2,3]', '"a string"', '42', 'true', 'undefined', '', '{}', '{"action":null}'];
for (const payload of oddPayloads) {
  for (const tool of ['learn', 'learn_skill_manage', 'learn_review', 'learn_curator']) {
    const state = fold([startEvent(31), call(31, 'x', tool, payload), result(31, 'x')]).state;
    eq(`${tool} with payload ${JSON.stringify(payload)} earns no line`, publish(state, 31).value.entries.length, 0);
  }
}
const oddObject = fold([startEvent(32), call(32, 'x', 'learn', JSON.stringify({ action: 'bogus' })), result(32, 'x')]).state;
eq('an unrecognized action earns no line', publish(oddObject, 32).value.entries.length, 0);

// ---------------------------------------------------------------- 8. match discipline
eq('match ignores other events', definition.match({ type: 'message/delta', data: { turn: 1 } }), null);
eq('match ignores a turn without a number', definition.match({ type: 'turn/start', data: {} }), null);
eq('match ignores an event without data', definition.match({ type: 'turn/start' }), null);
const m1 = definition.match(startEvent(4));
eq('turn/start is a start match', m1.role, 'start');
eq('the context id is the turn as a string', m1.id, '4');
eq('tool/call is an update match', definition.match(call(4, 'a', 'learn', { action: 'status' })).role, 'update');
eq('tool/result is an update match', definition.match(result(4, 'a')).role, 'update');
const noStart = fold([call(40, 'c1', 'learn_skill_manage', { action: 'create', name: 's' }), result(40, 'c1')]);
eq('a call with no turn/start in the window does not throw or start a context', noStart.started, false);
eq('and publishes nothing', publish(noStart.state, 40), null);

// ---------------------------------------------------------------- 9. two turns do not bleed
const a = fold([startEvent(50), call(50, 'c1', 'learn_skill_manage', { action: 'create', name: 'a' }), result(50, 'c1')]);
const b = fold([startEvent(51), call(51, 'c2', 'learn_skill_manage', { action: 'create', name: 'b' }), result(51, 'c2')]);
ok('each turn folds its own state', a.state !== b.state);
eq('turn 50 sees only its own entry', publish(a.state, 50).value.entries.length, 1);
eq('turn 50 entry is its own', publish(a.state, 50).value.entries[0].name, 'a');

// ------------------------------------------------- 10. a refusal is not a success
//
// The audit that produced this section measured the live session log: a refused
// `learn action=note` and a successful one BOTH arrive with `isError=false`. If the recap
// only reads `isError`, the one case the user needs to see — the gate refused the lesson —
// renders as the green "记住一条做法" line. These assertions pin the refusal path, and the
// first one pins the marker itself against the module that writes it, so the two files
// cannot drift apart without a red test.
const toolsSource = readFileSync(join(HERE, '..', 'lib', 'tools.js'), 'utf8');
const clientSource = readFileSync(TARGET, 'utf8');
const refusedLiteral = /\[`(未写入)：\$\{result\.reason\}`/.exec(toolsSource)?.[1];
ok('lib/tools.js still writes a stable refusal marker', typeof refusedLiteral === 'string' && refusedLiteral.length > 0);
const clientMarker = /const REFUSED_PREFIX = '([^']+)'/.exec(clientSource)?.[1];
eq('and the recap reads the same marker', clientMarker, refusedLiteral);

const refusedTurn = fold([
  startEvent(60),
  call(60, 'c1', 'learn', { action: 'note', kind: 'technique', statement: '把 Tee-Object 接在 Select-Object 后面' }),
  result(60, 'c1', false, '未写入：缺少可迁移的做法或具体对象（不是一条能照做的规则）\n门槛明细：general=ok；actionable=这条不合格'),
]);
const refusedValue = publish(refusedTurn.state, 60);
const refusedLine = texts(render(refusedValue, 'zh')).join(' ');
ok('a refused note renders as a refusal, not as a write', !refusedLine.includes('记住一条做法'), { line: refusedLine });
ok('and it says the rule was not saved', refusedLine.includes('做法没能记下'), { line: refusedLine });
eq('a refusal is amber, not green', refusedValue.value.entries[0].tone, 'warn');
eq('and it is still one entry', refusedValue.value.entries.length, 1);
ok('the English copy is a refusal too', texts(render(refusedValue, 'en')).join(' ').includes('could not save the technique'));

const wroteTurn = fold([
  startEvent(61),
  call(61, 'c1', 'learn', { action: 'note', kind: 'technique', statement: '有效做法：先用 `node --check` 再提交' }),
  result(61, 'c1', false, '已写入 tool-recovery 的规则 1xe1nh6：有效做法：先用 `node --check` 再提交'),
]);
const wroteValue = publish(wroteTurn.state, 61);
ok('a note that landed still renders as a write', texts(render(wroteValue, 'zh')).join(' ').includes('记住一条做法'));
eq('and it stays green', wroteValue.value.entries[0].tone, 'success');
eq('and it is not marked failed', wroteValue.value.entries[0].failed, false);

// A refused write and a successful one are two facts, even when the sentence matches.
const mixedTurn = fold([
  startEvent(62),
  call(62, 'c1', 'learn_skill_manage', { action: 'update', name: 'tool-recovery' }),
  result(62, 'c1', false, '未写入：规则缩水'),
  call(62, 'c2', 'learn_skill_manage', { action: 'update', name: 'tool-recovery' }),
  result(62, 'c2', false, '已写入 tool-recovery'),
]);
const mixedValue = publish(mixedTurn.state, 62);
eq('a refused write and a successful one are two entries', mixedValue.value.entries.length, 2);
eq('the refusal keeps the failed sentence', texts(render(mixedValue, 'zh')).join(' ').includes('修补失败'), true);

// ------------------------------------------------- 11. delete says which delete it was
const softDelete = fold([
  startEvent(70),
  call(70, 'c1', 'learn_skill_manage', { action: 'delete', name: 'old-skill' }),
  result(70, 'c1', false, '已删除，但先把整份技能留在了归档里'),
]);
const softLine = texts(render(publish(softDelete.state, 70), 'zh')).join(' ');
ok('an unconfirmed delete does not claim the copy is gone', !softLine.includes('永久删除'), { line: softLine });
ok('it says the archive still has one', softLine.includes('归档里还留着一份'), { line: softLine });

const hardDelete = fold([
  startEvent(71),
  call(71, 'c1', 'learn_skill_manage', { action: 'delete', name: 'old-skill', confirm: true }),
  result(71, 'c1', false, '已删除'),
]);
const hardLine = texts(render(publish(hardDelete.state, 71), 'zh')).join(' ');
ok('a confirmed delete does say it is for good', hardLine.includes('永久删除'), { line: hardLine });
ok('and the English copy distinguishes them as well', texts(render(publish(softDelete.state, 70), 'en')).join(' ').includes('stays in the archive'));

// ---------------------------------------------------------------- report
console.log(`${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all green');
}
