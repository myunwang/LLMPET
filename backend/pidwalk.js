'use strict';

// Resolve the terminal that owns a hook invocation (original implementation).
//
// Claude Code runs the hook as a child of the `claude` CLI, which is a child of
// the shell, which is a child of the terminal app. We walk parent PIDs up from
// the hook's parent until we hit a known terminal process (or a system root),
// and report that PID + the chain so the app can later focus that window.
//
// macOS / Linux use `ps`; Windows walks Win32_Process parents via PowerShell,
// with an on-disk cache because PreToolUse hooks are hot and PowerShell startup
// is not free. Used only to power "💬 去回复" focus — purely a convenience signal.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TERMINALS = new Set([
  // macOS
  'terminal', 'iterm2', 'iterm', 'alacritty', 'wezterm-gui', 'kitty', 'hyper', 'tabby', 'warp', 'ghostty',
  // linux
  'gnome-terminal', 'konsole', 'xterm', 'xfce4-terminal', 'tilix', 'terminator', 'lxterminal', 'kgx', 'wezterm',
  // windows
  'windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'mintty', 'conemu64', 'conemu',
  // editors with integrated terminals
  'code', 'cursor', 'code-insiders',
]);
const SYSTEM_ROOTS = new Set(['launchd', 'init', 'systemd', 'explorer', 'wininit', 'winlogon', 'services']);
const EDITORS = { code: 'code', cursor: 'cursor', 'code-insiders': 'code' };

function ps(pid, field) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim();
  } catch {
    return '';
  }
}

function baseName(comm) {
  const i = Math.max(comm.lastIndexOf('/'), comm.lastIndexOf('\\'));
  return (i >= 0 ? comm.slice(i + 1) : comm).toLowerCase();
}

const HEADLESS_RE = /\s(-p|--print)(\s|$)/;

// ---- Windows ----------------------------------------------------------------
//
// One PowerShell invocation walks the whole parent chain and prints
// `pid|name|commandline` per level. That costs ~0.5–1.5s of PowerShell startup,
// which is too much for a PreToolUse hook that fires on every tool call — so we
// cache the resolved chain in ~/.octopus/pidwalk-cache.json keyed by the start
// pid (the claude CLI process, stable for the life of a session).

const WIN_CACHE = path.join(os.homedir(), '.octopus', 'pidwalk-cache.json');
const WIN_CACHE_TTL = 6 * 60 * 60 * 1000;
const WT_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WT_TAB_CAPTURE_HELPER = path.join(__dirname, 'capture-windows-terminal-tab.ps1');

function normalizeWtSession(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^\{([^}]+)\}$/, '$1').toLowerCase();
  return WT_SESSION_RE.test(normalized) ? normalized : null;
}

function normalizeWtHwnd(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  try { return BigInt(text) <= 9223372036854775807n ? text : null; } catch { return null; }
}

function normalizeWtTabRuntimeId(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const result = value.map(Number);
  return result.every((entry) => Number.isInteger(entry) && entry >= -2147483648 && entry <= 2147483647)
    ? result : null;
}

function hasWtTabRoute(value) {
  return !!(value && normalizeWtHwnd(value.wtHwnd) && normalizeWtTabRuntimeId(value.wtTabRuntimeId));
}

function captureWindowsTerminalTabRoute(options = {}) {
  const execFileSyncFn = options.execFileSync || execFileSync;
  const helperPath = options.helperPath || WT_TAB_CAPTURE_HELPER;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 900;
  try {
    const output = execFileSyncFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-TimeoutMs', String(timeoutMs),
    ], {
      encoding: 'utf8',
      timeout: timeoutMs + 1500,
      // Capture uses the selected UI Automation tab in the foreground Terminal
      // window, so it does not need to attach to or mutate the hook's ConPTY.
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] || '');
    const wtHwnd = normalizeWtHwnd(parsed && parsed.hwnd);
    const wtTabRuntimeId = normalizeWtTabRuntimeId(parsed && parsed.runtimeId);
    return parsed && parsed.ok === true && wtHwnd && wtTabRuntimeId
      ? { wtHwnd, wtTabRuntimeId }
      : null;
  } catch {
    return null;
  }
}

function enrichWindowsTabRoute(base, options = {}) {
  const wtSession = normalizeWtSession(options.wtSession);
  const refresh = options.refresh === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  // Foreground selection is authoritative only while the user starts a session
  // or submits a prompt. Tool hooks can run much later while another Terminal
  // tab is foreground, so they must only reuse a route and never capture one.
  if (!wtSession || !refresh) {
    return { result: base, changed: false };
  }
  const capture = options.capture || captureWindowsTerminalTabRoute;
  const route = capture();
  return {
    result: { ...base, ...(route || {}), wtTabCaptureAttemptedAt: now },
    changed: true,
  };
}

function windowsProcessExists(pid, options = {}) {
  const kill = options.kill || process.kill.bind(process);
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // Windows can deny PROCESS_TERMINATE access to the packaged Terminal host.
    // Node surfaces that access denial as EPERM even though signal 0 is only a
    // liveness probe. ESRCH is the actual "process is gone" result.
    return !!(error && error.code === 'EPERM');
  }
}

function winCacheRead(key) {
  try {
    const all = JSON.parse(fs.readFileSync(WIN_CACHE, 'utf8'));
    const hit = all && all[String(key)];
    if (!hit || Date.now() - hit.at > WIN_CACHE_TTL) return null;
    if (hit.result && hit.result.sourcePid && !windowsProcessExists(hit.result.sourcePid)) return null;
    return hit.result;
  } catch {
    return null;
  }
}

// The hook writes its freshly captured Windows Terminal tab route to disk
// before posting the state event. In practice the UI can receive/click an
// older in-memory session snapshot while that hook delivery is still catching
// up. Read back only the exact route for the same session id; never guess from
// a title, cwd, process, or whichever tab happens to be selected at click time.
function readCachedWindowsTerminalTabRoute(cacheKey, options = {}) {
  if (typeof cacheKey !== 'string' || !cacheKey.trim()) return null;
  const readCache = options.readCache || winCacheRead;
  let cached;
  try { cached = readCache(cacheKey); } catch { return null; }
  const wtSession = normalizeWtSession(cached && cached.wtSession);
  const wtHwnd = normalizeWtHwnd(cached && cached.wtHwnd);
  const wtTabRuntimeId = normalizeWtTabRuntimeId(cached && cached.wtTabRuntimeId);
  return wtSession && wtHwnd && wtTabRuntimeId
    ? { wtSession, wtHwnd, wtTabRuntimeId }
    : null;
}

function winCacheWrite(key, result) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(WIN_CACHE, 'utf8')) || {}; } catch {}
    const now = Date.now();
    for (const k of Object.keys(all)) { if (now - (all[k].at || 0) > WIN_CACHE_TTL) delete all[k]; }
    all[String(key)] = { at: now, result };
    fs.mkdirSync(path.dirname(WIN_CACHE), { recursive: true });
    fs.writeFileSync(WIN_CACHE, JSON.stringify(all), 'utf8');
  } catch {}
}

function winWalkChain(startPid, maxDepth) {
  // $PID is reserved in PowerShell; use $cur. CommandLine goes last because it
  // may itself contain '|'.
  const script = [
    '$cur = ' + startPid,
    `for ($i = 0; $i -lt ${maxDepth}; $i++) {`,
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue',
    '  if (-not $p) { break }',
    '  Write-Output ("{0}|{1}|{2}" -f $p.ProcessId, $p.Name, $p.CommandLine)',
    '  if ($p.ParentProcessId -le 0 -or $p.ParentProcessId -eq $cur) { break }',
    '  $cur = $p.ParentProcessId',
    '}',
  ].join('\n');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [pid, name, ...rest] = line.split('|');
    return { pid: parseInt(pid, 10), name: String(name || ''), cmd: rest.join('|') };
  }).filter((e) => Number.isFinite(e.pid));
}

function winBase(name) {
  return String(name).toLowerCase().replace(/\.exe$/, '');
}

function resolveWin(startPid, maxDepth, cacheKey, options = {}) {
  const wtSession = normalizeWtSession(process.env.WT_SESSION);
  const empty = {
    sourcePid: startPid || null, pidChain: startPid ? [startPid] : [], editor: null,
    headless: false, tmuxSocket: null, tmuxClient: null, terminalApp: null, terminalTty: null,
    wtSession, wtHwnd: null, wtTabRuntimeId: null,
  };
  if (!startPid) return empty;
  const captureTab = options.captureWindowsTab || captureWindowsTerminalTabRoute;
  const refreshTab = options.refreshWindowsTab === true;
  const enrichTabRoute = (base) => enrichWindowsTabRoute(base, {
    wtSession,
    refresh: refreshTab,
    capture: captureTab,
  });
  // The hook's ppid is a transient PowerShell wrapper (different every event),
  // so the cache is keyed by the Claude Code session id instead.
  let cached = cacheKey ? winCacheRead(cacheKey) : null;
  if (cached && wtSession && cached.wtSession !== wtSession) cached = null;
  if (cached) {
    const enriched = enrichTabRoute({ ...cached, wtSession });
    const result = enriched.result;
    if (cacheKey && (enriched.changed || cached.wtSession !== wtSession)) winCacheWrite(cacheKey, result);
    return result;
  }

  let levels;
  try { levels = winWalkChain(startPid, maxDepth); } catch {
    const result = enrichTabRoute(empty).result;
    if (cacheKey) winCacheWrite(cacheKey, result);
    return result;
  }
  if (!levels.length) {
    const result = enrichTabRoute(empty).result;
    if (cacheKey) winCacheWrite(cacheKey, result);
    return result;
  }

  const chain = [];
  let terminalPid = null;
  let lastGood = null;
  let editor = null;
  let headless = false;
  const HOOK_SHELLS = new Set(['powershell', 'pwsh', 'cmd']);
  for (let i = 0; i < levels.length; i++) {
    const { pid, name, cmd } = levels[i];
    const base = winBase(name);
    // System roots (explorer & co.) own real windows — keep them out of the
    // chain entirely or focus would raise a random Explorer window.
    if (SYSTEM_ROOTS.has(base)) break;
    chain.push(pid);
    if (!editor && EDITORS[base]) editor = EDITORS[base];
    if (!headless && (base === 'claude' || base === 'node') &&
        (base === 'claude' || /claude-code|@anthropic-ai/.test(cmd)) && HEADLESS_RE.test(' ' + cmd)) headless = true;
    // Level 0 is our own transient hook shell wrapper (hookinstall runs the
    // hook via powershell) — never treat it as the user's terminal.
    if (TERMINALS.has(base) && !(i === 0 && HOOK_SHELLS.has(base))) terminalPid = pid; // keep walking: WindowsTerminal sits above cmd/pwsh
    lastGood = pid;
  }
  const result = enrichTabRoute({
    sourcePid: terminalPid || lastGood || null, pidChain: chain, editor, headless,
    tmuxSocket: null, tmuxClient: null, terminalApp: null, terminalTty: null, wtSession,
    wtHwnd: null, wtTabRuntimeId: null,
  }).result;
  if (cacheKey) winCacheWrite(cacheKey, result);
  return result;
}

// Returns focus fields plus an exact input route when one is observable. tmux's
// pane id and the process tty are stable per session; a GUI app pid is not.
// `cacheKey` (Windows only): a stable per-session id so hot hooks skip PowerShell.
function resolve(startPid = process.ppid, maxDepth = 10, cacheKey = null, options = {}) {
  const tmuxSocket = typeof process.env.TMUX === 'string' && process.env.TMUX.startsWith('/')
    ? process.env.TMUX.split(',')[0] : null;
  const tmuxClient = tmuxSocket && typeof process.env.TMUX_PANE === 'string'
    ? process.env.TMUX_PANE.trim() || null : null;
  if (process.platform === 'win32') {
    return resolveWin(startPid, maxDepth, cacheKey, options);
  }
  const chain = [];
  let pid = startPid;
  let terminalPid = null;
  let terminalApp = null;
  let lastGood = pid;
  let editor = null;
  let headless = false;

  for (let i = 0; i < maxDepth && pid && pid > 1; i++) {
    const comm = ps(pid, 'comm');
    if (!comm) break;
    const name = baseName(comm);
    chain.push(pid);
    if (!editor && EDITORS[name]) editor = EDITORS[name];
    // Detect a headless agent run (`claude -p` / `--print`): inspect the claude
    // (or node-running-claude) process's full command line.
    if (!headless && (name === 'claude' || name === 'node')) {
      const cmd = ps(pid, 'command');
      if ((name === 'claude' || /claude-code|@anthropic-ai/.test(cmd)) && HEADLESS_RE.test(' ' + cmd)) headless = true;
    }
    if (TERMINALS.has(name)) { terminalPid = pid; terminalApp = name; }
    if (SYSTEM_ROOTS.has(name)) break;
    lastGood = pid;
    const ppid = parseInt(ps(pid, 'ppid'), 10);
    if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
    pid = ppid;
  }

  const ttyRaw = ps(startPid, 'tty');
  const terminalTty = ttyRaw && ttyRaw !== '?' ? ttyRaw : null;
  return {
    sourcePid: terminalPid || lastGood || null, pidChain: chain, editor, headless,
    tmuxSocket, tmuxClient, terminalApp, terminalTty, wtSession: null,
    wtHwnd: null, wtTabRuntimeId: null,
  };
}

module.exports = {
  resolve,
  normalizeWtSession,
  normalizeWtHwnd,
  normalizeWtTabRuntimeId,
  hasWtTabRoute,
  captureWindowsTerminalTabRoute,
  enrichWindowsTabRoute,
  readCachedWindowsTerminalTabRoute,
  windowsProcessExists,
  WT_TAB_CAPTURE_HELPER,
};
