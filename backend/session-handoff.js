'use strict';

// Session takeover has two deliberately different paths:
//   1. same provider  -> native resume/fork, preserving the provider transcript;
//   2. other provider -> a new visible session seeded with a local handoff packet.
//
// Claude and Codex do not share a transcript protocol. Pretending that a cross-
// provider launch is a native resume would silently lose context, so the packet
// labels its provenance and asks the receiving agent to verify every claim.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const transcript = require('./transcript');
const { launchCli, findCli } = require('./launch');
const { readLogEntries, messageText } = require('./dsh-watch');
const { agentOf } = require('./adapter');

// dsh may provide TUI resume through an installed profile, but a machine can
// legitimately have only the built-in web/headless profiles. LLMPET therefore
// does not offer dsh as a takeover target; dsh sessions remain readable sources
// for a local handoff packet to Claude or Codex.
const PROVIDERS = new Set(['claude', 'codex']);
const MESSAGE_LIMIT = 14;
const MESSAGE_CHARS = 3600;
const CONVERSATION_CHARS = 15000;
const PACKET_CHARS = 24000;
const CLEANUP_MS = 2 * 60 * 1000;

const SECRET_VALUE_RE = /\b(api[_-]?key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi;
const TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g;

function providerOf(session) {
  return agentOf(session);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (!['text', 'input_text', 'output_text'].includes(part.type)) return '';
    return typeof part.text === 'string' ? part.text : '';
  }).filter(Boolean).join('\n\n');
}

function redactSecrets(value) {
  return transcript.clean(String(value || ''))
    .replace(SECRET_VALUE_RE, (_all, key) => `${key}=[REDACTED]`)
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(TOKEN_RE, '[REDACTED]');
}

function pushMessage(out, role, text) {
  const cleaned = redactSecrets(text);
  if (!cleaned) return;
  const clipped = cleaned.length > MESSAGE_CHARS ? `${cleaned.slice(0, MESSAGE_CHARS)}…` : cleaned;
  const previous = out[out.length - 1];
  if (previous && previous.role === role && previous.text === clipped) return;
  out.push({ role, text: clipped });
}

function claudeMessages(entries, sessionId) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.isSidechain || entry.isSubagent || entry.is_subagent) continue;
    if (entry.sessionId && sessionId && entry.sessionId !== sessionId) continue;
    if (entry.type === 'user') {
      pushMessage(out, 'user', contentText(entry.message && entry.message.content));
    } else if (entry.type === 'assistant' && entry.isApiErrorMessage !== true) {
      pushMessage(out, 'assistant', contentText(entry.message ? entry.message.content : entry.content));
    }
  }
  return out;
}

function codexMessages(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    if (entry.type === 'event_msg') {
      if (payload.type === 'user_message') pushMessage(out, 'user', payload.message);
      else if (payload.type === 'agent_message') pushMessage(out, 'assistant', payload.message);
      else if (payload.type === 'task_complete') pushMessage(out, 'assistant', payload.last_agent_message);
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (payload.type === 'message') {
      const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : '';
      if (role) pushMessage(out, role, contentText(payload.content));
    } else if (payload.type === 'agent_message') {
      pushMessage(out, 'assistant', payload.message || contentText(payload.content));
    }
  }
  return out;
}

// dsh 的会话日志：surface 事件就是 user/message 与 assistant/message，
// 正文在 ContentBlock[] 里（messageText 已经处理了字符串/块两种形状）。
function dshMessages(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'user/message') {
      const src = entry.data && entry.data.source;
      if (src && typeof src === 'object' && src.kind !== 'user') continue; // 注入的上下文不算对话
      pushMessage(out, 'user', messageText(entry.data));
    } else if (entry.type === 'assistant/message') {
      pushMessage(out, 'assistant', messageText(entry.data && entry.data.message));
    }
  }
  return out;
}

function providerMessages(session, entries) {
  const provider = providerOf(session);
  if (provider === 'codex') return codexMessages(entries);
  if (provider === 'dsh') return dshMessages(entries);
  if (provider === 'claude') return claudeMessages(entries, session && session.id);
  return [];
}

function recentConversation(session, entries) {
  const messages = providerMessages(session, entries);
  const selected = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && selected.length < MESSAGE_LIMIT; i--) {
    const message = messages[i];
    if (selected.length && chars + message.text.length > CONVERSATION_CHARS) break;
    selected.unshift(message);
    chars += message.text.length;
  }
  return selected;
}

function safeGit(exec, args, cwd) {
  try {
    return redactSecrets(exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).slice(0, 5000);
  } catch {
    return '';
  }
}

function gitSnapshot(cwd, exec = execFileSync) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  const status = safeGit(exec, ['status', '--short', '--branch'], cwd);
  if (!status) return '';
  const stat = safeGit(exec, ['diff', '--stat'], cwd);
  const last = safeGit(exec, ['log', '-1', '--pretty=%h %s'], cwd);
  return [
    'Git status:', status,
    stat ? `\nUncommitted diff summary:\n${stat}` : '',
    last ? `\nCurrent commit:\n${last}` : '',
  ].filter(Boolean).join('\n');
}

function handoffCopy(locale) {
  if (locale === 'ja') return {
    title: 'LLMPET セッション引き継ぎ', source: '引き継ぎ元', conversation: '直近の会話',
    repository: '現在の作業ツリー', empty: '読み取れる会話本文はありません。作業ツリーとユーザーの次の指示から確認してください。',
    rules: [
      'これは別プロバイダーが生成したネイティブ transcript ではなく、LLMPET がローカルで作った引き継ぎ資料です。',
      '元エージェントの完了報告を事実とみなさず、現在のファイル、実行状態、失敗経路を自分で確認してください。',
      '無関係な既存変更を保持し、reset や削除を行わず、直近の未完了目標だけを続けてください。',
      '検証した内容、未検証の内容、残るリスクを分けて報告してください。',
    ],
  };
  if (locale === 'en') return {
    title: 'LLMPET session handoff', source: 'Source', conversation: 'Recent conversation',
    repository: 'Current worktree', empty: 'No readable conversation text was found. Inspect the worktree and wait for the user\'s next instruction.',
    rules: [
      'This is a local LLMPET handoff packet, not the other provider\'s native transcript.',
      'Do not trust completion claims from the source agent; verify files, runtime state, and failure paths yourself.',
      'Preserve unrelated existing changes. Do not reset or delete them. Continue only the latest unfinished objective.',
      'Report verified facts, unverified scope, and remaining risks separately.',
    ],
  };
  return {
    title: 'LLMPET 会话接管交接单', source: '来源', conversation: '最近对话',
    repository: '当前工作区', empty: '没有读取到可用的对话正文，请先检查工作区并等待用户下一条指令。',
    rules: [
      '这是 LLMPET 在本地生成的跨代理交接单，不是另一家代理的原生 transcript。',
      '不要把源代理声称的“已完成”当成事实；请亲自核查文件、运行状态和失败路径。',
      '保留无关的现有改动，不要 reset 或删除，只继续最近一项尚未完成的目标。',
      '最终分别说明已验证内容、未验证范围和剩余风险。',
    ],
  };
}

function buildHandoffPacket(session, options = {}) {
  const source = providerOf(session);
  const target = options.target === 'codex' ? 'codex' : 'claude';
  const locale = ['zh', 'en', 'ja'].includes(options.locale) ? options.locale : 'zh';
  const copy = handoffCopy(locale);
  // dsh 的日志是 zstd 分帧的自有格式，Claude 的 transcript 解析器读不了它。
  const entries = options.entries !== undefined
    ? options.entries
    : source === 'dsh'
      ? readLogEntries(session && session.transcriptPath)
      : transcript.readTail(session && session.transcriptPath);
  const messages = recentConversation(session, entries);
  const conversation = messages.length
    ? messages.map((message) => `[${message.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${message.text}`).join('\n\n')
    : copy.empty;
  const cwd = session && session.cwd ? session.cwd : '';
  const repo = options.repository !== undefined ? options.repository : gitSnapshot(cwd, options.execFileSync || execFileSync);
  const project = redactSecrets((session && session.sessionTitle) || (cwd && path.basename(cwd)) || 'session');
  const body = [
    `# ${copy.title}`,
    '',
    `## ${copy.source}`,
    `- Provider: ${source}`,
    `- Session: ${redactSecrets(session && session.id)}`,
    `- Project: ${project}`,
    `- Working directory: ${redactSecrets(cwd)}`,
    `- Target provider: ${target}`,
    '',
    `## ${copy.conversation}`,
    conversation,
    '',
    repo ? `## ${copy.repository}\n${repo}` : '',
    '',
    '## Handoff rules',
    ...copy.rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].filter((part) => part !== '').join('\n');
  return body.length > PACKET_CHARS ? `${body.slice(0, PACKET_CHARS)}\n\n[truncated by LLMPET]` : body;
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function nativeArgs(provider, sessionId, fork) {
  if (provider === 'codex') return [fork ? 'fork' : 'resume', sessionId];
  return fork ? ['--resume', sessionId, '--fork-session'] : ['--resume', sessionId];
}

function writePromptFile(packet, deps = {}) {
  const fsImpl = deps.fs || fs;
  const base = deps.tmpdir ? deps.tmpdir() : os.tmpdir();
  const dir = fsImpl.mkdtempSync(path.join(base, 'llmpet-handoff-'));
  try { fsImpl.chmodSync(dir, 0o700); } catch {}
  const promptFile = path.join(dir, 'handoff.md');
  fsImpl.writeFileSync(promptFile, packet, { encoding: 'utf8', mode: 0o600 });
  return { dir, promptFile };
}

function createSessionTakeover(deps = {}) {
  const launch = deps.launchCli || launchCli;
  const find = deps.findCli || findCli;
  const fsImpl = deps.fs || fs;
  const schedule = deps.setTimeout || setTimeout;

  async function takeOver(session, target, options = {}) {
    if (!session || session.headless || !session.id) return { ok: false, code: 'invalid-target' };
    if (!PROVIDERS.has(target)) return { ok: false, code: 'invalid-provider' };
    const source = providerOf(session);
    // A non-empty, unrecognised agentId must never become a Claude native
    // resume or a cross-provider packet that falsely claims Claude provenance.
    // dsh remains an allowed source below, while still not being a target.
    if (!['claude', 'codex', 'dsh'].includes(source)) {
      return { ok: false, code: 'invalid-source-provider', source };
    }
    const cwd = session.cwd && fsImpl.existsSync(session.cwd) ? session.cwd : os.homedir();
    const cli = find(target);
    if (path.isAbsolute(cli) && !fsImpl.existsSync(cli)) return { ok: false, code: 'cli-missing', target };

    if (source === target) {
      const fork = pidAlive(session.sourcePid) || ['thinking', 'working', 'juggling', 'sweeping', 'waiting', 'needsinput', 'loafing'].includes(session.state);
      const result = await launch(target, {
        cwd,
        args: nativeArgs(target, String(session.id), fork),
        keepOpen: true,
        terminalTitle: `LLMPET Takeover · ${target === 'codex' ? 'Codex' : 'Claude'}`,
      });
      return result.ok
        ? { ok: true, code: fork ? 'native-fork' : 'native-resume', mode: fork ? 'native-fork' : 'native-resume', source, target }
        : { ok: false, code: 'launch-failed', source, target, detail: result.message || '' };
    }

    const packet = buildHandoffPacket(session, { target, locale: options.locale });
    const temp = writePromptFile(packet, { fs: fsImpl, tmpdir: deps.tmpdir });
    let result;
    try {
      result = await launch(target, {
        cwd,
        args: [],
        promptFile: temp.promptFile,
        keepOpen: true,
        terminalTitle: `LLMPET Handoff · ${target === 'codex' ? 'Codex' : 'Claude'}`,
      });
    } catch (error) {
      result = { ok: false, message: error && error.message ? error.message : String(error) };
    }
    if (!result.ok) {
      try { fsImpl.rmSync(temp.dir, { recursive: true, force: true }); } catch {}
      return { ok: false, code: 'launch-failed', source, target, detail: result.message || '' };
    }
    const timer = schedule(() => {
      try { fsImpl.rmSync(temp.dir, { recursive: true, force: true }); } catch {}
    }, CLEANUP_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { ok: true, code: 'handoff-launched', mode: 'structured-handoff', source, target, packetChars: packet.length };
  }

  return { takeOver };
}

module.exports = {
  buildHandoffPacket,
  claudeMessages,
  codexMessages,
  dshMessages,
  createSessionTakeover,
  gitSnapshot,
  nativeArgs,
  providerOf,
  recentConversation,
  redactSecrets,
};
