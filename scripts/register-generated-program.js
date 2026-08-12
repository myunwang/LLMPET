#!/usr/bin/env node
'use strict';

const path = require('path');

function loadRegistry() {
  const candidates = [
    path.join(__dirname, '..', 'backend', 'program-registry'),
    path.join(__dirname, '..', 'lib', 'program-registry'),
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) {
      if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('LLMPET program registry is not installed. Start LLMPET once, then retry.');
}

const { registerProgram } = loadRegistry();

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write('Usage:\n');
  process.stderr.write('  node scripts/register-generated-program.js --verified --name NAME --cwd DIR --command CMD [--arg ARG ...] [--provider codex|claude]\n');
  process.stderr.write('  node scripts/register-generated-program.js --verified --name NAME --cwd DIR --open PATH [--icon PATH] [--description TEXT]\n');
  process.exit(message ? 1 : 0);
}

function parse(argv) {
  const out = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--verified') { out.verified = true; continue; }
    if (key === '--arg') { out.args.push(argv[++i]); continue; }
    if (key === '--name' || key === '--cwd' || key === '--command' || key === '--open' || key === '--provider' || key === '--description' || key === '--icon') {
      out[key.slice(2)] = argv[++i];
      continue;
    }
    if (key === '--help' || key === '-h') usage();
    usage(`Unknown argument: ${key}`);
  }
  return out;
}

try {
  const input = parse(process.argv.slice(2));
  if (!input.verified) usage('Refusing to register an unverified program. Launch it successfully first, then pass --verified.');
  if (!input.name || !input.cwd) usage('--name and --cwd are required.');
  if (!!input.command === !!input.open) usage('Provide exactly one of --command or --open.');
  const record = registerProgram({
    name: input.name,
    description: input.description,
    cwd: input.cwd,
    icon: input.icon,
    provider: input.provider,
    verifiedAt: Date.now(),
    launch: input.open
      ? { type: 'open', target: input.open }
      : { type: 'command', command: input.command, args: input.args, terminal: true },
  }, { statePath: process.env.LLMPET_PROGRAM_REGISTRY || undefined });
  process.stdout.write(JSON.stringify({ ok: true, program: record }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`Registration failed: ${error.message}\n`);
  process.exit(1);
}
