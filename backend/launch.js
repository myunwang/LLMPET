'use strict';

// Open a new OS terminal running the `claude` CLI (original implementation).
//
// The pet's left-click / tray "唤起 Claude" starts a fresh session. We locate
// the claude binary (Claude Code runs us with a normal PATH here, but we also
// probe common install dirs), then hand a terminal a command string to run.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CLI 名 → 各平台常见安装位置（PATH 探测兜底）。codex 与 claude 同一套逻辑。
const CLI_DIRS = {
  claude: (home) => [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ],
  codex: (home) => [
    path.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
};

function findCli(name) {
  const plat = process.platform;
  if (plat === 'win32') {
    try {
      const out = execFileSync('where', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line) return line;
    } catch {}
    return name;
  }
  const dirs = CLI_DIRS[name] ? CLI_DIRS[name](os.homedir()) : [];
  for (const c of dirs) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lic', `command -v ${name} 2>/dev/null`], { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('/')).pop();
    if (line) return line;
  } catch {}
  return name;
}

function findClaude() { return findCli('claude'); }

const posixQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function trySpawn(bin, args, opts) {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

// candidates: ordered [bin, args] terminal launchers for this platform.
function buildCandidates(cli, workDir) {
  const plat = process.platform;
  if (plat === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${appleEscape(posixQuote(workDir))} && ${appleEscape(cli)}"`;
    return [['osascript', ['-e', script]]];
  }
  if (plat === 'win32') {
    return [
      ['wt.exe', ['--', 'cmd.exe', '/k', `cd /d "${workDir}" && "${cli}"`]],
      ['cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `cd /d "${workDir}" && "${cli}"`]],
    ];
  }
  const run = `cd ${posixQuote(workDir)}; ${posixQuote(cli)}; exec ${process.env.SHELL || 'bash'}`;
  return [
    ['x-terminal-emulator', ['-e', `bash -lc ${posixQuote(run)}`]],
    ['gnome-terminal', ['--', 'bash', '-lc', run]],
    ['konsole', ['-e', `bash -lc ${posixQuote(run)}`]],
    ['xterm', ['-e', `bash -lc ${posixQuote(run)}`]],
  ];
}

async function launchCli(name, opts = {}) {
  const cli = findCli(name);
  const workDir = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  for (const [bin, args] of buildCandidates(cli, workDir)) {
    // eslint-disable-next-line no-await-in-loop
    if (await trySpawn(bin, args, { cwd: workDir })) return { ok: true, terminal: bin };
  }
  return { ok: false, message: 'could not open a terminal' };
}

const launchClaude = (opts = {}) => launchCli('claude', opts);
const launchCodex = (opts = {}) => launchCli('codex', opts);

module.exports = { launchClaude, launchCodex, launchCli, findClaude, findCli };
