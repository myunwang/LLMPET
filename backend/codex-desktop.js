'use strict';

// Same local, length-prefixed JSON-RPC transport used by the bundled
// codex-app-tools MCP. This is an app integration, not another app-server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { classifyError } = require('./codex-status');
const MAX_FRAME = 8 * 1024 * 1024;

function createPipeClient(pipePath, options = {}) {
  const connect = options.connect || net.createConnection;
  let socket, opening, connecting, buffer = Buffer.alloc(0), nextId = 0, closed = false;
  const pending = new Map();
  function disconnect(err, current = socket) {
    if (current && current !== socket) return;
    current?.destroy(); socket = null; buffer = Buffer.alloc(0);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(err); }
    pending.clear();
  }
  async function open() {
    if (closed) throw new Error('Desktop connection closed');
    if (socket && !socket.destroyed) return;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const current = connect(pipePath);
      opening = current;
      const timeout = setTimeout(() => { current.destroy(); reject(new Error('Desktop connection timed out')); }, options.connectTimeoutMs || 2000);
      current.once('error', reject);
      current.once('connect', () => { clearTimeout(timeout); opening = null; if (closed) { current.destroy(); reject(new Error('Desktop connection closed')); return; } socket = current; resolve(); });
      current.on('error', err => { clearTimeout(timeout); disconnect(err, current); });
      current.on('close', () => disconnect(new Error('Desktop connection closed'), current));
      current.on('data', chunk => {
        if (current !== socket) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > MAX_FRAME) { disconnect(new Error('Desktop response too large')); return; }
          if (buffer.length < length + 4) return;
          let row;
          try { row = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')); }
          catch { disconnect(new Error('Invalid desktop response')); return; }
          buffer = buffer.subarray(length + 4);
          const entry = pending.get(row.id); if (!entry) continue;
          pending.delete(row.id); clearTimeout(entry.timer);
          if (row.error) entry.reject(new Error(row.error.message || 'Desktop request failed'));
          else entry.resolve(row.result);
        }
      });
    });
    try { await connecting; } finally { connecting = null; }
  }
  return {
    async request(method, params, timeoutMs = 20000) {
      await open();
      const id = ++nextId, payload = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
      if (payload.length > MAX_FRAME) throw new Error('Desktop request too large');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop request timed out')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
        const current = socket;
        current.write(Buffer.concat([header, payload]), err => { if (err) disconnect(err, current); });
      });
    },
    close() { closed = true; opening?.destroy(new Error('Desktop connection closed')); disconnect(new Error('Desktop connection closed')); },
  };
}

function pipeCandidates(options = {}) {
  const env = options.env || process.env, platform = options.platform || process.platform;
  const paths = [];
  if (env.CODEX_APP_TOOLS_PIPE_PATH) paths.push(env.CODEX_APP_TOOLS_PIPE_PATH.trim());
  const readdir = options.readdir || fs.readdirSync;
  try {
    if (platform === 'win32') {
      for (const name of readdir('\\\\.\\pipe\\')) if (/^codex-app-tools-[a-z0-9-]+$/i.test(name)) paths.push(`\\\\.\\pipe\\${name}`);
    } else {
      for (const dir of new Set([os.tmpdir(), '/tmp'])) for (const name of readdir(dir)) {
        if (/^codex-app-tools-.*\.sock$/.test(name)) paths.push(path.join(dir, name));
      }
    }
  } catch {}
  return [...new Set(paths)];
}

async function desktopProcessRunning(options = {}) {
  if (options.isRunning) return options.isRunning();
  const platform = options.platform || process.platform, env = options.env || process.env;
  const [file, args] = platform === 'win32'
    ? [path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' OR Name='Codex.exe'\" | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"]]
    : ['/bin/ps', ['-axo', 'comm=']];
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) { reject(new Error('Cannot detect Codex desktop process')); return; }
    if (platform !== 'win32') { resolve(/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)/.test(stdout)); return; }
    try {
      const rows = JSON.parse(stdout || '[]');
      resolve([].concat(rows || []).some(r => /(?:OpenAI[\\/]Codex|OpenAI\.Codex_|[\\/]Codex[\\/])/i.test(r.ExecutablePath || '')
        && !/\bapp-server\b|[\\/]bin[\\/]/i.test(`${r.ExecutablePath} ${r.CommandLine}`)));
    } catch { reject(new Error('Invalid desktop process response')); }
  }));
}

async function probeDesktop(options = {}) {
  for (const pipePath of (options.pipeCandidates || pipeCandidates)(options)) {
    const client = (options.createClient || createPipeClient)(pipePath, options);
    try {
      const result = await client.request('tools/list', { threadStartKind: 'all' });
      const tools = new Map((result.tools || []).filter(t => t.namespace === 'codex_app').map(t => [t.name, t]));
      if (['send_message_to_thread', 'read_thread', 'wait_threads'].every(n => tools.has(n))) return { running: true, client, tools };
    } catch {} // A stale environment pipe can survive a desktop restart.
    client.close();
  }
  return { running: await desktopProcessRunning(options) };
}

function unpack(result) {
  const text = (result.contentItems || []).filter(c => c.type === 'inputText').map(c => c.text).join('\n');
  if (!result.success) throw new Error(text || 'Desktop tool rejected the request');
  try { return JSON.parse(text); } catch { throw new Error('Invalid desktop tool response'); }
}
const normalized = value => String(value || '').replace(/\r\n/g, '\n').trim();
function matchesPrompt(turn, prompt) {
  return (turn.items || []).some(item => {
    if (item.type === 'userMessage') return normalized((item.content || []).filter(c => c.type === 'text').map(c => c.text).join('')) === normalized(prompt);
    // Native cross-chat follow-ups are persisted as delegated tool input.
    if (item.type !== 'functionCallOutput' || item.name !== 'send_message_to_thread' || item.namespace !== 'codex_app') return false;
    const raw = typeof item.output === 'string' ? item.output : item.output?.text;
    const match = /<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(raw || '');
    return !!match && normalized(match[1]) === normalized(prompt);
  });
}
function matchingTurn(history, previousId, prompt) {
  for (const turn of history.turns || []) {
    if (turn.id === previousId) break;
    if (matchesPrompt(turn, prompt)) return turn;
  }
  return null;
}

function createDesktopExecutor(options = {}) {
  const active = new Set();
  async function runIfAvailable(job, onThread = () => {}) {
    let connection;
    try { connection = await (options.probe || probeDesktop)(options); }
    catch (err) { return { ok: false, kind: 'desktop_unavailable', executorRoute: 'desktop', message: `无法确认桌面发送通道，稍后重试 / Desktop detection failed: ${err.message}` }; }
    if (!connection.running) return null;
    if (!connection.client) return { ok: false, kind: 'desktop_unavailable', executorRoute: 'desktop', message: 'Codex 桌面端正在运行，原生发送通道尚未就绪，稍后重试 / Waiting for Codex desktop messaging' };
    const { client, tools } = connection;
    const state = { client, stopped: false }; active.add(state);
    let submitted = false, sessionId = job.sessionId, turnId = '', acknowledgementError = '';
    // Actual task attribution, using the same metadata contract as the app's
    // bundled MCP client. A user-configured rule authorizes its saved prompt.
    const callerId = options.env?.CODEX_THREAD_ID || process.env.CODEX_THREAD_ID || job.sessionId;
    async function call(name, args) {
      const tool = tools.get(name); if (!tool) throw new Error(`Desktop tool unavailable: ${name}`);
      return unpack(await client.request('tools/call', { arguments: args, callerSource: 'codex',
        namespace: tool.namespace, tool: tool.name, threadId: callerId,
        callId: `llmpet-${crypto.randomUUID()}`, turnId: `llmpet-${crypto.randomUUID()}` }));
    }
    try {
      onThread(sessionId, { executorRoute: 'desktop' });
      let previousTurn = '';
      if (job.action === 'new_task') {
        const projects = await call('list_projects', {});
        const project = (projects.projects || []).find(p => p.hostId === 'local' && p.path && path.resolve(p.path).toLowerCase() === path.resolve(job.cwd).toLowerCase());
        if (!project) return { ok: false, kind: 'failed', executorRoute: 'desktop', message: '请先将新任务工作目录添加到 Codex 桌面项目 / Add this working directory as a Codex project first' };
        submitted = true;
        const created = await call('create_thread', { prompt: job.prompt, target: { type: 'project', projectId: project.projectId, environment: { type: 'local' } } });
        if (!created.threadId) throw new Error('Desktop did not return the new chat ID');
        sessionId = created.threadId; onThread(sessionId, { executorRoute: 'desktop' });
      } else {
        const before = await call('read_thread', { threadId: sessionId, hostId: 'local', turnLimit: 1, maxOutputCharsPerItem: 0 });
        if (before.thread?.status?.type === 'active' || before.turns?.[0]?.status === 'inProgress') return { ok: false, kind: 'session_busy', executorRoute: 'desktop', message: '原会话仍在运行，等待本轮结束后由桌面端继续 / Waiting for the active desktop turn' };
        previousTurn = before.turns?.[0]?.id || '';
        submitted = true;
        try { await call('send_message_to_thread', { threadId: sessionId, hostId: 'local', prompt: job.prompt }); }
        catch (err) {
          // Delivery can commit before the caller's acknowledgement fails.
          // Reconcile against the new turn; never submit the prompt twice.
          acknowledgementError = err.message;
        }
      }
      let cursor, matched = false;
      const deadline = Date.now() + (options.maxWaitMs || 24 * 3600000);
      const deliveryDeadline = Date.now() + (options.deliveryTimeoutMs || 30000);
      while (!state.stopped && Date.now() < deadline) {
        let result, history;
        try {
          result = await call('wait_threads', { targets: [{ threadId: sessionId, hostId: 'local', ...(cursor ? { afterCursor: cursor } : {}) }], timeoutMs: options.pollMs ?? 10000 });
          if (result.errors?.length || !result.polls?.length) throw new Error('Desktop wait unavailable');
        } catch {
          history = await call('read_thread', { threadId: sessionId, hostId: 'local', turnLimit: 3, includeOutputs: true, maxOutputCharsPerItem: 20000 });
          result = { polls: [{ thread: { id: sessionId }, latestTurn: history.turns?.[0] }], timedOut: false };
          await new Promise(resolve => setTimeout(resolve, options.idleDelayMs ?? 1000));
        }
        const poll = result.polls.find(p => p.thread?.id === sessionId);
        if (!poll) throw new Error('Desktop returned no target chat status');
        cursor = poll.cursor || cursor;
        const turn = poll.latestTurn;
        if (turn && turn.id !== previousTurn && (!turnId || turn.id !== turnId)) {
          history = history || await call('read_thread', { threadId: sessionId, hostId: 'local', turnLimit: 3, includeOutputs: true, maxOutputCharsPerItem: 20000 });
          const actual = matchingTurn(history, previousTurn, job.prompt);
          if (actual) { turnId = actual.id; matched = true; }
        }
        const outcome = history?.turns?.find(t => t.id === turnId) || (turn?.id === turnId ? turn : null);
        if (matched && outcome) {
          if (outcome.status === 'completed') return { ok: true, kind: 'completed', sessionId, desktopTurnId: turnId, executorRoute: 'desktop' };
          if (['failed', 'interrupted'].includes(outcome.status)) return { ok: false,
            ...(outcome.status === 'interrupted' ? { kind: 'interrupted', message: 'Desktop turn interrupted' } : classifyError(outcome.error || { message: outcome.status })),
            sessionId, desktopTurnId: turnId, executorRoute: 'desktop' };
        }
        if (!matched && Date.now() >= deliveryDeadline) break;
        // Attention/idle snapshots can return immediately even with a cursor.
        // Keep approval waits and transport fallback from becoming a busy loop.
        await new Promise(resolve => setTimeout(resolve, options.idleDelayMs ?? 500));
      }
      throw new Error(`Desktop completion is unconfirmed; inspect the original chat${acknowledgementError ? ` (${acknowledgementError})` : ''}`);
    } catch (err) {
      return { ok: false, kind: submitted ? 'submission_unknown' : 'desktop_unavailable', sessionId,
        desktopTurnId: turnId, executorRoute: 'desktop', message: `${submitted ? '桌面请求可能已提交，请查看原会话，不会重复发送' : '桌面发送通道暂不可用，稍后重试'} / ${err.message}`.slice(0, 1600) };
    } finally { active.delete(state); client.close(); }
  }
  return { runIfAvailable, stop() { for (const state of active) { state.stopped = true; state.client.close(); } } };
}

module.exports = { createPipeClient, pipeCandidates, desktopProcessRunning, probeDesktop, createDesktopExecutor };
