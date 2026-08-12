'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_NAME = 'register-generated-program';
// Exact digest of LLMPET's pre-consent, shared skill. It is safe to migrate;
// any other differing skill is treated as user-owned and never overwritten.
const LEGACY_SKILL_DIGEST = 'a2086bdc8d3c16c641054426ed563649bfed1b9ad802b52708c0db1adda9d249';
const LEGACY_OPENAI_YAML_DIGEST = 'ed320914db24b3ffaac7de5f5e51c20c5c7d4b00f962d142207731e936de9501';

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

function copyAtomic(source, target, mode = 0o600) {
  const body = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body, { mode });
  fs.renameSync(temp, target);
  fs.chmodSync(target, mode);
  return target;
}

function providerSpec(root, home, provider) {
  if (provider === 'codex') {
    return {
      provider,
      label: 'Codex',
      source: path.join(root, '.agents', 'skills', SKILL_NAME),
      target: path.join(home, '.agents', 'skills', SKILL_NAME),
      files: ['SKILL.md', path.join('agents', 'openai.yaml')],
    };
  }
  if (provider === 'claude') {
    return {
      provider,
      label: 'Claude Code',
      source: path.join(root, '.claude', 'skills', SKILL_NAME),
      target: path.join(home, '.claude', 'skills', SKILL_NAME),
      files: ['SKILL.md'],
    };
  }
  throw new Error(`unsupported provider: ${provider}`);
}

function compareSpec(spec) {
  const installedSkill = readMaybe(path.join(spec.target, 'SKILL.md'));
  if (!installedSkill) return { state: 'not-installed', installed: false };
  const sourceSkill = fs.readFileSync(path.join(spec.source, 'SKILL.md'));
  if (installedSkill.equals(sourceSkill)) {
    for (const relative of spec.files.slice(1)) {
      const current = readMaybe(path.join(spec.target, relative));
      const source = readMaybe(path.join(spec.source, relative));
      if (!current) return { state: 'update-available', installed: true };
      if (digest(current) === LEGACY_OPENAI_YAML_DIGEST) return { state: 'update-available', installed: true };
      if (!source || !current.equals(source)) return { state: 'conflict', installed: true };
    }
    return { state: 'installed', installed: true };
  }
  if (digest(installedSkill) === LEGACY_SKILL_DIGEST) {
    if (spec.provider === 'codex') {
      const metadata = readMaybe(path.join(spec.target, 'agents', 'openai.yaml'));
      if (metadata && digest(metadata) !== LEGACY_OPENAI_YAML_DIGEST) return { state: 'conflict', installed: true };
    }
    return { state: 'update-available', installed: true };
  }
  return { state: 'conflict', installed: true };
}

function createProgramSkillManager(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const home = options.home || os.homedir();

  function statusFor(provider) {
    const spec = providerSpec(root, home, provider);
    const compared = compareSpec(spec);
    return {
      provider,
      label: spec.label,
      skillName: SKILL_NAME,
      target: spec.target,
      ...compared,
    };
  }

  function status() {
    return ['codex', 'claude'].map(statusFor);
  }

  function install(provider) {
    const spec = providerSpec(root, home, provider);
    const before = compareSpec(spec);
    if (before.state === 'conflict') {
      return { ok: false, code: 'conflict', ...statusFor(provider) };
    }
    for (const relative of spec.files) {
      copyAtomic(path.join(spec.source, relative), path.join(spec.target, relative));
    }
    // The legacy shared installer copied Codex-only UI metadata into Claude's
    // tree. Remove that exact managed artifact during the Claude migration.
    if (provider === 'claude') {
      const legacyMetadata = path.join(spec.target, 'agents', 'openai.yaml');
      const current = readMaybe(legacyMetadata);
      if (current && digest(current) === LEGACY_OPENAI_YAML_DIGEST) fs.rmSync(legacyMetadata, { force: true });
      try { if (fs.readdirSync(path.dirname(legacyMetadata)).length === 0) fs.rmdirSync(path.dirname(legacyMetadata)); } catch {}
    }
    const registrar = copyAtomic(
      path.join(root, 'scripts', 'register-generated-program.js'),
      path.join(home, '.octopus', 'bin', 'register-generated-program.js'),
      0o700,
    );
    copyAtomic(
      path.join(root, 'backend', 'program-registry.js'),
      path.join(home, '.octopus', 'lib', 'program-registry.js'),
    );
    return { ok: true, code: before.state === 'update-available' ? 'updated' : 'installed', registrar, ...statusFor(provider) };
  }

  function remove(provider) {
    const spec = providerSpec(root, home, provider);
    const before = compareSpec(spec);
    if (before.state === 'conflict') {
      return { ok: false, code: 'conflict', ...statusFor(provider) };
    }
    if (before.state === 'not-installed') return { ok: true, code: 'not-installed', ...statusFor(provider) };
    // Remove only files shipped by LLMPET. Leave any unrelated files in the
    // directory alone instead of assuming ownership of the whole folder.
    if (before.state === 'update-available' && provider === 'claude') {
      const legacyMetadata = path.join(spec.target, 'agents', 'openai.yaml');
      const current = readMaybe(legacyMetadata);
      if (current && digest(current) === LEGACY_OPENAI_YAML_DIGEST) fs.rmSync(legacyMetadata, { force: true });
    }
    for (const relative of spec.files) {
      const file = path.join(spec.target, relative);
      const current = readMaybe(file);
      const source = readMaybe(path.join(spec.source, relative));
      const managedLegacy = relative === 'SKILL.md'
        ? current && digest(current) === LEGACY_SKILL_DIGEST
        : current && digest(current) === LEGACY_OPENAI_YAML_DIGEST;
      if (current && ((source && current.equals(source)) || managedLegacy)) fs.rmSync(file, { force: true });
    }
    const agentsDir = path.join(spec.target, 'agents');
    try { if (fs.readdirSync(agentsDir).length === 0) fs.rmdirSync(agentsDir); } catch {}
    try { if (fs.readdirSync(spec.target).length === 0) fs.rmdirSync(spec.target); } catch {}
    return { ok: true, code: 'removed', ...statusFor(provider) };
  }

  return { status, statusFor, install, remove };
}

module.exports = { LEGACY_OPENAI_YAML_DIGEST, LEGACY_SKILL_DIGEST, SKILL_NAME, createProgramSkillManager };
