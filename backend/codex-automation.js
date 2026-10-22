'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const QUOTA_TRIGGERS = { quota_5h_restored: 300, quota_weekly_restored: 10080 };
const TRIGGERS = [...Object.keys(QUOTA_TRIGGERS), 'scheduled', 'completed', 'ended', 'transient_error', 'failed', 'interrupted'];
const ACTIONS = ['continue', 'new_task', 'shutdown'];
const TERMINAL = new Set(['completed', 'quota_exhausted', 'transient_error', 'failed', 'interrupted']);
const PENDING = new Set(['scheduled', 'waiting_idle', 'waiting_session', 'waiting_desktop']);
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
  if (QUOTA_TRIGGERS[input.trigger] && agent !== 'codex') throw new Error('额度恢复条件仅支持 Codex / Quota triggers require Codex');
  const scheduledAt = input.trigger === 'scheduled' ? Number(input.scheduledAt) || 0 : 0;
  if (input.trigger === 'scheduled' && input.enabled === true && (!Number.isFinite(scheduledAt) || scheduledAt <= 0)) throw new Error('请设置执行时间 / Set an execution time');
  return { id: text(input.id, 80) || uuid(), name: text(input.name, 100) || `${input.trigger} → ${input.action}`,
    enabled: input.enabled === true, agent, sessionId, trigger: input.trigger, action: input.action,
    sessionTitle: text(input.sessionTitle, 256), sessionCwd: text(input.sessionCwd, 2048),
    sessionProvider: text(input.sessionProvider, 100), sessionModel: text(input.sessionModel, 100),
    quotaArmedAt: Number(input.quotaArmedAt) || 0,
    limitId: QUOTA_TRIGGERS[input.trigger] ? text(input.limitId, 100) || 'codex' : '',
    scheduledAt, needsSchedule: input.needsSchedule === true && !scheduledAt,
    prompt, cwd: input.action === 'new_task' ? text(input.cwd, 2048) : '',
    delaySeconds: number(input.delaySeconds, 15, input.action === 'shutdown' ? 60 : 0, 86400),
    maxRuns: input.trigger === 'scheduled' ? 1 : number(input.maxRuns, input.action === 'continue' ? 3 : 1, 1, 100),
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
  let state = { rules: [], jobs: [], history: [], seen: [], counts: {}, attempts: {}, countEpochs: {}, timerPlans: {}, quotas: {}, countersVersion: 2 };
  let loadError = '';
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.rules) || !Array.isArray(saved.jobs)
        || !Array.isArray(saved.history) || !Array.isArray(saved.seen)
        || !saved.counts || typeof saved.counts !== 'object' || !saved.quotas || typeof saved.quotas !== 'object'
        || !saved.jobs.every(j => j && typeof j === 'object' && [...ACTIONS, 'wait_quota'].includes(j.action))) throw new Error('Invalid automation state');
    state = { ...state, ...saved, rules: saved.rules.map(r => normalizeRule(
      ['quota_exhausted', 'quota_restored'].includes(r.trigger) || r.action === 'wait_quota'
        ? { ...r, trigger: 'scheduled', action: r.action === 'wait_quota' ? 'continue' : r.action, scheduledAt: 0, enabled: false, needsSchedule: true } : r)) };
    if (saved.countersVersion !== 2) {
      state.attempts = {}; state.counts = {};
      for (const [id, count] of Object.entries(saved.counts)) {
        const recent = state.jobs.filter(j => j.ruleId === id).slice(0, Number(count) || 0);
        state.counts[id] = recent.filter(j => j.status === 'completed').length;
        state.attempts[id] = recent.filter(j => j.startedAt || ['completed', 'failed'].includes(j.status)).length;
      }
    }
    state.countersVersion = 2;
    for (const job of state.jobs) {
      job.agent = job.agent || 'codex';
      if (job.trigger === 'scheduled' && state.timerPlans[job.ruleId] === undefined) state.timerPlans[job.ruleId] = job.scheduledFor || job.dueAt;
      // Never replay a power action or a possibly-submitted task after restart.
      const futureTimer = job.trigger === 'scheduled' && job.status === 'scheduled' && job.dueAt > now();
      if (!futureTimer && (PENDING.has(job.status) || job.status === 'waiting_quota' || job.status === 'running')) {
        job.status = 'cancelled'; job.message = '应用已重启，取消未确认的动作 / Restarted; action cancelled';
      }
      if (job.action === 'wait_quota') job.action = 'continue';
    }
  } catch (err) { if (err.code !== 'ENOENT') loadError = '自动化记录无法读取，执行已暂停 / Automation state unreadable'; }
  const sessions = new Map(), running = new Map();
  let timer = null, ticking = false, stopped = false, queryAt = 0, queryMessage = '', queryBusy = false, quotaSeeded = false;

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
    return JSON.parse(JSON.stringify({ ...state, sessions: [...sessions.values()], queryAt, queryMessage, queryBusy, error: loadError, now: now() }));
  }
  function saveRule(input) {
    if (loadError) throw new Error(loadError);
    const rule = normalizeRule({ ...input, quotaArmedAt: QUOTA_TRIGGERS[input.trigger] && input.enabled ? now() : input.quotaArmedAt });
    if (rule.trigger === 'scheduled' && rule.enabled && rule.scheduledAt < now() + (rule.action === 'shutdown' ? 60000 : 1)) throw new Error(rule.action === 'shutdown'
      ? '关机时间需在至少 60 秒后 / Schedule shutdown at least 60 seconds ahead'
      : '请选择未来的执行时间 / Choose a future execution time');
    if (!state.rules.some(r => r.id === rule.id) && state.rules.length >= 100) throw new Error('最多 100 条规则 / Maximum 100 rules');
    // An edit invalidates pending actions created from the old rule.
    for (const job of state.jobs) if (job.ruleId === rule.id && PENDING.has(job.status)) job.status = 'cancelled';
    // A newly chosen time or conversation is a new one-shot schedule.
    if (rule.trigger === 'scheduled' && rule.enabled) { state.counts[rule.id] = 0; state.attempts[rule.id] = 0; state.countEpochs[rule.id] = (state.countEpochs[rule.id] || 0) + 1; delete state.timerPlans[rule.id]; }
    state.rules = [...state.rules.filter(r => r.id !== rule.id), rule];
    if (rule.enabled && rule.trigger === 'scheduled') scheduleTimer(rule);
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
    if (state.jobs.some(j => j.ruleId === id && j.status === 'running')) throw new Error('请等待正在执行的动作结束 / Wait for the running action to finish');
    state.counts[id] = 0; state.attempts[id] = 0; state.countEpochs[id] = (state.countEpochs[id] || 0) + 1;
    for (const job of state.jobs) if (job.ruleId === id && PENDING.has(job.status)) job.countEpoch = state.countEpochs[id];
    log('count_reset', '', { ruleId: id }); commit();
  }
  function scheduleTimer(rule) {
    if (state.timerPlans[rule.id] === rule.scheduledAt) return false;
    const previousJob = state.jobs[0]?.id;
    const session = sessions.get(sessionKey(rule.agent, rule.sessionId)) || {};
    schedule({ ...session, agent: rule.agent, sessionId: rule.sessionId, kind: 'scheduled',
      cwd: session.cwd || rule.sessionCwd, provider: session.provider || rule.sessionProvider,
      model: session.model || rule.sessionModel, timerRuleId: rule.id });
    if (state.jobs.some(j => j.ruleId === rule.id && j.status === 'scheduled' && j.dueAt === rule.scheduledAt)) state.timerPlans[rule.id] = rule.scheduledAt;
    return previousJob !== state.jobs[0]?.id;
  }
  function schedule(event) {
    for (const rule of state.rules) {
      const matches = rule.trigger === 'ended' ? TERMINAL.has(event.kind) : rule.trigger === event.kind;
      if (!rule.enabled || rule.agent !== (event.agent || 'codex') || rule.sessionId !== event.sessionId || !matches) continue;
      if (rule.trigger === 'scheduled' && event.timerRuleId !== rule.id) continue;
      if (QUOTA_TRIGGERS[rule.trigger] && (rule.limitId || 'codex') !== event.limitId) continue;
      if (deps.isAgentEnabled && !deps.isAgentEnabled(rule.agent)) continue;
      const count = Number(state.attempts[rule.id]) || 0;
      if (count >= rule.maxRuns || (state.counts[rule.id] || 0) >= rule.maxRuns) continue;
      if (state.jobs.some(j => j.ruleId === rule.id && (PENDING.has(j.status) || j.status === 'running'))) continue;
      const job = { id: uuid(), agent: rule.agent, ruleId: rule.id, ruleName: rule.name, sessionId: event.sessionId,
        countEpoch: state.countEpochs[rule.id] || 0, scheduledFor: rule.scheduledAt, trigger: event.kind, action: rule.action, prompt: rule.prompt,
        cwd: rule.cwd || event.cwd || rule.sessionCwd || '', provider: event.provider || rule.sessionProvider || '', model: event.model || rule.sessionModel || '',
        status: 'scheduled', createdAt: now(),
        dueAt: rule.trigger === 'scheduled' ? rule.scheduledAt : now() + rule.delaySeconds * 1000 * (rule.action === 'continue' ? Math.min(16, 2 ** count) : 1),
        delaySeconds: rule.delaySeconds, onlyWhenIdle: rule.onlyWhenIdle };
      state.jobs.unshift(job);
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
      // User activity supersedes an event-based retry; explicit timers wait for idle.
      let changed = false;
      if (!event.seed && ['running', 'waiting_input'].includes(event.kind)) {
        for (const job of state.jobs) if (sessionKey(job.agent, job.sessionId) === identity && PENDING.has(job.status) && !running.has(identity)) {
          if (job.trigger === 'scheduled' && !job.writerBlocked) continue;
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
    schedule(next); commit();
  }
  function observeQuota(quota, options = {}) {
    if (!quota || quota.provider !== 'openai' || quota.source !== 'account' || !Number.isFinite(quota.at)
        || now() - quota.at > 120000 || quota.at > now() + 5000 || loadError) return;
    const key = `openai:${quota.limitId || 'codex'}`, prior = state.quotas[key];
    if (prior && prior.at >= quota.at) return;
    state.quotas[key] = quota;
    if (!options.seed && prior) for (const [trigger, minutes] of Object.entries(QUOTA_TRIGGERS)) {
      const before = [prior.primary, prior.secondary].find(w => w?.windowMinutes === minutes);
      const after = [quota.primary, quota.secondary].find(w => w?.windowMinutes === minutes);
      if (!before || !after || after.usedPercent >= 100 || after.resetsAt && after.resetsAt <= now()) continue;
      const recovered = before.usedPercent >= 100 || before.resetsAt && before.resetsAt <= now() && after.resetsAt > before.resetsAt;
      if (!recovered) continue;
      const eventKey = `account:${trigger}:${quota.limitId}:${before.resetsAt || prior.at}`;
      if (state.seen.includes(eventKey)) continue;
      state.seen.push(eventKey); state.seen = state.seen.slice(-2000);
      for (const rule of state.rules.filter(r => r.agent === 'codex' && r.trigger === trigger && prior.at >= r.quotaArmedAt)) {
        const session = sessions.get(sessionKey(rule.agent, rule.sessionId)) || {};
        schedule({ ...session, agent: rule.agent, sessionId: rule.sessionId, kind: trigger, limitId: quota.limitId,
          cwd: session.cwd || rule.sessionCwd, provider: session.provider || rule.sessionProvider, model: session.model || rule.sessionModel });
      }
    }
    commit();
  }
  async function refreshQuotas() {
    if (queryBusy || !deps.readQuotas || loadError || stopped) return;
    queryBusy = true; queryAt = now(); onChange();
    try {
      const result = await deps.readQuotas(); queryMessage = result.message || '';
      if (!stopped) for (const quota of result.quotas || []) observeQuota(quota, { seed: !quotaSeeded });
      if (result.quotas?.length) quotaSeeded = true;
    } catch (err) { queryMessage = '额度查询失败 / Quota query failed'; }
    finally { queryBusy = false; onChange(); }
  }
  async function execute(job) {
    state.attempts[job.ruleId] = (state.attempts[job.ruleId] || 0) + 1;
    if (job.action === 'shutdown') {
      job.status = 'running'; commit();
      let result;
      try { result = await (deps.powerOff || powerOff)(); }
      catch (err) { result = { ok: false, message: text(err.message, 500) }; }
      job.status = result.ok ? 'completed' : 'failed'; job.message = result.message || '';
      if (result.ok && (job.countEpoch || 0) === (state.countEpochs[job.ruleId] || 0)) state.counts[job.ruleId] = (state.counts[job.ruleId] || 0) + 1;
      log(job.status, job.message, { jobId: job.id }); commit(); return;
    }
    if (!deps.run) { job.status = 'failed'; job.message = 'Executor unavailable'; commit(); return; }
    job.status = 'running'; job.startedAt = now(); running.set(sessionKey(job.agent, job.sessionId), job); commit();
    let result;
    try {
      result = await deps.run(job, (id, metadata = {}) => {
        if (job.action === 'new_task' && id !== job.sessionId) running.delete(sessionKey(job.agent, job.sessionId));
        running.set(sessionKey(job.agent, id), job); job.targetSessionId = id;
        if (metadata.executorRoute) { job.executorRoute = metadata.executorRoute; commit(); }
      });
    } catch (err) { result = { ok: false, kind: 'failed', message: String(err.message).slice(0, 500) }; }
    if (deps.flushStatus) deps.flushStatus();
    for (const [id, value] of running) if (value === job) running.delete(id);
    if (result.executorRoute) job.executorRoute = result.executorRoute;
    if (result.desktopTurnId) job.desktopTurnId = result.desktopTurnId;
    const waiting = ['session_busy', 'desktop_unavailable'].includes(result.kind);
    if (waiting && (job.countEpoch || 0) !== (state.countEpochs[job.ruleId] || 0)) { job.status = 'cancelled'; commit(); return; }
    if (waiting) {
      state.attempts[job.ruleId] = Math.max(0, (state.attempts[job.ruleId] || 0) - 1);
      job.status = result.kind === 'desktop_unavailable' ? 'waiting_desktop' : 'waiting_session'; job.writerBlocked = true; job.message = result.message || ''; job.retryAt = now() + 30000;
      log(job.status, job.message, { jobId: job.id }); commit(); return;
    }
    if (result.ok && (job.countEpoch || 0) === (state.countEpochs[job.ruleId] || 0)) state.counts[job.ruleId] = (state.counts[job.ruleId] || 0) + 1;
    job.status = result.ok ? 'completed' : result.kind === 'submission_unknown' ? 'unconfirmed' : 'failed'; job.message = result.message || '';
    log(job.status, job.message, { jobId: job.id, sessionId: result.sessionId || job.sessionId });
    commit();
    if (stopped) return;
    const observed = job.observedEvent || {};
    observe({ ...observed, agent: job.agent, sessionId: result.sessionId || job.sessionId,
      cwd: job.cwd, provider: job.provider, model: job.model,
      turnId: result.desktopTurnId || observed.turnId || job.id, kind: result.kind === 'submission_unknown' ? 'unknown' : result.kind || 'failed', at: now(),
      source: 'executor', message: result.message || '' });
  }
  async function tick() {
    if (ticking || stopped || loadError) return;
    ticking = true;
    try {
      for (const rule of state.rules) if (rule.enabled && rule.trigger === 'scheduled' && rule.scheduledAt > now()) {
        if (scheduleTimer(rule)) commit();
      }
      for (const job of state.jobs) {
        if (!PENDING.has(job.status)) continue;
        if (deps.isAgentEnabled && !deps.isAgentEnabled(job.agent)) continue;
        const rule = state.rules.find(r => r.id === job.ruleId);
        if (!rule || !rule.enabled) { job.status = 'cancelled'; commit(); continue; }
        if (now() - job.dueAt > 7 * 86400000) { job.status = 'cancelled'; job.message = '动作已过期 / Action expired'; commit(); continue; }
        if (job.dueAt > now() || ['waiting_session', 'waiting_desktop'].includes(job.status) && job.retryAt > now()) continue;
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
      if (state.rules.some(r => r.enabled && QUOTA_TRIGGERS[r.trigger]) && now() - queryAt >= 60000) refreshQuotas();
    } finally { ticking = false; }
  }
  return { snapshot, saveRule, removeRule, cancelJob, resetCount, observe, observeQuota, refreshQuotas, tick,
    start() { stopped = false; if (!timer) { timer = setInterval(() => tick().catch(() => {}), 1000); timer.unref?.(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; } };
}

module.exports = { createCodexAutomation, createAgentAutomation: createCodexAutomation, normalizeRule, powerOff, TRIGGERS, ACTIONS, AGENTS, DEFAULT_PROMPT };
