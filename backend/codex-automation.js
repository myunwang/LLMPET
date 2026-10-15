'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { quotaAvailable } = require('./codex-status');

const TRIGGERS = ['completed', 'ended', 'quota_exhausted', 'quota_restored', 'transient_error', 'failed', 'interrupted'];
const ACTIONS = ['continue', 'wait_quota', 'new_task', 'shutdown'];
const TERMINAL = new Set(['completed', 'quota_exhausted', 'transient_error', 'failed', 'interrupted']);
const PENDING = new Set(['scheduled', 'waiting_quota', 'waiting_idle']);
const text = (v, max = 256) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const uuid = () => crypto.randomUUID();
const DEFAULT_PROMPT = '继续原任务。先核对已完成的工作和当前状态，只继续尚未完成的部分；不要重复已经完成的外部操作。';
const AGENTS = ['codex', 'claude', 'dsh'];
const sessionKey = (agent, id) => `${agent || 'codex'}:${id}`;

function normalizeRule(input) {
  if (!input || !TRIGGERS.includes(input.trigger) || !ACTIONS.includes(input.action)) throw new Error('Invalid trigger or action');
  const sessionId = text(input.sessionId);
  const agent = input.agent || 'codex';
  if (!AGENTS.includes(agent)) throw new Error('Invalid agent');
  const validId = agent === 'dsh' ? /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sessionId) : /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(sessionId);
  if (!validId) throw new Error('请选择或填写有效的会话 ID / Select a valid session');
  const number = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback));
  const prompt = input.action === 'shutdown' ? '' : text(input.prompt, 12000) || DEFAULT_PROMPT;
  if (input.action === 'new_task' && !text(input.prompt)) throw new Error('新任务需要填写任务内容 / New task requires a prompt');
  if (input.action === 'wait_quota' && !['quota_exhausted', 'quota_restored'].includes(input.trigger)) throw new Error('等待额度动作需要额度触发条件 / Choose a quota trigger');
  return { id: text(input.id, 80) || uuid(), name: text(input.name, 100) || `${input.trigger} → ${input.action}`,
    enabled: input.enabled === true, agent, sessionId, trigger: input.trigger, action: input.action,
    prompt, cwd: input.action === 'new_task' ? text(input.cwd, 2048) : '',
    limitId: input.trigger === 'quota_restored' || input.trigger === 'quota_exhausted' && input.action !== 'shutdown'
      ? text(input.limitId, 100) : '',
    delaySeconds: number(input.delaySeconds, 15, input.action === 'shutdown' ? 60 : 0, 86400),
    maxRuns: number(input.maxRuns, input.action === 'continue' || input.action === 'wait_quota' ? 3 : 1, 1, 100),
    onlyWhenIdle: input.onlyWhenIdle !== false };
}

function powerOff(platform = process.platform, run = execFile) {
  const [file, args] = platform === 'win32' ? ['shutdown.exe', ['/s', '/t', '0']]
    : platform === 'darwin' ? ['osascript', ['-e', 'tell application "System Events" to shut down']]
    : ['systemctl', ['poweroff']];
  return new Promise(resolve => run(file, args, { windowsHide: true, timeout: 15000 }, err => resolve({ ok: !err, message: err ? String(err.message).slice(0, 500) : '' })));
}

function createCodexAutomation(deps = {}) {
  const statePath = deps.statePath || path.join(os.homedir(), '.octopus', 'codex-automation.json');
  const now = deps.now || Date.now;
  const onChange = deps.onChange || (() => {});
  let state = { rules: [], jobs: [], history: [], seen: [], counts: {}, quotas: {} };
  let loadError = '';
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.rules) || !Array.isArray(saved.jobs)
        || !Array.isArray(saved.history) || !Array.isArray(saved.seen)
        || !saved.counts || typeof saved.counts !== 'object' || !saved.quotas || typeof saved.quotas !== 'object'
        || !saved.jobs.every(j => j && typeof j === 'object' && ACTIONS.includes(j.action))) throw new Error('Invalid automation state');
    state = { ...state, ...saved, rules: saved.rules.map(normalizeRule) };
    for (const job of state.jobs) {
      job.agent = job.agent || 'codex';
      // Never replay a power action or a possibly-submitted task after restart.
      if (PENDING.has(job.status) && job.status !== 'waiting_quota' || job.status === 'running') {
        job.status = 'cancelled'; job.message = '应用已重启，取消未确认的动作 / Restarted; action cancelled';
      }
    }
  } catch (err) { if (err.code !== 'ENOENT') loadError = '自动化记录无法读取，执行已暂停 / Automation state unreadable'; }
  const sessions = new Map(), running = new Map();
  let timer = null, ticking = false, stopped = false, queryAt = 0, queryMessage = '', queryBusy = false;

  function log(kind, message, fields = {}) {
    state.history.unshift({ id: uuid(), at: now(), kind, message: text(message, 1600), ...fields });
    state.history = state.history.slice(0, 200);
  }
  function commit() {
    if (loadError) throw new Error(loadError);
    // Persistence happens BEFORE side effects, so a crash cannot replay a job.
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...state, version: 1 }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (err) { loadError = '无法保存自动化记录，执行已暂停 / Cannot persist automation state'; onChange(); throw err; }
    onChange();
  }
  function snapshot() {
    return JSON.parse(JSON.stringify({ ...state, sessions: [...sessions.values()], queryMessage, queryAt, error: loadError, now: now() }));
  }
  function saveRule(input) {
    if (loadError) throw new Error(loadError);
    const rule = normalizeRule(input);
    if (rule.agent !== 'codex' && (rule.trigger === 'quota_restored' || rule.action === 'wait_quota'
        || rule.trigger === 'quota_exhausted' && rule.action !== 'shutdown')) throw new Error('该 Agent 尚无可验证的额度恢复接口；额度耗尽时可选择关机 / Quota recovery is unavailable for this agent');
    if (!state.rules.some(r => r.id === rule.id) && state.rules.length >= 100) throw new Error('最多 100 条规则 / Maximum 100 rules');
    // An edit invalidates pending actions created from the old rule.
    for (const job of state.jobs) if (job.ruleId === rule.id && PENDING.has(job.status)) job.status = 'cancelled';
    state.rules = [...state.rules.filter(r => r.id !== rule.id), rule];
    log('rule_saved', rule.name, { ruleId: rule.id }); commit(); return rule;
  }
  function removeRule(id) {
    state.rules = state.rules.filter(r => r.id !== id);
    for (const job of state.jobs) if (job.ruleId === id && PENDING.has(job.status)) job.status = 'cancelled';
    log('rule_removed', '', { ruleId: id }); commit();
  }
  function cancelJob(id) {
    const job = state.jobs.find(j => j.id === id);
    if (!job || !PENDING.has(job.status)) return false;
    job.status = 'cancelled'; log('cancelled', '', { jobId: id }); commit(); return true;
  }
  function resetCount(id) {
    if (state.jobs.some(j => j.ruleId === id && (PENDING.has(j.status) || j.status === 'running'))) throw new Error('请先等待或取消待执行动作 / Finish or cancel pending actions first');
    state.counts[id] = 0; commit();
  }
  function quotaKey(provider, id) { return `${provider || 'unknown'}:${id || 'codex'}`; }
  function schedule(event) {
    for (const rule of state.rules) {
      const matches = rule.trigger === 'ended' ? TERMINAL.has(event.kind) : rule.trigger === event.kind;
      if (!rule.enabled || rule.agent !== (event.agent || 'codex') || rule.sessionId !== event.sessionId || !matches) continue;
      if (deps.isAgentEnabled && !deps.isAgentEnabled(rule.agent)) continue;
      if (event.kind === 'quota_restored' && (rule.limitId || event.sourceLimitId || event.limitId || 'codex') !== event.limitId) continue;
      const count = Number(state.counts[rule.id]) || 0;
      if (count >= rule.maxRuns) continue;
      if (state.jobs.some(j => j.ruleId === rule.id && (PENDING.has(j.status) || j.status === 'running'))) continue;
      const limitId = rule.limitId || event.limitId || 'codex';
      // If an exhausted source requests another inference action, wait for
      // recovery first as well. Shutdown remains independently selectable.
      const wait = rule.action === 'wait_quota' && event.kind !== 'quota_restored'
        || event.kind === 'quota_exhausted' && ['continue', 'new_task'].includes(rule.action);
      const job = { id: uuid(), agent: rule.agent, ruleId: rule.id, ruleName: rule.name, sessionId: event.sessionId,
        trigger: event.kind, action: rule.action, prompt: rule.prompt,
        cwd: rule.cwd || event.cwd || '', provider: event.provider || '', model: event.model || '', limitId,
        status: wait ? 'waiting_quota' : 'scheduled', createdAt: now(), blockedAt: event.blockedAt || event.at || now(),
        requiresQuota: rule.action !== 'shutdown' && (wait || event.kind === 'quota_restored'),
        dueAt: now() + rule.delaySeconds * 1000 * (rule.action === 'continue' ? Math.min(16, 2 ** count) : 1),
        delaySeconds: rule.delaySeconds, onlyWhenIdle: rule.onlyWhenIdle };
      if (wait && rule.agent !== 'codex') job.message = '额度耗尽，缺少可验证的恢复接口，保持挂起 / Quota exhausted; automatic recovery unavailable';
      state.jobs.unshift(job); state.counts[rule.id] = count + 1;
      log(job.status, '', { jobId: job.id, ruleId: rule.id, sessionId: job.sessionId });
    }
    state.jobs = state.jobs.filter((j, i) => i < 200 || PENDING.has(j.status) || j.status === 'running');
  }
  function observe(event) {
    if (!event || !event.sessionId) return;
    event = { ...event, agent: event.agent || 'codex' };
    const identity = sessionKey(event.agent, event.sessionId);
    const prev = sessions.get(identity) || {};
    if (prev.at && event.at && event.at < prev.at) return;
    const next = { ...prev, ...event };
    sessions.set(identity, next);
    if (sessions.size > 500) { const oldest = [...sessions.values()].sort((a, b) => a.at - b.at)[0]; if (oldest) sessions.delete(sessionKey(oldest.agent, oldest.sessionId)); }
    if (event.seed || !TERMINAL.has(event.kind)) {
      // User activity supersedes a queued retry, even while waiting for quota.
      let changed = false;
      if (!event.seed && ['running', 'waiting_input'].includes(event.kind)) {
        for (const job of state.jobs) if (sessionKey(job.agent, job.sessionId) === identity && PENDING.has(job.status) && !running.has(identity)) {
          job.status = 'cancelled'; log('superseded', '', { jobId: job.id }); changed = true;
        }
      }
      if (changed) commit(); else onChange(); return;
    }
    const managed = running.get(identity);
    if (managed) { managed.observedEvent = next; return; }
    const legacyKey = `${event.sessionId}:${event.turnId || event.at}`;
    const key = `${event.agent}:${legacyKey}`;
    if (state.seen.includes(key) || event.agent === 'codex' && state.seen.includes(legacyKey) || loadError || stopped) return;
    state.seen.push(key); state.seen = state.seen.slice(-2000);
    if (event.kind === 'quota_exhausted') next.blockedAt = event.at || now();
    schedule(next); commit();
  }
  function observeQuota(quota, options = {}) {
    if (!quota || !quota.provider || loadError) return;
    quota = { ...quota, agent: quota.agent || 'codex' };
    if (quota.agent !== 'codex') return; // No account quota API is assumed for other providers.
    const key = quotaKey(quota.provider, quota.limitId);
    const prior = state.quotas[key];
    if (prior && prior.at >= quota.at) return;
    state.quotas[key] = quota;
    if (!options.seed) {
      for (const session of sessions.values()) {
        const sourceLimitId = session.limitId || 'codex';
        const matches = sourceLimitId === quota.limitId || state.rules.some(r => r.agent === session.agent && r.sessionId === session.sessionId
          && r.trigger === 'quota_restored' && r.limitId === quota.limitId);
        if (session.agent === quota.agent && session.kind === 'quota_exhausted' && session.provider === quota.provider
            && matches && quotaAvailable(quota, session.blockedAt || session.at, now())) {
          session.quotaRecoveredAt = quota.at;
          const event = { ...session, kind: 'quota_restored', at: quota.at, sourceLimitId, limitId: quota.limitId };
          const eventKey = `quota:${session.sessionId}:${session.turnId || session.blockedAt}:${quota.limitId}`;
          if (!state.seen.includes(eventKey)) { state.seen.push(eventKey); state.seen = state.seen.slice(-2000); schedule(event); }
        }
      }
    }
    if (options.seed) onChange(); else commit();
  }
  async function refreshQuotas() {
    if (queryBusy || !deps.readQuotas || loadError || stopped) return;
    queryBusy = true; queryAt = now(); onChange();
    try {
      const result = await deps.readQuotas();
      queryMessage = result.message || '';
      if (!stopped) for (const quota of result.quotas || []) observeQuota(quota);
    } catch { queryMessage = '额度查询失败，继续等待 / Quota check failed; still waiting'; }
    finally { queryBusy = false; onChange(); }
  }
  async function execute(job) {
    if (job.action === 'shutdown') {
      job.status = 'running'; commit();
      let result;
      try { result = await (deps.powerOff || powerOff)(); }
      catch (err) { result = { ok: false, message: text(err.message, 500) }; }
      job.status = result.ok ? 'completed' : 'failed'; job.message = result.message || '';
      log(job.status, job.message, { jobId: job.id }); commit(); return;
    }
    if (!deps.run) { job.status = 'failed'; job.message = 'Executor unavailable'; commit(); return; }
    job.status = 'running'; job.startedAt = now(); running.set(sessionKey(job.agent, job.sessionId), job); commit();
    let result;
    try {
      result = await deps.run(job, id => {
        if (job.action === 'new_task' && id !== job.sessionId) running.delete(sessionKey(job.agent, job.sessionId));
        running.set(sessionKey(job.agent, id), job); job.targetSessionId = id;
      });
    } catch (err) { result = { ok: false, kind: 'failed', message: String(err.message).slice(0, 500) }; }
    if (deps.flushStatus) deps.flushStatus();
    for (const [id, value] of running) if (value === job) running.delete(id);
    job.status = result.ok ? 'completed' : 'failed'; job.message = result.message || '';
    log(job.status, job.message, { jobId: job.id, sessionId: result.sessionId || job.sessionId });
    commit();
    if (stopped) return;
    const observed = job.observedEvent || {};
    observe({ ...observed, agent: job.agent, sessionId: result.sessionId || job.sessionId,
      cwd: job.cwd, provider: job.provider, model: job.model, limitId: job.limitId,
      turnId: observed.turnId || job.id, kind: result.kind || 'failed', at: now(),
      source: 'executor', message: result.message || '' });
  }
  async function tick() {
    if (ticking || stopped || loadError) return;
    ticking = true;
    try {
      for (const job of state.jobs) {
        if (!PENDING.has(job.status)) continue;
        if (deps.isAgentEnabled && !deps.isAgentEnabled(job.agent)) continue;
        const rule = state.rules.find(r => r.id === job.ruleId);
        if (!rule || !rule.enabled) { job.status = 'cancelled'; commit(); continue; }
        if (now() - job.createdAt > 7 * 86400000) { job.status = 'cancelled'; job.message = '动作已过期 / Action expired'; commit(); continue; }
        if (job.status === 'waiting_quota') {
          if (job.agent !== 'codex') continue;
          const quota = state.quotas[quotaKey(job.provider, job.limitId)];
          if (!quotaAvailable(quota, job.blockedAt, now())) continue;
          job.status = 'scheduled';
          if (!job.quotaConfirmedAt) job.dueAt = now() + job.delaySeconds * 1000;
          job.quotaConfirmedAt = now();
          log('quota_restored', '', { jobId: job.id }); commit();
        }
        if (job.dueAt > now()) continue;
        if (job.requiresQuota && !quotaAvailable(state.quotas[quotaKey(job.provider, job.limitId)], job.blockedAt, now())) {
          job.status = 'waiting_quota'; commit(); continue;
        }
        if (deps.flushStatus) deps.flushStatus();
        if (!PENDING.has(job.status)) continue;
        const session = sessions.get(sessionKey(job.agent, job.sessionId));
        const sessionBusy = session && ['running', 'waiting_input', 'unknown', 'error_observed'].includes(session.kind);
        const anyBusy = [...sessions.values()].some(s => ['running', 'waiting_input', 'unknown', 'error_observed'].includes(s.kind));
        const busy = job.action === 'shutdown'
          ? job.onlyWhenIdle && (anyBusy || running.size > 0 || deps.isBusy && deps.isBusy())
          : running.has(sessionKey(job.agent, job.sessionId)) || sessionBusy;
        if (busy) { if (job.status !== 'waiting_idle') { job.status = 'waiting_idle'; commit(); } continue; }
        // A deferred shutdown gets a fresh cancellation window after work ends.
        if (job.status === 'waiting_idle' && job.action === 'shutdown') {
          job.status = 'scheduled'; job.dueAt = now() + Math.max(60, job.delaySeconds) * 1000; commit(); continue;
        }
        // Do not block the scheduler/cancel UI while a CLI turn runs.
        execute(job).catch(err => { loadError = `执行记录失败 / Execution journal failed: ${text(err.message, 200)}`; onChange(); });
      }
      if ((!deps.isAgentEnabled || deps.isAgentEnabled('codex')) && (state.jobs.some(j => j.agent === 'codex' && j.status === 'waiting_quota')
          || state.rules.some(r => r.agent === 'codex' && r.enabled && r.trigger === 'quota_restored' && (state.counts[r.id] || 0) < r.maxRuns
            && sessions.get(sessionKey(r.agent, r.sessionId))?.kind === 'quota_exhausted'))) {
        if (now() - queryAt >= 60000) refreshQuotas();
      }
    } finally { ticking = false; }
  }
  return { snapshot, saveRule, removeRule, cancelJob, resetCount, observe, observeQuota, refreshQuotas, tick,
    start() { stopped = false; if (!timer) { timer = setInterval(() => tick().catch(() => {}), 1000); timer.unref?.(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; } };
}

module.exports = { createCodexAutomation, createAgentAutomation: createCodexAutomation, normalizeRule, powerOff, TRIGGERS, ACTIONS, AGENTS, DEFAULT_PROMPT };
