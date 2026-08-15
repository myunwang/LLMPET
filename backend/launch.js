'use strict';

// Open a new OS terminal running a supported CLI.
//
// The pet's left-click / tray "唤起 Claude" starts a fresh session. We locate
// the claude binary (Claude Code runs us with a normal PATH here, but we also
// probe common install dirs), then hand a terminal a command string to run.
// Long prompts are passed through a private file instead of being embedded in
// AppleScript / launcher arguments, whose command length is platform-limited.

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

// CLI 名 → 各平台常见安装位置（PATH 探测兜底）。codex / dsh 与 claude 同一套逻辑。
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
  // DeepSeek Harness：npm 包 @deepseek-ai/dsh 装出来的可执行名就是 dsh
  dsh: (home) => [
    path.join(home, '.local', 'bin', 'dsh'),
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
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

function cliInstalled(name) {
  const cli = findCli(name);
  if (!path.isAbsolute(cli)) return false;
  try {
    fs.accessSync(cli, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isInteractiveCliCommand(command, name) {
  const text = String(command || '').trim();
  const target = ['claude', 'codex', 'dsh'].includes(name) ? name : '';
  if (!text || !target) return false;

  // Desktop clients embed the same binaries for app-server / stream-json
  // bridges. They are not interactive terminals and must not suppress the
  // user's LLMPET-managed CLI session.
  if (/\bapp-server\b/i.test(text)
      || /--(?:input|output)-format(?:=|\s+)stream-json\b/i.test(text)
      || /\b(?:Claude|Codex) Helper\b/i.test(text)
      || /\b(?:grep|rg|ps|wmic)\b[^\n]*\b(?:claude|codex|dsh)\b/i.test(text)) return false;

  const first = text.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = first ? (first[1] || first[2] || first[3] || '') : '';
  const base = path.basename(executable).toLowerCase().replace(/\.exe$/i, '');
  if (base === target) return true;

  // npx stays visible as its own process while it launches dsh.
  if (target === 'dsh' && base === 'npx') {
    return /@deepseek-ai[\\/]dsh(?:@[^\s]+)?(?:\s|$)/i.test(text);
  }

  // npm installations can leave a node/bun launcher in the process table.
  if (!['node', 'nodejs', 'bun'].includes(base)) return false;
  if (target === 'codex') return /(?:^|[\\/])(?:@openai[\\/])?codex(?:\.js)?(?:\s|$|[\\/])/i.test(text);
  // dsh is usually a direct binary or Node package entry point.
  if (target === 'dsh') {
    return /(?:^|[\\/])(?:@deepseek-ai[\\/])?dsh(?:\.js)?(?:\s|$|[\\/])/i.test(text);
  }
  return /(?:^|[\\/])(?:@anthropic-ai[\\/])?claude(?:\.js)?(?:\s|$|[\\/])/i.test(text);
}

function cliProcessPids(output, name) {
  const seen = new Set();
  const result = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || seen.has(pid)) continue;
    if (!isInteractiveCliCommand(match[2], name)) continue;
    seen.add(pid);
    result.push(pid);
  }
  return result;
}

// A running Harness process is not necessarily its Web UI: headless and TUI
// profiles are independent frontends and cannot make http://127.0.0.1:3080
// ready. Keep this stricter predicate separate from isInteractiveCliCommand so
// startup de-duplication can still recognise every real dsh process.
function isDshWebCommand(command) {
  const text = String(command || '').trim();
  if (!isInteractiveCliCommand(text, 'dsh')) return false;
  const profile = text.match(/--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const profileName = String(profile && (profile[1] || profile[2] || profile[3]) || '').toLowerCase();
  if (profileName) return profileName === 'web';
  if (/(?:^|\s)(?:headless|tui)(?:\s|$)/i.test(text) || /(?:--resume|--continue)\b/i.test(text)) return false;
  return /(?:^|\s)web(?:\s|$)/i.test(text);
}

function dshWebProcessPids(output) {
  const seen = new Set();
  const result = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || seen.has(pid)) continue;
    if (!isDshWebCommand(match[2])) continue;
    seen.add(pid);
    result.push(pid);
  }
  return result;
}

function isCliRunning(name) {
  if (!['claude', 'codex', 'dsh'].includes(name)) return Promise.resolve(false);
  if (process.platform === 'win32') {
    const script = [
      'Get-CimInstance Win32_Process',
      'Select-Object ProcessId,CommandLine',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', script],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(false); return; }
          try {
            const raw = JSON.parse(String(stdout || '[]'));
            const rows = Array.isArray(raw) ? raw : [raw];
            resolve(rows.some((row) => Number(row.ProcessId) !== process.pid
              && isInteractiveCliCommand(row.CommandLine, name)));
          } catch { resolve(false); }
        });
    });
  }
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      resolve(!error && cliProcessPids(stdout, name).length > 0);
    });
  });
}

function isDshWebRunning() {
  if (process.platform === 'win32') {
    const script = [
      'Get-CimInstance Win32_Process',
      'Select-Object ProcessId,CommandLine',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', script],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(false); return; }
          try {
            const raw = JSON.parse(String(stdout || '[]'));
            const rows = Array.isArray(raw) ? raw : [raw];
            resolve(rows.some((row) => Number(row.ProcessId) !== process.pid
              && isDshWebCommand(row.CommandLine)));
          } catch { resolve(false); }
        });
    });
  }
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      resolve(!error && dshWebProcessPids(stdout).length > 0);
    });
  });
}

const posixQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function posixInvocation(cli, cliArgs, promptFile) {
  const parts = [posixQuote(cli), ...cliArgs.map(posixQuote)];
  if (promptFile) parts.push(`"$(/bin/cat ${posixQuote(promptFile)})"`);
  return parts.join(' ');
}

function powershellInvocation(cli, cliArgs, promptFile) {
  const parts = [`& ${psQuote(cli)}`, ...cliArgs.map(psQuote)];
  if (promptFile) {
    return `$prompt = Get-Content -Raw -LiteralPath ${psQuote(promptFile)}; ${parts.join(' ')} $prompt`;
  }
  return parts.join(' ');
}

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

// A GUI terminal launched from `npm start` can inherit an already-active
// Conda environment from Electron. Its interactive shell then runs `conda
// init` again; Conda 25.5.x may crash while trying to reactivate the same
// prefix. Let the terminal's own shell initialize Conda exactly once.
function cleanTerminalLaunchEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CONDA_') || key === '_CE_CONDA' || key === '_CE_M') {
      delete env[key];
    }
  }
  return env;
}

// candidates: ordered [bin, args] terminal launchers for this platform.
function buildCandidates(
  cli,
  workDir,
  cliArgs = [],
  promptFile = null,
  keepOpen = false,
  terminalTitle = '',
) {
  const plat = process.platform;
  if (plat === 'darwin') {
    // Keep the AppleScript payload short. Embedding a large base64 prompt here
    // is still subject to AppleScript/Terminal command truncation.
    const command = posixInvocation(cli, cliArgs, promptFile);
    const shell = process.env.SHELL || '/bin/zsh';
    const run = keepOpen
      ? `${command}; exec ${posixQuote(shell)} -l`
      : `exec ${command}`;
    const title = cleanTerminalTitle(terminalTitle);
    const script = title
      ? `tell application "Terminal"
set llmpetTab to do script "cd ${appleEscape(posixQuote(workDir))} && ${appleEscape(run)}"
set custom title of llmpetTab to "${appleEscape(title)}"
set title displays custom title of llmpetTab to true
activate
end tell`
      : `tell application "Terminal"
activate
do script "cd ${appleEscape(posixQuote(workDir))} && ${appleEscape(run)}"
end tell`;
    return [['osascript', ['-e', script]]];
  }
  if (plat === 'win32') {
    if (promptFile) {
      const command = powershellInvocation(cli, cliArgs, promptFile);
      return [
        ['wt.exe', ['-d', workDir, '--', 'powershell.exe', '-NoExit', '-NoProfile', '-Command', command]],
        ['powershell.exe', ['-NoExit', '-NoProfile', '-Command', `Set-Location -LiteralPath ${psQuote(workDir)}; ${command}`]],
      ];
    }
    const argList = cliArgs.map(psQuote).join(',');
    const script = `Start-Process -FilePath ${psQuote(cli)} -ArgumentList @(${argList}) -WorkingDirectory ${psQuote(workDir)}`;
    return [
      ['wt.exe', ['-d', workDir, '--', cli, ...cliArgs]],
      ['powershell.exe', ['-NoProfile', '-Command', script]],
    ];
  }
  if (promptFile) {
    const invocation = posixInvocation(cli, cliArgs, promptFile);
    const shell = process.env.SHELL || '/bin/sh';
    const command = keepOpen
      ? `cd ${posixQuote(workDir)} && ${invocation}; exec ${posixQuote(shell)} -l`
      : `cd ${posixQuote(workDir)} && exec ${invocation}`;
    return [
      ['x-terminal-emulator', ['-e', '/bin/sh', '-lc', command]],
      ['gnome-terminal', ['--', '/bin/sh', '-lc', command]],
      ['konsole', ['-e', '/bin/sh', '-lc', command]],
      ['xterm', ['-e', '/bin/sh', '-lc', command]],
    ];
  }
  return [
    ['x-terminal-emulator', ['-e', cli, ...cliArgs]],
    ['gnome-terminal', ['--', cli, ...cliArgs]],
    ['konsole', ['-e', cli, ...cliArgs]],
    ['xterm', ['-e', cli, ...cliArgs]],
  ];
}

function cleanTerminalTitle(value) {
  return String(value || '').replace(/[\r\n\u0000]/g, '').trim().slice(0, 80);
}

function closeMacTerminalScript(terminalTitle) {
  const title = cleanTerminalTitle(terminalTitle);
  if (!title) return '';
  return `tell application "Terminal"
set llmpetClosed to 0
set llmpetBusy to 0
repeat with llmpetIndex from (count of windows) to 1 by -1
set llmpetWindow to window llmpetIndex
repeat with llmpetTab in tabs of llmpetWindow
if custom title of llmpetTab is "${appleEscape(title)}" then
if busy of llmpetTab then
set llmpetBusy to llmpetBusy + 1
else
close llmpetWindow
set llmpetClosed to llmpetClosed + 1
end if
exit repeat
end if
end repeat
end repeat
if llmpetBusy > 0 then return "busy:" & llmpetBusy & ":" & llmpetClosed
if llmpetClosed > 0 then return "closed:" & llmpetClosed
return "missing"
end tell`;
}

function travelCliPids(output, agent, providerSessionId) {
  const target = agent === 'codex' ? 'codex' : agent === 'claude' ? 'claude' : '';
  const sessionId = String(providerSessionId || '').trim();
  if (!target || !sessionId) return [];
  const fingerprint = target === 'codex'
    ? /(?:^|\s)(?:\S*\/)?codex(?:\s|$)/i
    : /(?:^|\s)(?:\S*\/)?claude(?:\s|$)|claude-code|@anthropic-ai/i;
  const seen = new Set();
  const result = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const executable = command.trim().split(/\s+/)[0] || '';
    if (
      !Number.isInteger(pid) ||
      pid <= 1 ||
      pid === process.pid ||
      /\.app\//i.test(executable) ||
      !fingerprint.test(command) ||
      !command.split(/\s+/).includes(sessionId) ||
      seen.has(pid)
    ) continue;
    seen.add(pid);
    result.push(pid);
  }
  return result;
}

function terminateTravelCliProcesses(opts = {}) {
  const agent = opts.agent === 'codex' ? 'codex' : opts.agent === 'claude' ? 'claude' : '';
  const providerSessionId = String(opts.providerSessionId || '').trim();
  if (!agent || !providerSessionId) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const pids = travelCliPids(stdout, agent, providerSessionId);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      resolve(pids);
    });
  });
}

function closeCliTerminal(opts = {}) {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: true, status: 'unsupported' });
  const terminalTitle = cleanTerminalTitle(opts.terminalTitle);
  if (!terminalTitle) return Promise.resolve({ ok: true, status: 'untitled' });
  const processPid = Number(opts.processPid);
  if (Number.isInteger(processPid) && processPid > 1 && processPid !== process.pid) {
    try { process.kill(processPid, 'SIGTERM'); } catch {}
  }
  const script = closeMacTerminalScript(terminalTitle);
  const attempts = Number.isInteger(opts.attempts) ? Math.max(1, opts.attempts) : 6;
  const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(25, opts.intervalMs) : 400;

  return terminateTravelCliProcesses(opts).then((terminatedPids) => new Promise((resolve) => {
    const attempt = (remaining) => {
      execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
        const status = String(stdout || '').trim();
        if (!error && !status.startsWith('busy')) {
          resolve({ ok: true, status: status || 'missing', terminatedPids });
          return;
        }
        if (remaining <= 1) {
          resolve({
            ok: false,
            status: status || 'busy',
            terminatedPids,
            message: error && error.message || '',
          });
          return;
        }
        setTimeout(() => attempt(remaining - 1), intervalMs).unref?.();
      });
    };
    setTimeout(() => attempt(attempts), intervalMs).unref?.();
  }));
}

async function launchCli(name, opts = {}) {
  const cli = findCli(name);
  const workDir = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const cliArgs = Array.isArray(opts.args) ? opts.args.map((arg) => String(arg)) : [];
  const requestedPromptFile = typeof opts.promptFile === 'string' ? opts.promptFile : '';
  if (requestedPromptFile && !fs.existsSync(requestedPromptFile)) {
    return { ok: false, message: 'prompt file does not exist' };
  }
  const promptFile = requestedPromptFile || null;
  const keepOpen = opts.keepOpen === true;
  const terminalTitle = cleanTerminalTitle(opts.terminalTitle);
  const launchEnv = cleanTerminalLaunchEnv();
  for (const [bin, args] of buildCandidates(
    cli,
    workDir,
    cliArgs,
    promptFile,
    keepOpen,
    terminalTitle,
  )) {
    // eslint-disable-next-line no-await-in-loop
    if (await trySpawn(bin, args, { cwd: workDir, env: launchEnv })) {
      return { ok: true, terminal: bin };
    }
  }
  return { ok: false, message: 'could not open a terminal' };
}

async function launchExecutable(command, opts = {}) {
  const executable = String(command || '').trim();
  if (!executable || /[\r\n\u0000]/.test(executable)) return { ok: false, message: 'invalid executable' };
  const workDir = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const args = Array.isArray(opts.args) ? opts.args.map((arg) => String(arg)) : [];
  const launchEnv = cleanTerminalLaunchEnv();
  for (const [bin, binArgs] of buildCandidates(executable, workDir, args, null, opts.keepOpen === true, opts.terminalTitle || '')) {
    // eslint-disable-next-line no-await-in-loop
    if (await trySpawn(bin, binArgs, { cwd: workDir, env: launchEnv })) return { ok: true, terminal: bin };
  }
  return { ok: false, message: 'could not launch executable' };
}

const launchClaude = (opts = {}) => launchCli('claude', opts);
const launchCodex = (opts = {}) => launchCli('codex', opts);
// `web` is the bundled, auto-initialized dsh profile. TUI is profile-based and
// may not be installed locally, so the generic launcher keeps `dsh web` as its
// safe default; callers with a known profile can pass their own arguments.
const launchDsh = (opts = {}) => launchCli('dsh', {
  ...opts,
  args: Array.isArray(opts.args) && opts.args.length ? opts.args : ['web'],
});

function probeHttp(url, timeoutMs = 700) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve(false); return; }
    const client = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!client) { resolve(false); return; }
    const req = client.request(parsed, { method: 'GET' }, (res) => {
      res.resume();
      resolve(true); // Any HTTP response proves that the Web frontend is ready.
    });
    req.setTimeout(Math.max(100, Number(timeoutMs) || 700), () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitForDshWeb(url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 20);
  const intervalMs = Math.max(0, Number(options.intervalMs) || 250);
  const probe = options.probe || probeHttp;
  const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let index = 0; index < attempts; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe(url, options.timeoutMs)) return true;
    if (index < attempts - 1 && intervalMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await pause(intervalMs);
    }
  }
  return false;
}

// Ensure the generic Web frontend exists before callers open its URL. A live
// headless/TUI process deliberately does not satisfy this check.
async function ensureDshWeb(options = {}) {
  const running = options.running || isDshWebRunning;
  const launch = options.launch || launchDsh;
  const wait = options.wait || waitForDshWeb;
  const url = options.url || 'http://127.0.0.1:3080';
  let status = 'already-running';
  if (!(await running())) {
    const result = await launch({ terminalTitle: options.terminalTitle || 'LLMPET · dsh' });
    if (!result || !result.ok) {
      return { ok: false, status: 'launch-failed', message: result && result.message || 'could not launch dsh web' };
    }
    status = 'launched';
  }
  if (!(await wait(url, options.waitOptions || {}))) {
    return { ok: false, status: 'not-ready', message: 'dsh web did not become ready' };
  }
  return { ok: true, status };
}

module.exports = {
  launchClaude,
  launchCodex,
  launchDsh,
  launchCli,
  launchExecutable,
  closeCliTerminal,
  closeMacTerminalScript,
  travelCliPids,
  findClaude,
  findCli,
  cliInstalled,
  isCliRunning,
  isInteractiveCliCommand,
  cliProcessPids,
  isDshWebCommand,
  dshWebProcessPids,
  isDshWebRunning,
  waitForDshWeb,
  ensureDshWeb,
  buildCandidates,
  cleanTerminalLaunchEnv,
};
