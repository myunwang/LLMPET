'use strict';

const { execFile } = require('child_process');

const MAX_PROMPT_CHARS = 12000;
const TERMINAL_PASTE_SCRIPT = [
  'on run argv',
  '  set wantedTTY to item 1 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if (tty of t) is wantedTTY then',
  '          set selected tab of w to t',
  '          set index of w to 1',
  '          activate',
  '          delay 0.12',
  '          tell application "System Events"',
  '            keystroke "v" using command down',
  '            delay 0.08',
  '            key code 36',
  '          end tell',
  '          return "ok"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "not-found"',
  'end run',
].join('\n');

function cleanTty(value) {
  if (typeof value !== 'string') return null;
  const tty = value.trim();
  if (!tty || tty === '?' || !/^(?:\/dev\/)?tty[\w.-]{1,80}$/.test(tty)) return null;
  return tty.startsWith('/dev/') ? tty : '/dev/' + tty;
}

function routeForSession(session, platform = process.platform) {
  if (!session || session.headless) return { kind: 'unavailable', label: '不可下发', exact: false };
  if (session.tmuxSocket && session.tmuxClient) {
    return { kind: 'tmux', label: '精确直发 · tmux', exact: true };
  }
  const app = String(session.terminalApp || '').toLowerCase();
  if (platform === 'darwin' && app === 'terminal' && cleanTty(session.terminalTty)) {
    return { kind: 'mac-terminal', label: '精确直发 · Terminal', exact: true };
  }
  return { kind: 'manual', label: '安全模式 · 复制并聚焦', exact: false };
}

function runFile(execImpl, file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execImpl(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        error: error ? String(error.message || error) : String(stderr || '').trim(),
      });
    });
  });
}

function validPrompt(prompt) {
  return typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= MAX_PROMPT_CHARS;
}

function createCommandDispatcher(options = {}) {
  const platform = options.platform || process.platform;
  const execImpl = options.execFile || execFile;
  const copyText = typeof options.copyText === 'function' ? options.copyText : () => {};
  const focus = typeof options.focusSession === 'function' ? options.focusSession : async () => false;

  async function stageFallback(session, prompt, detail) {
    try { copyText(prompt); } catch {}
    let focused = false;
    try { focused = await focus(session); } catch {}
    return {
      ok: true,
      submitted: false,
      copied: true,
      focused,
      route: 'manual',
      message: detail || (focused
        ? '无法证明能精确定位输入框：Prompt 已复制并聚焦目标 session，请粘贴后回车。'
        : '无法精确定位目标 session：Prompt 已复制，请手动打开后粘贴。'),
    };
  }

  async function dispatch(session, prompt) {
    if (!session) return { ok: false, submitted: false, message: '目标 session 不存在，请重新选择。' };
    if (!validPrompt(prompt)) return { ok: false, submitted: false, message: 'Prompt 为空或过长，已拒绝下发。' };
    const route = routeForSession(session, platform);

    if (route.kind === 'tmux') {
      const typed = await runFile(execImpl, 'tmux', ['-S', session.tmuxSocket, 'send-keys', '-t', session.tmuxClient, '-l', '--', prompt]);
      if (typed.ok) {
        const entered = await runFile(execImpl, 'tmux', ['-S', session.tmuxSocket, 'send-keys', '-t', session.tmuxClient, 'Enter']);
        if (entered.ok) {
          return { ok: true, submitted: true, copied: false, focused: false, route: 'tmux', message: '已精确下发到所选 tmux session。' };
        }
      }
      return stageFallback(session, prompt, 'tmux 精确下发失败；Prompt 已复制并尝试聚焦目标 session。');
    }

    if (route.kind === 'mac-terminal') {
      try { copyText(prompt); } catch {}
      const sent = await runFile(execImpl, 'osascript', ['-e', TERMINAL_PASTE_SCRIPT, '--', cleanTty(session.terminalTty)]);
      if (sent.ok && sent.stdout === 'ok') {
        return { ok: true, submitted: true, copied: true, focused: true, route: 'mac-terminal', message: '已精确下发到所选 Terminal session。' };
      }
      return stageFallback(session, prompt, 'Terminal 标签页定位或输入失败；Prompt 已复制并聚焦目标 session。');
    }

    return stageFallback(session, prompt);
  }

  return { dispatch };
}

module.exports = {
  MAX_PROMPT_CHARS,
  TERMINAL_PASTE_SCRIPT,
  cleanTty,
  routeForSession,
  validPrompt,
  createCommandDispatcher,
};
