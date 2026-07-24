'use strict';

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCli } = require('./launch');

const MAX_PROMPT_CHARS = 12000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i;
const CLAUDE_DESKTOP_ID_RE = /^local_[0-9a-f]{8}-[0-9a-f-]{27,40}$/i;
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
const CODEX_DESKTOP_PASTE_SCRIPT = [
  'tell application "System Events"',
  '  set procs to (every application process whose bundle identifier is "com.openai.codex")',
  '  if (count of procs) is 0 then return "not-running"',
  '  set frontmost of (item 1 of procs) to true',
  '  delay 0.25',
  '  keystroke "v" using command down',
  '  delay 0.1',
  '  key code 36',
  'end tell',
  'return "ok"',
].join('\n');
const NATIVE_HELPER_SOURCE = path.join(__dirname, 'drag-window.swift');
let nativeHelperPromise = null;

function ensureNativeHelper(execImpl = execFile) {
  if (nativeHelperPromise) return nativeHelperPromise;
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'drag-window')
    : null;
  if (packaged) {
    try {
      fs.accessSync(packaged, fs.constants.X_OK);
      nativeHelperPromise = Promise.resolve(packaged);
      return nativeHelperPromise;
    } catch {}
  }
  let sourceHash;
  try {
    sourceHash = crypto.createHash('sha256')
      .update(fs.readFileSync(NATIVE_HELPER_SOURCE))
      .digest('hex').slice(0, 16);
  } catch (error) {
    return Promise.reject(error);
  }
  const output = path.join(os.tmpdir(), `octopus-drag-window-${sourceHash}`);
  try {
    fs.accessSync(output, fs.constants.X_OK);
    nativeHelperPromise = Promise.resolve(output);
    return nativeHelperPromise;
  } catch {}
  nativeHelperPromise = new Promise((resolve, reject) => {
    execImpl('/usr/bin/swiftc', [
      '-O', NATIVE_HELPER_SOURCE,
      '-F', '/System/Library/PrivateFrameworks',
      '-framework', 'SkyLight',
      '-framework', 'ApplicationServices',
      '-framework', 'AppKit',
      '-o', output,
    ], { timeout: 20000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        nativeHelperPromise = null;
        reject(new Error(String(stderr || error.message || error).trim()));
      } else {
        resolve(output);
      }
    });
  });
  return nativeHelperPromise;
}

function claudeDesktopSessionsRoot(homeDir = os.homedir()) {
  return `${homeDir}/Library/Application Support/Claude/claude-code-sessions`;
}

function resolveClaudeDesktopSessionId(cliSessionId, root = claudeDesktopSessionsRoot()) {
  if (!SESSION_ID_RE.test(String(cliSessionId || '')) || !fs.existsSync(root)) return null;
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fp = `${current.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (current.depth < 3) pending.push({ dir: fp, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !/^local_[0-9a-f-]+\.json$/i.test(entry.name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (
          meta &&
          meta.cliSessionId === cliSessionId &&
          CLAUDE_DESKTOP_ID_RE.test(String(meta.sessionId || ''))
        ) return meta.sessionId;
      } catch {}
    }
  }
  return null;
}

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
  if (
    platform === 'darwin' &&
    session.agentId === 'codex' &&
    /codex desktop/i.test(String(session.originator || '')) &&
    SESSION_ID_RE.test(String(session.id || ''))
  ) {
    return { kind: 'codex-desktop', label: '精确直发 · Codex 客户端', exact: true };
  }
  if (
    platform === 'darwin' &&
    session.agentId !== 'codex' &&
    resolveClaudeDesktopSessionId(session.id)
  ) {
    return { kind: 'claude-desktop', label: '精确直发 · Claude 客户端', exact: true };
  }
  if (SESSION_ID_RE.test(String(session.id || ''))) {
    if (session.agentId === 'codex') {
      return { kind: 'codex-resume', label: '精确续聊 · Codex', exact: true };
    }
    return { kind: 'claude-resume', label: '精确续聊 · Claude', exact: true };
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

function transcriptHasPrompt(text, prompt) {
  const matches = (actual) =>
    typeof actual === 'string' &&
    (actual === prompt || actual.replace(/\r?\n$/, '') === prompt.replace(/\r?\n$/, ''));
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const p = obj && obj.payload;
      if (obj.type === 'event_msg' && p && p.type === 'user_message' && matches(p.message)) return true;
      if (obj.type === 'response_item' && p && p.role === 'user' && Array.isArray(p.content)) {
        if (p.content.some((part) => part && matches(part.text))) return true;
      }
      if (obj.type === 'user' && obj.message && obj.message.role === 'user') {
        const content = obj.message.content;
        if (matches(content)) return true;
        if (Array.isArray(content) && content.some((part) => part && part.type === 'text' && matches(part.text))) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function waitForTranscriptPrompt(transcriptPath, prompt, startSize, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 120;
  const started = Date.now();
  let offset = Math.max(0, Number(startSize) || 0);
  let carry = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size < offset) { offset = 0; carry = ''; }
      if (stat.size > offset) {
        const length = stat.size - offset;
        const buf = Buffer.alloc(length);
        let fd;
        try {
          fd = fs.openSync(transcriptPath, 'r');
          fs.readSync(fd, buf, 0, length, offset);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
        offset = stat.size;
        carry += buf.toString('utf8');
        const cut = carry.lastIndexOf('\n');
        if (cut >= 0) {
          const complete = carry.slice(0, cut + 1);
          carry = carry.slice(cut + 1);
          if (transcriptHasPrompt(complete, prompt)) return true;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return transcriptHasPrompt(carry, prompt);
}

function createCommandDispatcher(options = {}) {
  const platform = options.platform || process.platform;
  const execImpl = options.execFile || execFile;
  const spawnImpl = options.spawn || spawn;
  const findCliImpl = options.findCli || findCli;
  const resumeProbeMs = Number.isFinite(options.resumeProbeMs) ? options.resumeProbeMs : 650;
  const desktopOpenDelayMs = Number.isFinite(options.desktopOpenDelayMs) ? options.desktopOpenDelayMs : 850;
  const copyText = typeof options.copyText === 'function' ? options.copyText : () => {};
  const focus = typeof options.focusSession === 'function' ? options.focusSession : async () => false;
  const openCodexThread = typeof options.openCodexThread === 'function' ? options.openCodexThread : async () => false;
  const openClaudeThread = typeof options.openClaudeThread === 'function' ? options.openClaudeThread : async () => false;
  const resolveClaudeSession = typeof options.resolveClaudeDesktopSession === 'function'
    ? options.resolveClaudeDesktopSession
    : resolveClaudeDesktopSessionId;
  const getNativeHelper = typeof options.getNativeHelper === 'function'
    ? options.getNativeHelper
    : () => ensureNativeHelper(execImpl);
  const verifyPrompt = typeof options.verifyPrompt === 'function'
    ? options.verifyPrompt
    : (session, prompt, startSize) => waitForTranscriptPrompt(session.transcriptPath, prompt, startSize);

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

  function nativeResume(session, prompt, kind) {
    const name = kind === 'codex-resume' ? 'codex' : 'claude';
    const cli = findCliImpl(name);
    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
    const args = kind === 'codex-resume'
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', session.id, prompt]
      : ['--print', '--resume', session.id, '--output-format', 'stream-json', '--verbose', prompt];
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let spawned = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        child = spawnImpl(cli, args, {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, LLMPET_MEME_RESUME: '1' },
        });
      } catch (err) {
        finish({ ok: false, submitted: false, route: kind, message: `${name} 续聊启动失败：${err.message || err}` });
        return;
      }
      child.once('error', (err) => {
        finish({ ok: false, submitted: false, route: kind, message: `${name} 续聊启动失败：${err.message || err}` });
      });
      child.once('spawn', () => {
        spawned = true;
        if (typeof child.unref === 'function') child.unref();
        setTimeout(() => {
          if (settled) return;
          if (child.exitCode != null && child.exitCode !== 0) {
            finish({ ok: false, submitted: false, route: kind, message: `${name} 未能恢复指定 session（退出码 ${child.exitCode}）。` });
            return;
          }
          finish({
            ok: true,
            // A spawned Claude process has not necessarily authenticated or
            // appended the prompt yet. Its caller verifies the transcript
            // before reporting submitted=true.
            submitted: kind === 'codex-resume',
            launched: true,
            copied: false,
            focused: false,
            route: kind,
            pid: child.pid || null,
            message: `已按 session ID 交给 ${name === 'codex' ? 'Codex' : 'Claude'} 继续执行。`,
          });
        }, resumeProbeMs);
      });
      child.once('exit', (code) => {
        if (!settled && spawned && code !== 0) {
          finish({ ok: false, submitted: false, route: kind, message: `${name} 未能恢复指定 session（退出码 ${code}）。` });
        }
      });
    });
  }

  async function dispatch(session, prompt) {
    if (!session) return { ok: false, submitted: false, message: '目标 session 不存在，请重新选择。' };
    if (!validPrompt(prompt)) return { ok: false, submitted: false, message: 'Prompt 为空或过长，已拒绝下发。' };
    let route = routeForSession(session, platform);
    if (
      platform === 'darwin' &&
      session.agentId !== 'codex' &&
      SESSION_ID_RE.test(String(session.id || '')) &&
      resolveClaudeSession(session.id)
    ) {
      route = { kind: 'claude-desktop', label: '精确直发 · Claude 客户端', exact: true };
    }

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

    if (route.kind === 'codex-desktop') {
      let startSize = 0;
      try { startSize = fs.statSync(session.transcriptPath).size; } catch {}
      try { copyText(prompt); } catch {}
      let opened = false;
      try { opened = (await openCodexThread(session.id)) !== false; } catch {}
      if (!opened) {
        return stageFallback(session, prompt, 'Codex 客户端无法打开指定 session；Prompt 已复制。');
      }
      await new Promise((resolve) => setTimeout(resolve, desktopOpenDelayMs));
      const sent = await runFile(execImpl, 'osascript', ['-e', CODEX_DESKTOP_PASTE_SCRIPT]);
      if (!sent.ok || sent.stdout !== 'ok') {
        return {
          ok: true,
          submitted: false,
          copied: true,
          focused: opened,
          route: 'codex-desktop',
          message: '已打开指定 Codex session，但输入框粘贴失败；Prompt 已保留在剪贴板。',
        };
      }
      const verified = await verifyPrompt(session, prompt, startSize);
      if (verified) {
        return {
          ok: true,
          submitted: true,
          copied: true,
          focused: true,
          route: 'codex-desktop',
          message: '已发送到所选 Codex 客户端 session，并在对话记录中确认。',
        };
      }
      return {
        ok: true,
        submitted: false,
        copied: true,
        focused: true,
        route: 'codex-desktop',
        message: '已打开指定 Codex session 并尝试发送，但未在对话记录中确认；Prompt 已保留在剪贴板。',
      };
    }

    if (route.kind === 'claude-desktop') {
      const desktopSessionId = resolveClaudeSession(session.id);
      if (!desktopSessionId) {
        return stageFallback(session, prompt, 'Claude 客户端会话映射已失效；Prompt 已复制。');
      }
      let startSize = 0;
      try { startSize = fs.statSync(session.transcriptPath).size; } catch {}
      let opened = false;
      try { opened = (await openClaudeThread(desktopSessionId)) !== false; } catch {}
      if (!opened) {
        return stageFallback(session, prompt, 'Claude 客户端无法打开指定 session；Prompt 已复制。');
      }
      await new Promise((resolve) => setTimeout(resolve, desktopOpenDelayMs));
      // Deep-linking selects the right session but does not focus its editor.
      // Locate the actual AXTextArea ("Prompt"), set its value directly, then
      // submit so the Desktop-owned SDK stream and UI update together.
      let helper;
      try { helper = await getNativeHelper(); } catch (error) {
        try { copyText(prompt); } catch {}
        return {
          ok: true,
          submitted: false,
          copied: true,
          focused: opened,
          route: 'claude-desktop',
          message: `Claude 原生输入助手准备失败（${error.message || error}）；Prompt 已保留在剪贴板。`,
        };
      }
      const sent = await runFile(execImpl, helper, ['--set-claude-prompt', prompt, 'submit']);
      if (!sent.ok || sent.stdout !== 'ok') {
        try { copyText(prompt); } catch {}
        const reason = sent.stdout || sent.error || 'unknown';
        return {
          ok: true,
          submitted: false,
          copied: true,
          focused: opened,
          route: 'claude-desktop',
          message: `已打开指定 Claude session，但原生输入失败（${reason}）；Prompt 已保留在剪贴板。`,
        };
      }
      const verified = await verifyPrompt(session, prompt, startSize);
      if (verified) {
        return {
          ok: true,
          submitted: true,
          copied: false,
          focused: true,
          route: 'claude-desktop',
          message: '已发送到所选 Claude 客户端 session，并在对话记录中确认。',
        };
      }
      try { copyText(prompt); } catch {}
      return {
        ok: true,
        submitted: false,
        copied: true,
        focused: true,
        route: 'claude-desktop',
        message: '已打开指定 Claude session 并尝试发送，但未在对话记录中确认；Prompt 已保留在剪贴板。',
      };
    }

    if (route.kind === 'claude-resume') {
      const cli = findCliImpl('claude');
      const auth = await runFile(execImpl, cli, ['auth', 'status']);
      let loggedIn = false;
      try { loggedIn = auth.ok && JSON.parse(auth.stdout).loggedIn === true; } catch {}
      if (!loggedIn) {
        return stageFallback(
          session,
          prompt,
          'Claude CLI 当前未登录，已阻止后台续聊；Prompt 已复制并尝试聚焦目标 session。',
        );
      }
      let startSize = 0;
      try { startSize = fs.statSync(session.transcriptPath).size; } catch {}
      const resumed = await nativeResume(session, prompt, route.kind);
      if (!resumed.ok) {
        return stageFallback(session, prompt, resumed.message + ' Prompt 已复制并尝试聚焦目标 session。');
      }
      const verified = await verifyPrompt(session, prompt, startSize);
      if (verified) {
        return {
          ...resumed,
          submitted: true,
          message: '已通过 Claude CLI 续聊所选 session，并在共享对话记录中确认 Prompt。',
        };
      }
      return {
        ...resumed,
        submitted: false,
        message: 'Claude CLI 已启动，但未在共享对话记录中确认 Prompt；未将启动进程误报为发送成功。',
      };
    }

    if (route.kind === 'codex-resume') {
      const resumed = await nativeResume(session, prompt, route.kind);
      if (resumed.ok) return resumed;
      return stageFallback(session, prompt, resumed.message + ' Prompt 已复制并尝试聚焦目标 session。');
    }

    return stageFallback(session, prompt);
  }

  return { dispatch };
}

module.exports = {
  MAX_PROMPT_CHARS,
  TERMINAL_PASTE_SCRIPT,
  CODEX_DESKTOP_PASTE_SCRIPT,
  ensureNativeHelper,
  cleanTty,
  routeForSession,
  resolveClaudeDesktopSessionId,
  validPrompt,
  transcriptHasPrompt,
  waitForTranscriptPrompt,
  SESSION_ID_RE,
  CLAUDE_DESKTOP_ID_RE,
  createCommandDispatcher,
};
