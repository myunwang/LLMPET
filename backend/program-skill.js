'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function copyIfChanged(source, target, mode) {
  const body = fs.readFileSync(source);
  let current = null;
  try { current = fs.readFileSync(target); } catch {}
  if (!current || !current.equals(body)) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body, { mode: mode || 0o600 });
    fs.renameSync(temp, target);
  }
  if (mode) fs.chmodSync(target, mode);
  return target;
}

function installProgramSkill(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const home = options.home || os.homedir();
  const source = options.source || path.join(root, '.agents', 'skills', 'register-generated-program');
  const targets = options.targets || [
    path.join(home, '.agents', 'skills', 'register-generated-program'),
    path.join(home, '.claude', 'skills', 'register-generated-program'),
  ];
  const files = ['SKILL.md', path.join('agents', 'openai.yaml')];
  for (const target of targets) {
    for (const relative of files) {
      const from = path.join(source, relative);
      if (fs.existsSync(from)) copyIfChanged(from, path.join(target, relative));
    }
  }

  const binDir = path.join(home, '.octopus', 'bin');
  const libDir = path.join(home, '.octopus', 'lib');
  const registrar = copyIfChanged(
    path.join(root, 'scripts', 'register-generated-program.js'),
    path.join(binDir, 'register-generated-program.js'),
    0o700,
  );
  copyIfChanged(
    path.join(root, 'backend', 'program-registry.js'),
    path.join(libDir, 'program-registry.js'),
    0o600,
  );
  return { registrar, targets };
}

module.exports = { copyIfChanged, installProgramSkill };
