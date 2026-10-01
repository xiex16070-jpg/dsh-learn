/**
 * Skill file I/O — the second half of the write funnel.
 *
 * Root layout: learned skills live in their OWN root, `<dshHome>/skills/learned`,
 * registered with the host as a `customSkillDirs` entry. That was the only way
 * to satisfy "gather them into a folder" without breaking discovery: the host's
 * filesystem provider scans exactly one level deep (`isPotentialSkillPath()`
 * rejects `segments.length > 2`), so `<skills>/learned/<name>/SKILL.md` would be
 * invisible. A separate root keeps the one-level contract intact and gets
 * `CUSTOM_RANK = 300`, above the default `user-dsh` root at 400.
 *
 * Every write goes through `screenSkillBody`. A caller cannot opt out: this is
 * where bytes land, and a learned skill is loaded into every future session.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { screenSkillBody, screenDescription, escapeBraces, MAX_DESCRIPTION_CHARS } from './sanitize.js';

/**
 * The HOST's authoritative skill-name rule, copied verbatim from
 * `@deepseek-ai/dsh-skill` (`const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
 *
 * This must not be relaxed to "look reasonable": a name this plugin accepts but
 * the host rejects gets written to disk and then silently ignored by the
 * catalog, and the skill looks saved while being invisible. Underscores, dots,
 * leading/trailing hyphens and doubled hyphens are all invalid upstream.
 */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME_CHARS = 63;
/** The host's real catalog budget; overshooting it is reported, never silent. */
export const DESCRIPTION_LIMIT = MAX_DESCRIPTION_CHARS;
export const LEARNED_SUBDIR = 'learned';

const RULE_MARKER = '## 规则';

/** Whether the host would actually advertise a skill under this name. */
export function isLegalName(name) {
  const value = String(name ?? '');
  return NAME_RE.test(value) && value.length <= MAX_NAME_CHARS;
}

export function nameRefusal(name) {
  return `技能名不合法：${JSON.stringify(name)}（宿主只接受小写字母/数字，段落之间用单个 "-"，且以字母或数字开头结尾；见 @deepseek-ai/dsh-skill 的 SKILL_NAME。别的名字宿主不会报错，只会静默忽略这个技能）`;
}

export function slugify(text, { fallback = 'learned-skill' } = {}) {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/g, '');
  return slug && NAME_RE.test(slug) ? slug : fallback;
}

function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '' || /[:#\-?*&!|>%@`"'\[\]{}]/.test(text) || /^\s|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1).replace(/''/g, "'");
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

export function parseFrontmatter(text) {
  const source = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    meta[kv[1]] = unquote(kv[2]);
  }
  return { meta, body: source.slice(match[0].length) };
}

/**
 * Clip a description to the host's budget. Returns whether clipping happened so
 * the tool can say so: the old silent 60-char chop removed the routing words
 * that are the whole reason a description exists.
 */
export function fitDescription(value, limit = DESCRIPTION_LIMIT) {
  const screened = screenDescription(value, limit);
  let text = screened.text;
  let clipped = false;
  if (text.length > limit) {
    text = `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
    clipped = true;
  }
  return { text, clipped, length: text.length, requested: screened.length, limit, issues: screened.issues };
}

export function buildSkillFile({ name, description, body, meta = {} }) {
  const fit = fitDescription(description);
  const lines = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(fit.text)}`];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || key === 'name' || key === 'description') continue;
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push('---', '');
  const screened = screenSkillBody(body);
  return { text: `${lines.join('\n')}${screened.text}\n`, fit, issues: screened.issues, refused: screened.refused };
}

export function buildSkillBody({ title, description, rules = [], sections = [] }) {
  const parts = [`# ${title || 'Learned skill'}`, ''];
  if (description) parts.push(description, '');
  for (const section of sections) {
    if (!section || !section.body) continue;
    parts.push(`## ${section.title || 'Notes'}`, '', String(section.body).trim(), '');
  }
  if (rules.length) {
    parts.push(RULE_MARKER, '');
    for (const rule of rules) parts.push(rule, '');
  }
  return parts.join('\n').trimEnd();
}

export function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const words = source.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,4}/g) || [];
  return words.filter((word) => word.length > 1 || /[\u4e00-\u9fff]/.test(word));
}

/** Stable id for a rule, used for anchors and the undo path. */
export function ruleId(seed) {
  const tokens = tokenize(seed).slice(0, 24).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < tokens.length; i += 1) {
    hash ^= tokens.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, '0').slice(0, 10);
}

function copyDir(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

export function createSkills({ root, legacyRoot = null, protectedNames = [] }) {
  // `root` is the learned directory itself. Accept either `<skills>` or
  // `<skills>/learned` so a caller cannot accidentally build `<skills>/learned/learned`
  // — the config layer already points at the learned path, and re-appending the
  // segment would hide every skill from the catalog.
  const base = String(root ?? '');
  const learnedDir = base.toLowerCase().endsWith(LEARNED_SUBDIR) ? base : join(base, LEARNED_SUBDIR);
  mkdirSync(learnedDir, { recursive: true });

  // The shared root (`<dshHome>/skills`) is what the host already scans. The
  // dedicated root is its `learned/` subfolder, and the host only sees THAT once
  // the profile patch registers it as a `customSkillDirs` root — the filesystem
  // provider scans exactly one level deep, so an unregistered subfolder is
  // invisible. Until a live probe proves otherwise, `live` stays false and every
  // new skill is written to the shared root: a skill in a folder the host cannot
  // read is indistinguishable from a deleted skill, and "organize my skills"
  // must never cost the user a working skill.
  const flatRoot = legacyRoot ? String(legacyRoot) : null;
  let live = false;

  const activeRoot = () => (live && learnedDir ? learnedDir : flatRoot || learnedDir);
  const roots = () => (live ? [learnedDir, flatRoot] : [flatRoot, learnedDir]);

  const dirFor = (name) => {
    const found = locate(name);
    return found ? found.dir : join(activeRoot(), name);
  };
  const fileFor = (name) => join(dirFor(name), 'SKILL.md');

  /** Where a skill physically is right now, preferring the visible root. */
  function locate(name) {
    for (const rootDir of roots()) {
      if (!rootDir) continue;
      const dir = join(rootDir, name);
      if (existsSync(join(dir, 'SKILL.md'))) return { dir, file: join(dir, 'SKILL.md'), root: rootDir };
    }
    return null;
  }

  const inLearned = (name) => existsSync(join(learnedDir, name, 'SKILL.md'));
  const inFlat = (name) => Boolean(flatRoot && existsSync(join(flatRoot, name, 'SKILL.md')));
  /** Still in the shared root while a dedicated copy is absent: movable. */
  const migratable = (name) => inFlat(name) && !inLearned(name);

  const protectedSet = new Set(protectedNames);

  /** mtime as an ISO string, or '' when the file vanished under us. */
  const safeMtime = (file) => {
    try {
      return statSync(file).mtime.toISOString();
    } catch {
      return '';
    }
  };

  const exists = (name) => locate(name) !== null;
  const existsAnywhere = (name) => exists(name);

  const read = (name) => {
    const found = locate(name);
    if (!found) return null;
    const parsed = parseFrontmatter(readFileSync(found.file, 'utf8'));
    return { name, file: found.file, meta: parsed.meta, body: parsed.body, legacy: !inLearned(name) };
  };

  const list = ({ includeLegacy = true } = {}) => {
    const names = new Set();
    for (const rootDir of [learnedDir, includeLegacy ? flatRoot : null]) {
      if (!rootDir) continue;
      try {
        for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(rootDir, entry.name, 'SKILL.md'))) names.add(entry.name);
        }
      } catch {
        /* empty root */
      }
    }
    return [...names].sort().map((name) => {
      const record = read(name);
      return record
        ? { name, description: record.meta.description || '', file: record.file, legacy: record.legacy, updatedAt: safeMtime(record.file) }
        : null;
    }).filter(Boolean);
  };

  /**
   * Write a skill. Returns `{ ok, file, fit, issues, refused }`; a refusal
   * never touches disk, so a rejected body cannot half-land.
   */
  const write = (name, { description = '', body = '', meta = {} } = {}) => {
    if (!isLegalName(name)) return { ok: false, refused: [nameRefusal(name)] };
    const dir = join(activeRoot(), name);
    if (protectedSet.has(name) && exists(name)) {
      // Protected skills may be rewritten by the plugin itself, never gutted.
      const current = read(name);
      if (!String(body || '').includes(RULE_MARKER) && current && current.body.includes(RULE_MARKER)) {
        return { ok: false, refused: [`${name} 是常驻技能，写入必须保留「${RULE_MARKER}」段，否则会丢掉已学规则`] };
      }
    }
    const built = buildSkillFile({ name, description, body, meta });
    if (built.refused.length) return { ok: false, refused: built.refused, issues: built.issues };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), built.text, 'utf8');
    return { ok: true, file: join(dir, 'SKILL.md'), fit: built.fit, issues: built.issues, refused: [] };
  };

  /** Move a legacy skill into the learned root, preserving its content. */
  const adoptIntoRoot = (name) => {
    if (!flatRoot) return { ok: false, reason: '未配置旧技能根' };
    const source = join(flatRoot, name);
    const target = join(learnedDir, name);
    if (!existsSync(join(source, 'SKILL.md'))) return { ok: false, reason: `旧根里没有 ${name}` };
    if (existsSync(target)) return { ok: false, reason: `目标已存在：${target}` };
    try {
      mkdirSync(learnedDir, { recursive: true });
      try {
        renameSync(source, target);
      } catch {
        // Cross-device or locked: copy then remove, so the skill survives.
        copyDir(source, target);
        rmSync(source, { recursive: true, force: true });
      }
    } catch (error) {
      return { ok: false, reason: `迁移失败：${error && error.message ? error.message : error}` };
    }
    return { ok: true, from: source, to: target, file: join(target, 'SKILL.md') };
  };

  /**
   * Archive = move out of the live root into the plugin's archive directory.
   * Never a delete; a bad archive is recoverable by moving the directory back.
   */
  const archive = (name, { archiveDir, adopt = false, managed = () => false } = {}) => {
    if (!isLegalName(name)) return { ok: false, reason: nameRefusal(name) };
    if (protectedSet.has(name)) {
      return { ok: false, reason: `${name} 在受保护名单里（插件自身的常驻技能），不能归档` };
    }
    const found = locate(name);
    if (!found) return { ok: false, reason: `技能不存在：${name}` };
    const dir = found.dir;
    if (!managed(name) && !adopt) {
      return { ok: false, reason: `${name} 不在 managed.json 里（不是本插件创建的技能）。共享技能根里的其他技能不会被自动流程碰；确要归档请显式 adopt=true` };
    }
    if (!archiveDir) return { ok: false, reason: '未提供归档目录' };
    mkdirSync(archiveDir, { recursive: true });
    let target = join(archiveDir, name);
    if (existsSync(target)) target = `${target}-${Date.now().toString(36)}`;
    try {
      try {
        renameSync(dir, target);
      } catch {
        copyDir(dir, target);
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      return { ok: false, reason: `归档失败：${error && error.message ? error.message : error}` };
    }
    return { ok: true, from: dir, to: target, adopted: !managed(name) };
  };

  const remove = (name, { managed = () => false, adopt = false } = {}) => {
    if (protectedSet.has(name)) return { ok: false, reason: `${name} 在受保护名单里，不能删除` };
    const found = locate(name);
    if (!found) return { ok: false, reason: `技能不存在：${name}` };
    const dir = found.dir;
    if (!managed(name) && !adopt) {
      return { ok: false, reason: `${name} 不是本插件创建的技能（不在 managed.json）。删除是不可逆的，确要删除请显式 adopt=true` };
    }
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, dir };
  };

  /**
   * Remove the shared-root copy of a skill that now also lives in the dedicated
   * root. Only ever called for a skill this plugin owns: the dedicated copy is
   * authoritative, and leaving both would let the older one shadow it.
   */
  const dropFlatCopy = (name) => {
    if (!flatRoot) return { ok: false, reason: '未配置共享技能根' };
    const dir = join(flatRoot, name);
    if (!existsSync(join(dir, 'SKILL.md'))) return { ok: false, reason: `共享根里没有 ${name}` };
    if (!inLearned(name)) return { ok: false, reason: `专用目录里没有 ${name} 的副本，不能删共享根里的那份` };
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, reason: `移除共享根副本失败：${error && error.message ? error.message : error}` };
    }
    return { ok: true, dir };
  };

  const stage = (name, text) => {
    const dir = join(root, 'staging');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, text, 'utf8');
    return file;
  };

  const search = (query, { limit = 10 } = {}) => {
    const tokens = new Set(tokenize(query));
    if (!tokens.size) return [];
    const scored = [];
    for (const entry of list()) {
      const record = read(entry.name);
      if (!record) continue;
      const haystack = new Set(tokenize(`${record.meta.description || ''} ${record.body}`));
      let overlap = 0;
      for (const token of tokens) if (haystack.has(token)) overlap += 1;
      if (overlap > 0) scored.push({ name: entry.name, score: overlap / tokens.size, description: record.meta.description || '' });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  };

  // ------------------------------------------------------------- rule helpers
  /** Split the `## 规则` section into individual bullet rules. */
  const readRules = (name) => {
    const record = read(name);
    if (!record) return [];
    const index = record.body.indexOf(RULE_MARKER);
    if (index === -1) return [];
    const section = record.body.slice(index + RULE_MARKER.length);
    const stop = section.search(/\n##\s/);
    const text = stop === -1 ? section : section.slice(0, stop);
    const rules = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
      const body = line.slice(2).trim();
      const anchor = /<!--\s*(?:r:)?([A-Za-z0-9_-]+)\s*-->/.exec(body);
      rules.push({ id: anchor ? anchor[1] : ruleId(body), text: body.replace(/<!--[\s\S]*?-->/g, '').trim(), raw: line });
    }
    return rules;
  };

  /**
   * Remove one rule by id, leaving the rest of the file (and other sections)
   * untouched. This is what makes a single learning undoable instead of the
   * user having to hand-edit an always-on file.
   */
  const removeRule = (name, id) => {
    const record = read(name);
    if (!record) return { ok: false, reason: `技能不存在：${name}` };
    const rules = readRules(name);
    const target = rules.find((rule) => rule.id === id);
    if (!target) return { ok: false, reason: `没找到规则 ${id}（现有：${rules.map((r) => r.id).join(', ') || '无'}）` };
    const lines = record.body.split('\n');
    const at = lines.findIndex((line) => line.trim() === target.raw);
    if (at === -1) return { ok: false, reason: `规则 ${id} 在文件中已变化，未改动` };
    lines.splice(at, 1);
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    const written = write(name, { description: record.meta.description || '', body, meta: metaOf(record) });
    if (!written.ok) return { ok: false, reason: written.refused.join('；') };
    return { ok: true, removed: target, remaining: rules.length - 1 };
  };

  /** Replace one rule's text in place (used by consolidate). */
  const replaceRule = (name, id, nextText) => {
    const record = read(name);
    if (!record) return { ok: false, reason: `技能不存在：${name}` };
    const rules = readRules(name);
    const target = rules.find((rule) => rule.id === id);
    if (!target) return { ok: false, reason: `没找到规则 ${id}` };
    const lines = record.body.split('\n');
    const at = lines.findIndex((line) => line.trim() === target.raw);
    if (at === -1) return { ok: false, reason: `规则 ${id} 在文件中已变化，未改动` };
    lines[at] = `- ${String(nextText).trim()}`;
    const body = lines.join('\n');
    const written = write(name, { description: record.meta.description || '', body, meta: metaOf(record) });
    return written.ok ? { ok: true, from: target, to: nextText } : { ok: false, reason: written.refused.join('；') };
  };

  /** Frontmatter worth preserving across a rewrite. */
  const metaOf = (record) => {
    const keep = ['session', 'learned-at', 'source'];
    const meta = {};
    for (const key of keep) if (record.meta[key]) meta[key] = record.meta[key];
    return meta;
  };

  return {
    root,
    learnedDir,
    legacyRoot: flatRoot,
    activeRoot,
    setLive: (value) => {
      live = value === true;
      return live;
    },
    isLive: () => live,
    inLearned,
    inFlat,
    migratable,
    locate,
    dirFor,
    fileFor,
    exists,
    existsAnywhere,
    read,
    list,
    write,
    adoptIntoRoot,
    dropFlatCopy,
    archive,
    remove,
    stage,
    search,
    readRules,
    removeRule,
    replaceRule,
    tokenize,
    slugify,
    escapeBraces,
    relativeToLearned: (file) => relative(learnedDir, file),
  };
}
