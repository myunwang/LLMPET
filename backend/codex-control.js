'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { findCli } = require('./launch');
const { classifyError, normalizeQuota } = require('./codex-status');
const { createDesktopExecutor } = require('./codex-desktop');

function spawnAgent(name, args, options = {}, deps = {}) {
  const cli = (deps.findCli || findCli)(name);
  const spawnImpl = deps.spawn || spawn;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    const quote = s => `'${String(s).replace(/'/g, "''")}'`;
    const script = `& ${[cli, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
  }
  return spawnImpl(cli, args, options);
}
const spawnCodex = (args, options, deps) => spawnAgent('codex', args, options, deps);

// Only read account/config metadata. Never start or resume a model turn here.
function readAccountQuotas(deps = {}) {
  return new Promise(resolve => {
    let child, carry = '', done = false, account = false, provider = '', bytes = 0;
    const pending = new Map();
    let nextId = 0;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, message: '额度查询超时 / Quota query timed out' }), deps.timeoutMs || 20000);
    const request = (method, params, handler) => { const id = ++nextId; pending.set(id, handler); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); };
    try {
      child = spawnCodex(['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }, deps);
      child.on('error', () => finish({ ok: false, message: '无法启动 Codex CLI / Cannot launch Codex CLI' }));
      child.on('close', () => finish({ ok: false, message: '额度查询连接已关闭 / Quota connection closed' }));
      child.stdin.on('error', () => finish({ ok: false, message: '额度查询连接失败 / Quota connection failed' }));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { finish({ ok: false, message: 'Quota response too large' }); return; }
        carry += chunk.toString('utf8');
        let nl;
        while (!done && (nl = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
          let row; try { row = JSON.parse(line); } catch { continue; }
          const handler = pending.get(row.id);
          if (handler) { pending.delete(row.id); if (row.error) finish({ ok: false, message: '当前登录方式无法读取额度 / Quotas unavailable for this login' }); else handler(row.result || {}); }
        }
      });
      request('initialize', { clientInfo: { name: 'llmpet_quota', title: 'LLMPET', version: '1.1.1' } }, () => {
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        request('account/read', { refreshToken: false }, result => {
          account = ['chatgpt', 'chatgptAuthTokens'].includes(result.account && result.account.type);
          if (!account) { finish({ ok: false, message: '非 ChatGPT 登录；等待匹配的会话额度快照 / Waiting for matching rollout quota' }); return; }
          request('config/read', { includeLayers: false }, cfg => {
            provider = cfg.config && cfg.config.model_provider || 'openai';
            request('account/rateLimits/read', {}, limits => {
              const raw = limits.rateLimitsByLimitId || (limits.rateLimits ? { codex: limits.rateLimits } : {});
              const quotas = Object.entries(raw).map(([id, value]) => normalizeQuota({ ...value, limitId: value.limitId || id }))
                .filter(Boolean).map(q => ({ ...q, provider: 'openai', providerVerified: true, source: 'account' }));
              finish({ ok: quotas.length > 0, provider: 'openai', inferenceProvider: provider, quotas, message: quotas.length ? '' : '未返回额度窗口 / No quota windows returned' });
            });
          });
        });
      });
    } catch { finish({ ok: false, message: '无法查询额度 / Quota query failed' }); }
  });
}

function createCodexExecutor(deps = {}) {
  const children = new Set();
  const desktop = deps.desktop === false ? null : deps.desktopExecutor || createDesktopExecutor(deps.desktopOptions);
  async function run(job, onThread = () => {}) {
    if (!path.isAbsolute(job.cwd || '') || !fs.existsSync(job.cwd)) return { ok: false, kind: 'failed', message: '工作目录不存在 / Working directory missing' };
    if (job.action !== 'new_task' && !/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(job.sessionId || '')) return { ok: false, kind: 'failed', message: 'Invalid session ID' };
    if (desktop) {
      const result = await desktop.runIfAvailable(job, onThread);
      if (result) return result;
    }
    onThread(job.sessionId, { executorRoute: 'cli' });
    const args = job.action === 'new_task'
      ? ['exec', '--json', '--skip-git-repo-check', '-']
      : ['exec', 'resume', '--json', '--skip-git-repo-check', job.sessionId, '-'];
    if (job.model) args.unshift('-c', `model=${JSON.stringify(job.model)}`);
    if (job.provider) args.unshift('-c', `model_provider=${JSON.stringify(job.provider)}`);
    // No approval/sandbox bypass flags. A resumed CLI uses its configured
    // provider and policies; unsupported approvals fail visibly.
    return new Promise(resolve => {
      let child, carry = '', stderr = '', threadId = job.sessionId, completed = false, failure = null, settled = false;
      const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
      const finish = result => { if (settled) return; settled = true; children.delete(child); resolve({ ...result, sessionId: threadId, executorRoute: 'cli' }); };
      function line(text) {
        let event; try { event = JSON.parse(text); } catch { return; }
        if (event.type === 'thread.started' && event.thread_id) { threadId = event.thread_id; onThread(threadId); }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed') failure = classifyError(event.error || event);
        if (event.type === 'error') failure = classifyError(event);
        if (event.type === 'turn.started') failure = null;
      }
      try {
        child = spawnCodex(args, { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LLMPET_AUTOMATION: '1' } }, deps);
        children.add(child);
        child.on('error', err => finish({ ok: false, kind: 'failed', message: err.code === 'ENOENT'
          ? '找不到 Codex CLI。请检查 Codex 安装，再重新设置执行时间 / Codex CLI not found; check installation, then reschedule'
          : String(err.message).slice(0, 500) }));
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          carry += decoder.write(chunk);
          let nl; while ((nl = carry.indexOf('\n')) >= 0) { line(carry.slice(0, nl)); carry = carry.slice(nl + 1); }
          if (carry.length > 2 * 1024 * 1024) carry = '';
        });
        child.stderr?.on('data', chunk => { stderr = (stderr + errorDecoder.write(chunk)).slice(-16000); });
        child.on('close', code => {
          carry += decoder.end(); stderr += errorDecoder.end();
          if (carry) line(carry);
          const diagnostic = stderr.replace(/\x1b\[[0-9;]*m/g, '').replace(/(authorization\s*[:=]\s*)[^\r\n]+/gi, '$1<REDACTED>')
            .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer <REDACTED>').replace(/((?:api[\s_-]?key|(?:access[_-]?|refresh[_-]?)?token)\s*[:=]\s*)[^\s,;]+/gi, '$1<REDACTED>')
            .replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED>').split(/\r?\n/).filter(l => l.trim() && !/\bWARN\b/.test(l)).slice(-5).join('\n').slice(-1600);
          if (code === 0 && completed) finish({ ok: true, kind: 'completed' });
          else if (/already has an active writer|thread-store conflict/i.test(diagnostic || failure?.message || '')) finish({ ok: false, kind: 'session_busy', message: `会话正被 Codex 桌面端或其他进程占用；释放后自动重试，也可在原会话继续 / Waiting for the session writer to release\n${diagnostic || failure.message}` });
          else if (diagnostic && !failure?.message) finish({ ok: false, ...classifyError({ message: diagnostic }) });
          else finish({ ok: false, ...(failure || { kind: 'failed', message: `Codex 退出，结果未确认 / Unconfirmed outcome (exit ${code})` }) });
        });
        child.stdin.end(job.prompt);
      } catch (err) { finish({ ok: false, kind: 'failed', message: String(err.message).slice(0, 500) }); }
    });
  }
  return { run, stop: () => { desktop?.stop(); for (const child of children) { try { child.kill(); } catch {} } children.clear(); } };
}

module.exports = { spawnAgent, spawnCodex, readAccountQuotas, createCodexExecutor };
