'use strict';

// Lockfile hygiene: package-lock.json must only resolve to PUBLIC registry
// tarball URLs. An internal mirror (npmmirror/taobao/artifactory/private host)
// in the lockfile makes `npm ci` fail on public machines and GitHub Runners —
// exactly the class of breakage this repo shipped once already. Run as part of
// npm test so every platform's CI catches it before release.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lockPath = path.join(__dirname, '..', 'package-lock.json');
const raw = fs.readFileSync(lockPath, 'utf8');

const lock = JSON.parse(raw);

const ALLOWED_HOSTS = new Set(['registry.npmjs.org', 'github.com']);
const FORBIDDEN_PATTERNS = [
  /npmmirror\.com/i,
  /taobao\.(?:com|org)/i,
  /cnpmjs\.org/i,
  /artifactory/i,
  /nexus\./i,
  /\.internal\./i,
  /localhost(?::\d+)?$/i,
];

let checked = 0;
const offenders = [];

function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.resolved === 'string' && node.resolved.startsWith('https://')) {
    checked++;
    let host = '';
    try { host = new URL(node.resolved).hostname; } catch { offenders.push(node.resolved); }
    if (host && !ALLOWED_HOSTS.has(host)) offenders.push(`${host} → ${node.resolved}`);
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(node.resolved)) offenders.push(`${re} matched → ${node.resolved}`);
    }
  }
  for (const key of Object.keys(node)) walk(node[key]);
}

walk(lock);

assert.ok(checked > 0, 'no resolved URLs found in lockfile — is it a real npm lockfile?');
assert.deepStrictEqual(offenders, [], `package-lock.json references non-public registries:\n${offenders.join('\n')}`);

// No stray .npmrc shipping a private registry either.
const npmrcCandidates = [
  path.join(__dirname, '..', '.npmrc'),
  path.join(__dirname, '..', '..', '.npmrc'),
];
for (const p of npmrcCandidates) {
  if (!fs.existsSync(p)) continue;
  const content = fs.readFileSync(p, 'utf8');
  const registryLine = content.split(/\r?\n/).find((l) => /^\s*registry\s*=/i.test(l));
  if (registryLine) {
    assert.ok(
      /registry\.npmjs\.org/i.test(registryLine),
      `.npmrc pins a non-public registry: ${registryLine.trim()}`,
    );
  }
}

console.log(`lockfile hygiene: ${checked} resolved URLs all public (npmjs.org / github.com)`);
