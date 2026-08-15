'use strict';

// Read-only operating-system runtime inventory for the desktop workbench.
//
// Session hooks know that Claude/Codex reported "2 background tasks", but they
// cannot tell the workbench which process is actually alive.  This monitor
// fills that gap by sampling the current user's process table and keeping only
// agent workers and script/tool runners.  It never kills, pauses, or otherwise
// mutates a process.

const { execFile } = require('child_process');
const path = require('path');

const POSIX_ARGS = ['-axo', 'pid=,ppid=,etime=,state=,%cpu=,%mem=,command='];
const SCRIPT_EXT_RE = /\.(?:py|js|mjs|cjs|ts|tsx|rb|php|sh|zsh|bash)(?:\s|$)/i;
const RUNNER_RE = /^(?:python(?:\d+(?:\.\d+)*)?|node|npm|npx|pnpm|yarn|bun|deno|ffmpeg|xcodebuild|swift|cargo|rustc|ruby|php|bash|zsh|sh)$/i;
const IGNORE_RE = /(?:chrome_crashpad_handler|--type=(?:renderer|gpu-process|utility)|\.app\/Contents\/Frameworks\/|\.app\/Contents\/Helpers\/chrome-native-host|node_modules\/electron\/dist\/Electron\.app|backend\/runtime-monitor\.js)/i;

function parseElapsed(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const parts = raw.split('-');
  const days = parts.length > 1 ? Number(parts.shift()) || 0 : 0;
  const clock = parts.join('-').split(':').map((n) => Number(n) || 0);
  let seconds = 0;
  for (const n of clock) seconds = seconds * 60 + n;
  return days * 86400 + seconds;
}

function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3],
      ageSec: parseElapsed(match[3]), state: match[4], cpu: Number(match[5]) || 0,
      memory: Number(match[6]) || 0, command: match[7].trim(),
    });
  }
  return rows;
}

function executable(command) {
  const first = String(command || '').match(/^\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
  return path.basename(first && (first[1] || first[2] || first[3]) || '').toLowerCase();
}

function shortPath(value) {
  const clean = String(value || '').replace(/^['"]|['"]$/g, '');
  const base = path.basename(clean);
  return base || clean;
}

function dshProcessMeta(command) {
  // dsh can be a direct binary, its Node package entry point, or an npx
  // launcher. Keep this before generic Node-script detection so a live agent
  // is not misreported as an arbitrary script runner.
  const direct = /(?:^|\s)(?:[^\s]*[\\/])?dsh(?:\.js)?(?:\s|$)/i.test(command);
  const nodeEntry = /(?:^|[\\/\s])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js(?:\s|$)/i.test(command);
  const npx = /(?:^|\s)(?:[^\s]*[\\/])?npx(?:\.cmd)?(?:\s+--[^\s]+(?:\s+[^\s]+)?)*\s+@deepseek-ai[\\/]dsh(?:@[^\s]+)?(?:\s|$)/i.test(command);
  if (!direct && !nodeEntry && !npx) return null;

  const profileMatch = command.match(/--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const profile = String(profileMatch && (profileMatch[1] || profileMatch[2] || profileMatch[3]) || '').toLowerCase();
  const modeMatch = command.match(/\b(?:dsh|bin\.js)\s+(web|headless|tui)\b/i);
  const mode = profile || String(modeMatch && modeMatch[1] || '').toLowerCase()
    || (/--headless\b/i.test(command) ? 'headless' : '')
    || (/(?:--resume|--continue)\b/i.test(command) ? 'tui' : '');
  const label = mode === 'web' ? 'dsh · Web'
    : mode === 'headless' ? 'dsh · Headless'
      : mode === 'tui' ? 'dsh · TUI'
        : 'dsh · CLI';
  return { kind: 'agent', provider: 'dsh', label };
}

function processMeta(row) {
  const command = String(row.command || '');
  if (!command || IGNORE_RE.test(command)) return null;
  if (/\b(?:ps -axo|rg -i|runtime-monitor)\b/i.test(command)) return null;

  if (/\bcodex\s+app-server\b/i.test(command)) {
    return { kind: 'agent', provider: 'codex', label: 'Codex app-server' };
  }
  if (/\/codex(?:\s|$)/i.test(command) && /\b(?:exec|resume|app-server)\b/i.test(command)) {
    return { kind: 'agent', provider: 'codex', label: 'Codex CLI' };
  }
  if (/\/claude(?:\s|$)/i.test(command) && /(?:--resume|--output-format|--print|-p\b)/i.test(command) && !/\/disclaimer\b/i.test(command)) {
    const resume = command.match(/--resume(?:=|\s+)([^\s]+)/i);
    return { kind: 'agent', provider: 'claude', label: resume ? `Claude · ${resume[1].slice(0, 8)}` : 'Claude Code' };
  }
  const dsh = dshProcessMeta(command);
  if (dsh) return dsh;
  if (/cua_node\/bin\/node\b.*\bkernel\.js\b/i.test(command)) {
    const cwd = command.match(/--working-dir\s+([^\n]+)$/i);
    return { kind: 'agent-tool', provider: 'codex', label: `Codex Computer Use · ${shortPath(cwd && cwd[1]) || 'Node REPL'}` };
  }

  const exe = executable(command);
  if (!RUNNER_RE.test(exe)) return null;
  const moduleMatch = command.match(/\s-m\s+([\w.-]+)/);
  const scriptMatch = command.match(/(?:^|\s)([^\s'"=]+\.(?:py|js|mjs|cjs|ts|tsx|rb|php|sh|zsh|bash))(?:\s|$)/i);
  const devTool = command.match(/\b(vite|webpack|next|nuxt|electron-builder|ts-node|tsx)\b/i);
  if (!moduleMatch && !scriptMatch && !devTool && !SCRIPT_EXT_RE.test(command)) return null;
  const target = moduleMatch ? moduleMatch[1] : scriptMatch ? shortPath(scriptMatch[1]) : devTool && devTool[1];
  return { kind: 'script', provider: null, label: `${exe} · ${target || 'script'}` };
}

function isDescendantOf(pid, target, byPid) {
  let cursor = byPid.get(pid);
  const visited = new Set();
  while (cursor && cursor.ppid > 0 && !visited.has(cursor.ppid)) {
    if (cursor.ppid === target) return true;
    visited.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

function classify(rows, options = {}) {
  const selfPid = Number(options.selfPid) || 0;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.pid || row.pid === selfPid || (selfPid && isDescendantOf(row.pid, selfPid, byPid))) continue;
    const meta = processMeta(row);
    if (!meta) continue;
    // Wrapper/child pairs often expose the same full command. Keep the actual
    // child and avoid showing the same task twice.
    const signature = `${meta.kind}|${meta.provider || ''}|${meta.label}|${row.command}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    items.push({
      ...meta, pid: row.pid, ppid: row.ppid, elapsed: row.elapsed,
      ageSec: row.ageSec, state: row.state, cpu: row.cpu, memory: row.memory,
      command: row.command.length > 360 ? row.command.slice(0, 357) + '…' : row.command,
      status: 'running', alive: true,
    });
  }
  // The workbench is primarily answering "what did my agents leave running?".
  // Put concrete scripts before the long-lived agent infrastructure, then show
  // newly-started work first. Otherwise a fresh worker can be technically
  // captured yet remain below several days of Codex app-server processes.
  return items.sort((a, b) => {
    const kindDelta = (a.kind === 'script' ? 0 : 1) - (b.kind === 'script' ? 0 : 1);
    return kindDelta || (a.ageSec - b.ageSec) || (b.cpu - a.cpu) || (a.pid - b.pid);
  });
}

function defaultListProcesses(callback) {
  if (process.platform === 'win32') { callback(null, []); return; }
  execFile('ps', POSIX_ARGS, { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) callback(error); else callback(null, parsePs(stdout));
  });
}

function createRuntimeMonitor(options = {}) {
  const listProcesses = options.listProcesses || defaultListProcesses;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const selfPid = Number(options.selfPid) || process.pid;
  const intervalMs = Math.max(2000, Number(options.intervalMs) || 5000);
  let timer = null;
  let scanning = false;
  let lastSignature = '';
  let lastScanAt = 0;
  let lastError = '';
  let items = [];

  function snapshot() {
    const scripts = items.filter((item) => item.kind === 'script').length;
    const agents = items.length - scripts;
    return { running: items.length, zombie: 0, total: items.length, scripts, agents, items: items.map((item) => ({ ...item })), lastScanAt, error: lastError || null };
  }

  function scanNow() {
    if (scanning) return Promise.resolve(snapshot());
    scanning = true;
    return new Promise((resolve) => {
      listProcesses((error, rows) => {
        scanning = false;
        lastScanAt = Date.now();
        lastError = error ? String(error.message || error) : '';
        if (!error) items = classify(Array.isArray(rows) ? rows : [], { selfPid });
        const nextSignature = JSON.stringify(items.map((item) => [item.pid, item.ppid, item.label, item.status, Math.round(item.cpu * 10)]));
        if (nextSignature !== lastSignature || error) {
          lastSignature = nextSignature;
          try { onChange(snapshot()); } catch {}
        }
        resolve(snapshot());
      });
    });
  }

  function start() {
    if (timer) return;
    scanNow();
    timer = setInterval(scanNow, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, scanNow, snapshot };
}

module.exports = { createRuntimeMonitor, parseElapsed, parsePs, processMeta, classify };
