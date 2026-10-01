/**
 * Push this tree to GitHub through the REST API.
 *
 * `github.com`'s git transport is unreachable from this machine while
 * `api.github.com` answers, so `git push` is not an option here. This is the
 * replacement: build one blob per file, assemble a tree, commit, move the ref.
 *
 *   set GITHUB_TOKEN=...            (or: $env:GITHUB_TOKEN = gh auth token)
 *   node scripts/publish-github.mjs [--repo owner/name] [--branch main]
 *                                   [--message "…"] [--dry-run]
 *
 * ── Why blobs, and not the tree API's inline `content` ──────────────────────
 * `POST /git/trees` accepts a `content` field on each entry, and it looks like
 * it would save 31 round trips. It does not encode anything: whatever string
 * you put there is written to the blob as UTF-8 bytes. Text survives that by
 * accident. Base64 does not — a PNG sent that way lands in the repository as
 * 71 KB of ASCII characters, `README.md` renders a broken image, and nothing
 * in the API response says so. The first publication of this plugin did exactly
 * that and every one of the 31 files had to be pushed a second time.
 *
 * `POST /git/blobs` has a real `encoding: 'base64'` parameter and honours it,
 * so binary files go through it unchanged. That is the only path used here.
 *
 * Idempotent in the useful sense: a file whose blob already exists costs one
 * request and no new object, because blob SHAs are content-addressed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the repository ships. Local-only helpers stay out on purpose. */
const INCLUDE = [
  '.gitignore',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'package.json',
  'screenshots.json',
  'docs/make-shots.py',
];

// An allow-list, not a deny-list: this directory also collects throwaway probes
// from unrelated work (launch-probe, loc-probe) and one-shot data repairs
// (cleanup-v010, asar-inspect). A deny-list silently ships the next one.
const PUBLISHED_SCRIPTS = ['selftest.mjs', 'replay-session.mjs', 'purge-noise.mjs', 'publish-github.mjs'];

const GLOBS = [
  ['lib', (name) => name.endsWith('.js')],
  ['scripts', (name) => PUBLISHED_SCRIPTS.includes(name)],
  ['docs/shots', (name) => name.endsWith('.png')],
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const repo = arg('repo', 'xiex16070-jpg/dsh-learn');
const branch = arg('branch', 'main');
const message = arg('message', 'Publish dsh-learn');
const dryRun = process.argv.includes('--dry-run');
const token = process.env.GITHUB_TOKEN;

function fileList() {
  const files = [...INCLUDE];
  for (const [dir, keep] of GLOBS) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (!keep(name)) continue;
      if (!statSync(join(root, dir, name)).isFile()) continue;
      files.push(`${dir}/${name}`);
    }
  }
  return files;
}

const API = 'https://api.github.com';

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-learn-publisher',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' ? body.message : String(body).slice(0, 200);
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${detail}`);
  }
  return body;
}

const files = fileList();
const entries = [];
let uploaded = 0;

for (const rel of files) {
  const bytes = readFileSync(join(root, rel.split('/').join(sep)));
  if (dryRun) {
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: '(dry-run)' });
    console.log(`  would upload ${rel} (${bytes.length} B)`);
    continue;
  }
  const blob = await call(`/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
  });
  entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  uploaded += 1;
}

if (dryRun) {
  console.log(`${files.length} files would be uploaded to ${repo}#${branch}`);
  process.exit(0);
}

const head = await call(`/repos/${repo}/git/ref/heads/${branch}`).then((r) => r.object.sha);
const tree = await call(`/repos/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: entries }),
});
const commit = await call(`/repos/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [head] }),
});
await call(`/repos/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha }),
});

console.log(`${uploaded} blobs → tree ${tree.sha.slice(0, 10)} → commit ${commit.sha.slice(0, 10)} on ${repo}#${branch}`);
console.log(`https://github.com/${repo}/commit/${commit.sha}`);
