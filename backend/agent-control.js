'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { spawnAgent, createCodexExecutor } = require('./codex-control');
const { classifyError } = require('./codex-status');

function createAgentExecutor(deps = {}) {
  const codex = createCodexExecutor(deps);
  const children = new Set();
  async function run(job, onThread = () => {}) {
    const agent = job.agent || 'codex';
    if (agent === 'codex') return codex.run(job, onThread);
    if (!['claude', 'dsh'].includes(agent)) return { ok: false, kind: 'failed', message: 'Unsupported agent' };
    if (!path.isAbsolute(job.cwd || '') || !fs.existsSync(job.cwd)) return { ok: false, kind: 'failed', message: '工作目录不存在 / Working directory missing' };
    const fresh = job.action === 'new_task';
    let sessionId = fresh ? (agent === 'claude' ? crypto.randomUUID() : '') : job.sessionId;
    if (!fresh && !(agent === 'claude' ? /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/).test(sessionId || '')) return { ok: false, kind: 'failed', message: 'Invalid session ID' };
    const args = agent === 'claude'
      ? ['--print', '--output-format', 'stream-json', '--verbose', fresh ? '--session-id' : '--resume', sessionId]
      : ['--profile', 'headless', '--json', ...(fresh ? [] : ['--session-id', sessionId]), '-'];
    if (agent === 'claude' && job.model) args.push('--model', job.model);
    return new Promise(resolve => {
      let child, carry = '', completed = false, final = false, failure = null, settled = false;
      const decoder = new StringDecoder('utf8');
      function finish(result) { if (settled) return; settled = true; children.delete(child); resolve({ ...result, sessionId: sessionId || job.sessionId }); }
      function row(line) {
        let e; try { e = JSON.parse(line); } catch { return; }
        const id = agent === 'claude' ? e.session_id : e.type === 'session' ? e.sessionId : '';
        if (id && id !== sessionId || id && !final) { sessionId = id; onThread(id); }
        if (agent === 'claude' && e.type === 'result') {
          final = true; completed = e.subtype === 'success' && e.is_error !== true;
          if (!completed) failure = classifyError({ message: (e.errors || []).join('\n') || e.result || e.subtype || 'Claude failed' });
        }
        if (agent === 'dsh' && e.type === 'status' && e.phase === 'turn_end') {
          const reason = e.reason || {};
          completed = reason.kind === 'completed';
          if (!completed) failure = reason.kind === 'error' ? classifyError(reason.error || reason)
            : { kind: reason.kind === 'aborted' || reason.kind === 'interrupted' ? 'interrupted' : 'failed', message: reason.kind || 'Unconfirmed DSH outcome' };
        }
        if (agent === 'dsh' && e.type === 'final') final = true;
        if (e.type === 'error') failure = classifyError(e);
      }
      try {
        child = spawnAgent(agent, args, { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, LLMPET_AUTOMATION: '1' } }, deps);
        children.add(child);
        child.on('error', err => finish({ ok: false, kind: 'failed', message: `${agent}: ${String(err.message).slice(0, 500)}` }));
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          carry += decoder.write(chunk); let nl;
          while ((nl = carry.indexOf('\n')) >= 0) { row(carry.slice(0, nl)); carry = carry.slice(nl + 1); }
          if (carry.length > 4 * 1024 * 1024) carry = '';
        });
        child.on('close', code => {
          carry += decoder.end(); if (carry) row(carry);
          if (code === 0 && completed && final) finish({ ok: true, kind: 'completed' });
          else finish({ ok: false, ...(failure || { kind: 'failed', message: `${agent} 退出，结果未确认 / Unconfirmed outcome (exit ${code}); check CLI/profile installation` }) });
        });
        child.stdin.end(job.prompt);
      } catch (err) { finish({ ok: false, kind: 'failed', message: String(err.message).slice(0, 500) }); }
    });
  }
  return { run, stop() { codex.stop(); for (const child of children) { try { child.kill(); } catch {} } children.clear(); } };
}

module.exports = { createAgentExecutor };
