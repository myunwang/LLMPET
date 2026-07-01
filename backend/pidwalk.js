'use strict';

// Resolve the terminal that owns a hook invocation (original implementation).
//
// Claude Code runs the hook as a child of the `claude` CLI, which is a child of
// the shell, which is a child of the terminal app. We walk parent PIDs up from
// the hook's parent until we hit a known terminal process (or a system root),
// and report that PID + the chain so the app can later focus that window.
//
// macOS / Linux use `ps`; Windows is best-effort (returns just the start pid).
// Used only to power "💬 去回复" focus — purely a convenience signal.

const { execFileSync } = require('child_process');

const TERMINALS = new Set([
  // macOS
  'terminal', 'iterm2', 'iterm', 'alacritty', 'wezterm-gui', 'kitty', 'hyper', 'tabby', 'warp', 'ghostty',
  // linux
  'gnome-terminal', 'konsole', 'xterm', 'xfce4-terminal', 'tilix', 'terminator', 'lxterminal', 'kgx', 'wezterm',
  // editors with integrated terminals
  'code', 'cursor', 'code-insiders',
]);
const SYSTEM_ROOTS = new Set(['launchd', 'init', 'systemd']);
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

// Returns { sourcePid, pidChain, editor, headless, tmuxSocket, tmuxClient }.
function resolve(startPid = process.ppid, maxDepth = 10) {
  const tmuxSocket = typeof process.env.TMUX === 'string' && process.env.TMUX.startsWith('/')
    ? process.env.TMUX.split(',')[0] : null;
  if (process.platform === 'win32') {
    return { sourcePid: startPid || null, pidChain: startPid ? [startPid] : [], editor: null, headless: false, tmuxSocket, tmuxClient: null };
  }
  const chain = [];
  let pid = startPid;
  let terminalPid = null;
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
    if (TERMINALS.has(name)) terminalPid = pid;
    if (SYSTEM_ROOTS.has(name)) break;
    lastGood = pid;
    const ppid = parseInt(ps(pid, 'ppid'), 10);
    if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
    pid = ppid;
  }

  return { sourcePid: terminalPid || lastGood || null, pidChain: chain, editor, headless, tmuxSocket, tmuxClient: null };
}

module.exports = { resolve };
