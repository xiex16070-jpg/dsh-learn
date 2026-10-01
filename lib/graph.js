/**
 * The learning ledger's readable shape — "learning made visible".
 *
 * Ported from Hermes's `agent/learning_graph.py`, with one DSH-side upgrade:
 * the Lingshu memory plugin is already installed and exposes its node store on
 * disk, so memory items become first-class nodes here too, and memory→skill
 * edges come from lexical overlap (the same scoring Hermes uses).
 *
 * Output is written to `<dataDir>/learning-graph.json` on every review and on
 * demand from the `learn` tool, so a UI (or a future panel) can read one file
 * instead of re-deriving anything.
 *
 * Node fields are read from live objects — `managed` comes from the sidecar and
 * `useCount` from the usage counters — rather than from frontmatter, which no
 * longer carries ownership at all.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize } from './skills.js';
import { nowIso } from './storage.js';
import { fingerprint } from './text.js';

const SKIP_DIRS = new Set(['.trash', '.archive', 'node_modules', '.git', '.locks', '.hub']);

function readNodeFiles(dir, kind, limit = 60) {
  const out = [];
  try {
    if (!existsSync(dir)) return out;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.md') || name.endsWith('.json'))
      .map((name) => {
        try {
          return { name, mtime: statSync(join(dir, name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    for (const file of files) {
      const text = readFileSync(join(dir, file.name), 'utf8');
      const firstLine = text.split('\n').find((line) => line.trim() && !line.startsWith('---')) || '';
      out.push({
        id: `${kind}:${file.name}`,
        label: firstLine.replace(/^#+\s*/, '').slice(0, 80) || file.name,
        kind,
        body: text.slice(0, 1200),
        mtime: file.mtime,
      });
    }
  } catch {
    /* a missing or unreadable memory store must not break the graph */
  }
  return out;
}

export function createGraph({ config, store, skills, curator, managed, memoryRoot }) {
  const build = ({ persist = true } = {}) => {
    const usage = curator ? curator.usage() : {};
    const snapshot = curator ? curator.snapshot() : { skills: [] };
    const byName = new Map(snapshot.skills.map((row) => [row.name, row]));

    const skillNodes = [];
    for (const skill of skills.list()) {
      const row = byName.get(skill.name) || {};
      const rec = usage[skill.name] || { loads: 0, lastLoadAt: '' };
      const updated = Date.parse(skill.updatedAt || '') || 0;
      const lastLoad = Date.parse(rec.lastLoadAt || '') || 0;
      const lastActivity = Math.max(updated, lastLoad);
      skillNodes.push({
        id: `skill:${skill.name}`,
        label: skill.name,
        kind: 'skill',
        managed: managed ? managed.isManaged(skill.name) : row.managed === true,
        category: 'learned',
        timestamp: lastActivity || null,
        useCount: rec.loads || 0,
        lessons: row.rules || 0,
        pinned: Boolean(row.pinned),
        protected: Boolean(row.protected),
        legacy: Boolean(skill.legacy),
        state: row.pinned ? 'pinned' : row.action === 'stale' ? 'stale' : 'active',
        description: skill.description,
        path: skill.file,
      });
    }

    // Lessons that never became skills stay visible: they are the backlog.
    const lessonNodes = store
      .readLessons()
      .slice(-80)
      .map((lesson, index) => ({
        id: `lesson:${lesson.ruleId || fingerprint(`${lesson.umbrella || ''}:${lesson.rule || lesson.statement || index}`)}`,
        label: String(lesson.rule || lesson.statement || '').slice(0, 80),
        kind: 'lesson',
        category: lesson.umbrella || lesson.kind || 'backlog',
        timestamp: Date.parse(lesson.at || '') || null,
        useCount: lesson.hits || 1,
        state: lesson.umbrella ? 'captured' : 'backlog',
        description: lesson.reason || lesson.statement || '',
      }));

    const pendingNodes = store
      .loadPending()
      .slice(-60)
      .map((item) => ({
        id: `pending:${item.id}`,
        label: String(item.statement || '').slice(0, 80),
        kind: 'pending',
        category: item.umbrella || item.kind || 'backlog',
        timestamp: Date.parse(item.at || '') || null,
        useCount: item.hits || 1,
        state: item.ok ? 'ready' : 'gated',
        description: item.reason || '',
      }));

    const memoryNodes = memoryRoot ? readNodeFiles(memoryRoot, 'memory') : [];

    const nodes = [...skillNodes, ...lessonNodes, ...pendingNodes, ...memoryNodes];
    const edges = [];

    // skill ↔ lesson by lexical overlap (the lesson's own umbrella links it).
    const skillByName = new Map(skillNodes.map((node) => [node.label, node]));
    for (const lesson of lessonNodes) {
      const target = lesson.category && skillByName.get(lesson.category);
      if (target) edges.push({ source: lesson.id, target: target.id, kind: 'captured-by' });
    }

    // memory → skill from token overlap, top 4 per memory node (Hermes parity).
    const skillTokens = skillNodes.map((node) => ({ node, tokens: new Set(tokenize(`${node.label} ${node.description || ''}`)) }));
    for (const memory of memoryNodes) {
      const memTokens = tokenize(memory.body);
      const scored = [];
      for (const { node, tokens } of skillTokens) {
        let overlap = 0;
        for (const token of memTokens) if (tokens.has(token)) overlap += 1;
        const nameHit = memory.body.includes(node.label) ? 6 : 0;
        const score = nameHit + overlap;
        if (score > 0) scored.push({ node, score });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const hit of scored.slice(0, 4)) edges.push({ source: memory.id, target: hit.node.id, kind: 'mentions' });
    }

    const linked = new Set();
    for (const edge of edges) {
      linked.add(edge.source);
      linked.add(edge.target);
    }
    const isolated = nodes.filter((node) => !linked.has(node.id)).length;
    const categories = [...new Set(nodes.map((node) => node.category).filter(Boolean))];

    const graph = {
      builtAt: nowIso(),
      nodes,
      edges,
      clusters: categories.map((category) => ({ category, count: nodes.filter((node) => node.category === category).length })),
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        edges_per_node: nodes.length ? Math.round((edges.length / nodes.length) * 100) / 100 : 0,
        linked_nodes: linked.size,
        isolated_pct: nodes.length ? Math.round((isolated / nodes.length) * 1000) / 10 : 0,
        categories: categories.length,
        managed_skills: skillNodes.filter((node) => node.managed).length,
        skill_nodes: skillNodes.length,
        lesson_nodes: lessonNodes.length,
        pending_nodes: pendingNodes.length,
        memory_nodes: memoryNodes.length,
        memory_skill_edges: edges.filter((edge) => edge.kind === 'mentions').length,
        used_skills: skillNodes.filter((node) => node.useCount > 0).length,
      },
    };

    if (persist) {
      try {
        store.writeAtomic(join(store.dirs.root, 'learning-graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
      } catch (error) {
        store.warn('learning-graph write failed', error);
      }
    }
    return graph;
  };

  return { build, get file() { return join(store.dirs.root, 'learning-graph.json'); } };
}

export { SKIP_DIRS };
