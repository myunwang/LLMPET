'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCodexAutomation, normalizeRule, powerOff } = require('../backend/codex-automation');
const { classifyError, normalizeQuota, quotaAvailable } = require('../backend/codex-status');
const { createCodexWatch } = require('../backend/codex-watch');
const { createCodexExecutor, readAccountQuotas } = require('../backend/codex-control');

const SID = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa';
const SID2 = '019f5103-921c-7ac1-9a8d-c4f8ff8a67bb';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-automation-'));
let time = Date.now(), sequence = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const runs = [], powers = [];
  const statePath = path.join(root, `${++sequence}.json`);
  const options = { statePath, now: () => time,
    run: async job => { runs.push(job); return { ok: true, kind: 'completed', sessionId: job.sessionId }; },
    powerOff: async () => { powers.push(true); return { ok: true }; }, ...overrides };
  const engine = createCodexAutomation(options);
  const rule = patch => engine.saveRule({ sessionId: SID, trigger: 'transient_error', action: 'continue', enabled: true, delaySeconds: 0, maxRuns: 3, ...patch });
  const event = patch => engine.observe({ sessionId: SID, turnId: `turn-${++sequence}`, kind: 'transient_error', provider: 'openai', limitId: 'codex', cwd: root, at: time, ...patch });
  return { engine, rule, event, runs, powers, statePath, options };
}
function quota(patch = {}) { return { limitId: 'codex', provider: 'openai', at: time,
  primary: { usedPercent: 10, resetsAt: time + 300000 }, secondary: { usedPercent: 30, resetsAt: time + 86400000 }, ...patch }; }
function fakeChild() { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {}; return child; }

(async () => {
  {
    const f = fixture(); const r = f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    assert.strictEqual(f.engine.snapshot().counts[r.id] || 0, 0, 'queued actions must not count as successful runs');
    f.engine.resetCount(r.id);
    assert.strictEqual(f.engine.snapshot().counts[r.id], 0, 'pending actions allow resetting the count');
    assert.strictEqual(f.engine.snapshot().jobs.filter(j => j.status === 'scheduled').length, 1, 'reset preserves the single pending action');
    f.engine.cancelJob(f.engine.snapshot().jobs[0].id); await f.engine.tick();
    assert.strictEqual(f.engine.snapshot().jobs.length, 1, 'cancelling must not recreate the same future plan');
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'cancelled');
  }
  {
    const child = fakeChild(); child.stderr = new PassThrough();
    const e = createCodexExecutor({ desktop: false, findCli: () => 'codex.exe', spawn: () => child });
    const result = e.run({ action: 'continue', sessionId: SID, cwd: root, prompt: 'test' });
    child.stderr.write(`Error: thread ${SID} already has an active writer\n`); child.emit('close', 1);
    const value = await result;
    assert.strictEqual(value.kind, 'session_busy', 'stderr writer conflicts must become a visible waiting reason');
    assert(value.message.includes('active writer'), 'retain the actual CLI diagnostic');
  }
  {
    const child = fakeChild(); child.stderr = new PassThrough();
    const e = createCodexExecutor({ desktop: false, findCli: () => 'codex.exe', spawn: () => child });
    const result = e.run({ action: 'continue', sessionId: SID, cwd: root, prompt: 'test' });
    child.stderr.write('Error: authentication failed\nAuthorization: Bearer secret-header\nAPI key=secret-key\n'); child.emit('close', 1);
    const value = await result;
    assert(value.message.includes('authentication failed'));
    assert(!value.message.includes('secret-header') && !value.message.includes('secret-key'), 'diagnostics redact secrets before persistence');
  }
  {
    let busy = true;
    const f = fixture({ run: async job => busy ? { ok: false, kind: 'session_busy', message: 'active writer' } : { ok: true, kind: 'completed', sessionId: job.sessionId } });
    const r = f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    time += 1000; await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'waiting_session');
    assert.strictEqual(f.engine.snapshot().counts[r.id] || 0, 0);
    assert.strictEqual(f.engine.snapshot().attempts[r.id], 0, 'writer conflicts consume no attempts');
    f.engine.resetCount(r.id); busy = false;
    time += 30000; await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().counts[r.id], 1, 'count only after a successful completion');
    f.engine.resetCount(r.id); await f.engine.tick();
    assert.strictEqual(f.engine.snapshot().counts[r.id], 0, 'reset must remain zero without replaying an expired timer');
    assert.strictEqual(createCodexAutomation(f.options).snapshot().counts[r.id], 0);
  }
  {
    const f = fixture({ run: async () => ({ ok: false, kind: 'failed', message: 'failure' }) });
    const r = f.rule({ maxRuns: 1 }); f.event(); await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().counts[r.id] || 0, 0, 'failure does not count as success');
    assert.strictEqual(f.engine.snapshot().attempts[r.id], 1);
    assert.strictEqual(f.engine.snapshot().jobs.length, 1, 'failures remain bounded without inflating successful counts');
    f.engine.resetCount(r.id); f.event(); await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().jobs.length, 2, 'reset allows a new attempt');
  }
  {
    const f = fixture({ run: async () => ({ ok: false, kind: 'session_busy', message: 'active writer' }) });
    f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 }); time += 1000; await f.engine.tick(); await settle();
    f.event({ kind: 'running' });
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'cancelled', 'manual continuation supersedes the queued writer retry');
  }
  {
    let available = false;
    const f = fixture({ run: async job => available ? { ok: true, kind: 'completed', executorRoute: 'cli', sessionId: job.sessionId }
      : { ok: false, kind: 'desktop_unavailable', executorRoute: 'desktop', message: 'Bridge not ready' } });
    const r = f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 }); time += 1000; await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'waiting_desktop'); assert.strictEqual(f.engine.snapshot().jobs[0].executorRoute, 'desktop');
    assert.strictEqual(f.engine.snapshot().attempts[r.id], 0);
    available = true; time += 30000; await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().counts[r.id], 1); assert.strictEqual(f.engine.snapshot().jobs[0].executorRoute, 'cli');
  }
  {
    const f = fixture({ run: async () => ({ ok: false, kind: 'submission_unknown', executorRoute: 'desktop', message: 'Check the original chat' }) });
    f.rule({ trigger: 'ended', maxRuns: 3 }); f.event({ kind: 'completed' }); await f.engine.tick(); await settle();
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'unconfirmed'); assert.strictEqual(f.engine.snapshot().sessions[0].kind, 'unknown');
    await f.engine.tick(); assert.strictEqual(f.engine.snapshot().jobs.length, 1, 'an uncertain native submission must never auto-repeat');
  }
  {
    const f = fixture(); const r = f.rule({ trigger: 'quota_5h_restored', sessionCwd: root, sessionProvider: 'custom', maxRuns: 1 });
    f.rule({ trigger: 'quota_weekly_restored', sessionCwd: root, maxRuns: 1 });
    const account = patch => quota({ source: 'account', primary: { usedPercent: 100, windowMinutes: 300, resetsAt: time + 60000 }, secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: time + 86400000 }, ...patch });
    f.engine.observeQuota(account(), { seed: true });
    assert.strictEqual(f.engine.snapshot().jobs.length, 0, 'initial quota snapshot establishes a baseline');
    time += 1000; f.engine.observeQuota(account({ primary: { usedPercent: 0, windowMinutes: 300, resetsAt: time + 300000 } }));
    assert.strictEqual(f.engine.snapshot().jobs.length, 1);
    assert.strictEqual(f.engine.snapshot().jobs[0].trigger, 'quota_5h_restored');
    assert.strictEqual(f.engine.snapshot().jobs[0].provider, 'custom', 'account trigger does not change inference provider');
    await f.engine.tick(); await settle(); assert.strictEqual(f.engine.snapshot().counts[r.id], 1);
    time += 1000; f.engine.observeQuota(account({ primary: { usedPercent: 5, windowMinutes: 300, resetsAt: time + 300000 }, secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: time + 86400000 } }));
    assert.strictEqual(f.engine.snapshot().jobs[0].trigger, 'quota_weekly_restored');
    assert.strictEqual(f.engine.snapshot().jobs.length, 2, 'weekly recovery is independent of the 5-hour event');
    time += 1000; f.engine.observeQuota(account({ source: 'rollout' }));
    assert.strictEqual(f.engine.snapshot().jobs.length, 2, 'rollout caches cannot establish account recovery');
  }
  {
    const f = fixture(); f.rule({ trigger: 'quota_5h_restored' });
    const q = quota({ source: 'account', primary: { usedPercent: 40, windowMinutes: 300, resetsAt: time + 1000 } });
    f.engine.observeQuota(q, { seed: true }); time += 2000;
    f.engine.observeQuota({ ...q, at: time, primary: { usedPercent: 0, windowMinutes: 300, resetsAt: time + 18000000 } });
    assert.strictEqual(f.engine.snapshot().jobs.length, 1, 'an observed reset triggers even if the old window was not completely used');
  }
  assert.strictEqual(classifyError({ codexErrorInfo: 'UsageLimitExceeded' }).kind, 'quota_exhausted');
  assert.strictEqual(classifyError({ message: "You've hit your usage limit" }).kind, 'quota_exhausted');
  assert.strictEqual(classifyError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).kind, 'failed');
  assert.strictEqual(classifyError({ message: 'rate_limit_exceeded 429' }).kind, 'transient_error');
  assert.strictEqual(classifyError({ message: 'invalid API key' }).kind, 'failed');
  assert.throws(() => normalizeRule({ trigger: 'idle', action: 'shutdown' }));
  assert.throws(() => normalizeRule({ sessionId: SID, trigger: 'quota_exhausted', action: 'shutdown' }));
  assert.throws(() => normalizeRule({ sessionId: SID, trigger: 'quota_restored', action: 'continue' }));
  assert.throws(() => normalizeRule({ sessionId: SID, trigger: 'ended', action: 'wait_quota' }));
  assert.throws(() => normalizeRule({ sessionId: SID, trigger: 'completed', action: 'new_task' }));
  const powerRule = normalizeRule({ sessionId: SID, trigger: 'ended', action: 'shutdown', prompt: 'stale draft', cwd: root, limitId: 'stale-bucket' });
  assert.strictEqual(powerRule.prompt, ''); assert.strictEqual(powerRule.cwd, ''); assert.strictEqual(powerRule.limitId, '');
  const raw = normalizeQuota({ limit_id: 'other', primary: { used_percent: 99, resets_at: Math.floor(time / 1000) + 600 }, secondary: { used_percent: 100, resets_at: Math.floor(time / 1000) + 2000 } }, time);
  assert.strictEqual(raw.limitId, 'other'); assert(raw.secondary.resetsAt > time);
  assert(!quotaAvailable(raw, time - 1, time), 'both quota windows must recover');
  assert(!quotaAvailable(quota(), time, time), 'a snapshot predating the failure cannot restore quota');
  assert(!quotaAvailable(quota({ at: time - 200000 }), time - 300000, time), 'stale quota must not trigger work');
  assert(!quotaAvailable(quota({ provider: 'custom' }), time - 1, time), 'custom rollouts can contain unrelated cached account quotas');
  assert(quotaAvailable(quota({ provider: 'custom', providerVerified: true }), time - 1, time), 'a provider adapter can explicitly establish quota provenance');
  assert(!quotaAvailable(quota({ primary: { usedPercent: 0, resetsAt: time - 1 } }), time - 1, time), 'expired window needs a fresh query');

  {
    const f = fixture(); f.rule({ trigger: 'interrupted', action: 'shutdown' }); f.event({ kind: 'completed' });
    assert.strictEqual(f.engine.snapshot().jobs.length, 0, 'normal completion is not interruption');
    f.event({ kind: 'interrupted' }); assert.strictEqual(f.engine.snapshot().jobs.length, 1);
  }
  for (const kind of ['completed', 'interrupted', 'failed', 'transient_error', 'quota_exhausted']) {
    const f = fixture(); f.rule({ trigger: 'ended', action: 'shutdown' });
    const turnId = `combined-${kind}`; f.event({ kind, turnId }); f.event({ kind, turnId });
    assert.strictEqual(f.engine.snapshot().jobs.length, 1, `combined end trigger handles ${kind} exactly once`);
    assert.strictEqual(f.engine.snapshot().jobs[0].trigger, kind, 'keep the specific reason in the execution record');
  }
  for (const kind of ['running', 'idle', 'waiting_input', 'error_observed', 'quota_restored']) {
    const f = fixture(); f.rule({ trigger: 'ended', action: 'shutdown' }); f.event({ kind });
    assert.strictEqual(f.engine.snapshot().jobs.length, 0, `${kind} is not a terminal event`);
  }

  {
    const f = fixture(); f.rule({ enabled: false }); f.event(); await f.engine.tick(); assert.strictEqual(f.runs.length, 0);
    f.rule({}); const event = { turnId: 'dedupe', kind: 'transient_error' }; f.event(event); f.event(event);
    assert.strictEqual(f.engine.snapshot().jobs.length, 1);
    await f.engine.tick(); await settle(); assert.strictEqual(f.runs.length, 1);
    const restarted = createCodexAutomation(f.options); restarted.observe({ sessionId: SID, turnId: 'dedupe', kind: 'transient_error', at: time });
    assert.strictEqual(restarted.snapshot().jobs.length, 1, 'persisted event IDs prevent replay');
  }
  {
    const f = fixture();
    f.rule({ trigger: 'scheduled', scheduledAt: time + 5000, sessionTitle: 'A task', sessionCwd: root, sessionProvider: 'custom', sessionModel: 'original-model', delaySeconds: 300 });
    assert.strictEqual(f.engine.snapshot().jobs.length, 1, 'time rules do not need a terminal event');
    await f.engine.tick(); assert.strictEqual(f.runs.length, 0);
    time += 5000; await f.engine.tick(); await settle();
    assert.strictEqual(f.runs.length, 1); assert.strictEqual(f.runs[0].cwd, root);
    assert.strictEqual(f.runs[0].provider, 'custom'); assert.strictEqual(f.runs[0].model, 'original-model');
    f.event({ kind: 'completed' }); time += 1000; await f.engine.tick();
    assert.strictEqual(f.runs.length, 1, 'timer runs once without adding an event delay or retry loop');
  }
  {
    const f = fixture(); const first = f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    f.rule({ trigger: 'scheduled', scheduledAt: time + 2000 });
    assert.strictEqual(f.engine.snapshot().jobs.length, 2, 'two timers for one session stay independent');
    const next = f.engine.saveRule({ ...first, sessionId: SID2, sessionTitle: 'Replacement', scheduledAt: time + 3000 });
    assert.strictEqual(next.sessionTitle, 'Replacement');
    const pending = f.engine.snapshot().jobs.filter(j => j.ruleId === first.id && j.status === 'scheduled');
    assert.strictEqual(pending.length, 1); assert.strictEqual(pending[0].sessionId, SID2);
    assert(f.engine.snapshot().jobs.some(j => j.ruleId === first.id && j.status === 'cancelled'));
    time += 3000; await f.engine.tick(); await settle(); assert.strictEqual(f.runs.length, 2);
  }
  {
    const f = fixture(); f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    f.event({ kind: 'running' }); assert.strictEqual(f.engine.snapshot().jobs[0].status, 'scheduled');
    time += 1000; await f.engine.tick(); assert.strictEqual(f.runs.length, 0);
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'waiting_idle');
    f.event({ kind: 'completed' }); await f.engine.tick(); await settle(); assert.strictEqual(f.runs.length, 1);
  }
  {
    const f = fixture(); f.rule({ trigger: 'scheduled', scheduledAt: time + 8 * 86400000 });
    const restarted = createCodexAutomation(f.options);
    assert.strictEqual(restarted.snapshot().jobs[0].status, 'scheduled', 'future timers survive restart');
    time += 8 * 86400000; await restarted.tick(); await settle();
    assert.strictEqual(f.runs.length, 1, 'long-term schedules expire relative to due time');
    await restarted.tick(); assert.strictEqual(f.runs.length, 1);
    const g = fixture(); g.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    time += 2000;
    const overdue = createCodexAutomation(g.options); await overdue.tick();
    assert.strictEqual(overdue.snapshot().jobs[0].status, 'cancelled', 'missed timers are not replayed on startup');
    assert.strictEqual(g.runs.length, 0);
  }
  {
    const f = fixture();
    assert.throws(() => f.rule({ trigger: 'scheduled', scheduledAt: time - 1 }), /future/);
    assert.throws(() => f.rule({ trigger: 'scheduled', scheduledAt: time + 1000, action: 'shutdown' }), /60/);
    assert.throws(() => f.rule({ trigger: 'scheduled' }), /execution time/);
    const r = f.rule({ trigger: 'scheduled', scheduledAt: time + 1000 });
    f.engine.saveRule({ ...r, enabled: false }); time += 2000; await f.engine.tick();
    assert.strictEqual(f.runs.length, 0, 'disabling cancels a timer');
  }
  {
    const statePath = path.join(root, 'quota-migration.json');
    const old = { id: 'old-quota', sessionId: SID, trigger: 'quota_exhausted', action: 'wait_quota', enabled: true, prompt: 'Continue draft' };
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, rules: [old, { ...old, id: 'normal', trigger: 'ended', action: 'shutdown' }],
      jobs: [{ ruleId: old.id, action: 'wait_quota', trigger: 'quota_exhausted', status: 'waiting_quota' }], history: [], seen: [], counts: {}, quotas: {} }));
    const e = createCodexAutomation({ statePath }); const snap = e.snapshot();
    assert(!snap.error); assert.strictEqual(snap.rules.length, 2);
    assert.deepStrictEqual([snap.rules[0].trigger, snap.rules[0].action, snap.rules[0].enabled, snap.rules[0].needsSchedule], ['scheduled', 'continue', false, true]);
    assert.strictEqual(snap.rules[0].prompt, 'Continue draft'); assert.strictEqual(snap.jobs[0].status, 'cancelled');
    assert.strictEqual(snap.rules[1].enabled, true, 'normal rules survive quota migration');
  }
  {
    const statePath = path.join(root, 'broken.json'); fs.writeFileSync(statePath, '{broken');
    const f = fixture({ statePath }); assert(f.engine.snapshot().error);
    assert.throws(() => f.rule({})); await f.engine.tick(); assert.strictEqual(f.runs.length, 0);
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), '{broken', 'never overwrite unreadable journal');
  }
  {
    let busy = true; const f = fixture({ isBusy: () => busy }); f.rule({ trigger: 'completed', action: 'shutdown' }); f.event({ kind: 'completed' });
    time += 61000; await f.engine.tick(); assert.strictEqual(f.powers.length, 0);
    busy = false; await f.engine.tick(); assert.strictEqual(f.powers.length, 0, 'idle after deferral gets a fresh cancellation countdown');
    time += 61000; await f.engine.tick(); await settle(); assert.strictEqual(f.powers.length, 1);
  }
  {
    const f = fixture(); const r = f.rule({ trigger: 'completed', action: 'new_task', prompt: 'Do the next task', maxRuns: 1 });
    f.event({ kind: 'completed' }); await f.engine.tick(); await settle(); assert.strictEqual(f.runs[0].action, 'new_task');
    f.event({ kind: 'completed' }); await f.engine.tick(); assert.strictEqual(f.runs.length, 1, 'execution cap prevents completion loops');
    f.engine.resetCount(r.id); f.event({ kind: 'completed' }); await f.engine.tick(); await settle(); assert.strictEqual(f.runs.length, 2);
  }
  {
    const f = fixture(); f.rule({ delaySeconds: 30 }); f.event(); f.event({ kind: 'running' });
    assert.strictEqual(f.engine.snapshot().jobs[0].status, 'cancelled', 'manual continuation supersedes the queued retry');
    const restarted = createCodexAutomation(f.options); assert.strictEqual(restarted.snapshot().jobs[0].status, 'cancelled');
  }
  {
    const f = fixture(); f.rule({ trigger: 'completed', action: 'shutdown' }); f.event({ kind: 'completed' });
    const restarted = createCodexAutomation(f.options); assert.strictEqual(restarted.snapshot().jobs[0].status, 'cancelled', 'restart must never replay shutdown');
    const g = fixture(); const r = g.rule({}); g.event(); g.engine.saveRule({ ...r, enabled: false });
    assert.strictEqual(g.engine.snapshot().jobs[0].status, 'cancelled');
    g.event({ kind: 'error_observed' }); g.event({ kind: 'idle' }); await g.engine.tick(); assert.strictEqual(g.runs.length, 0);
  }
  {
    const f = fixture({ run: async job => ({ ok: false, kind: 'transient_error', sessionId: job.sessionId }) });
    f.rule({ maxRuns: 2 }); f.event(); await f.engine.tick(); await settle();
    await f.engine.tick(); await settle(); await f.engine.tick(); assert.strictEqual(f.engine.snapshot().jobs.length, 2, 'automatic failures stop at the configured limit');
  }
  {
    // Real watcher -> rule engine: historical events stay silent; reconnect
    // events cannot trigger retry until a terminal failure arrives.
    const f = fixture(); f.rule({});
    const dir = path.join(root, 'sessions', ...new Date().toISOString().slice(0, 10).split('-')); fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `rollout-test-${SID}.jsonl`);
    const line = payload => JSON.stringify({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload }) + '\n';
    fs.writeFileSync(fp, JSON.stringify({ type: 'session_meta', payload: { id: SID, cwd: root, model_provider: 'openai' } }) + '\n' + line({ type: 'task_complete', turn_id: 'historical' }));
    const watcher = createCodexWatch({ sessionsDir: path.join(root, 'sessions'), core: { seedSession() {}, updateSession() {}, setContextUsage() {} }, onStatus: e => f.engine.observe(e) });
    watcher.tick(); assert.strictEqual(f.engine.snapshot().jobs.length, 0);
    fs.appendFileSync(fp, line({ type: 'task_started', turn_id: 'live' }) + line({ type: 'stream_error', message: 'network connection lost', will_retry: true }));
    watcher.tick(); assert.strictEqual(f.engine.snapshot().sessions[0].kind, 'error_observed'); assert.strictEqual(f.engine.snapshot().jobs.length, 0);
    fs.appendFileSync(fp, line({ type: 'turn_failed', turn_id: 'live', error: { codexErrorInfo: 'ResponseStreamDisconnected' } }));
    watcher.tick(); assert.strictEqual(f.engine.snapshot().jobs.length, 1);
  }
  {
    const child = fakeChild(); let args;
    const executor = createCodexExecutor({ desktop: false, findCli: () => 'codex.exe', spawn: (_bin, a) => { args = a; return child; } });
    const promise = executor.run({ sessionId: SID, action: 'continue', cwd: root, provider: 'original', prompt: 'hello' });
    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: SID }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }) + '\n'); child.emit('close', 1);
    const result = await promise; assert(!result.ok); assert.strictEqual(result.kind, 'quota_exhausted');
    assert(args.includes(`model_provider="original"`)); assert(!args.some(a => /dangerously|bypass/.test(a)));
    const missing = fakeChild(); const other = createCodexExecutor({ desktop: false, findCli: () => 'codex.exe', spawn: () => missing });
    const missingResult = other.run({ sessionId: SID, action: 'continue', cwd: root, prompt: 'x' }); missing.emit('close', 0);
    assert(!(await missingResult).ok, 'launch and zero exit alone cannot prove successful completion');
  }
  {
    const child = fakeChild(); let carry = '';
    child.stdin.on('data', chunk => { carry += chunk; let nl; while ((nl = carry.indexOf('\n')) >= 0) {
      const row = JSON.parse(carry.slice(0, nl)); carry = carry.slice(nl + 1); if (!row.id) continue;
      const results = { initialize: {}, 'account/read': { account: { type: 'chatgpt' } }, 'config/read': { config: { model_provider: 'openai' } }, 'account/rateLimits/read': { rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, resetsAt: Math.floor(time / 1000) + 600 } } } } };
      setImmediate(() => child.stdout.write(JSON.stringify({ id: row.id, result: results[row.method] }) + '\n'));
    }});
    const result = await readAccountQuotas({ findCli: () => 'codex.exe', spawn: () => child, timeoutMs: 2000 });
    assert(result.ok); assert.strictEqual(result.quotas[0].provider, 'openai'); assert.strictEqual(result.quotas[0].source, 'account');
  }
  {
    const calls = []; await powerOff('win32', (file, args, opts, callback) => { calls.push({ file, args }); callback(null); });
    assert.deepStrictEqual(calls[0], { file: 'shutdown.exe', args: ['/s', '/t', '0'] });
  }
  console.log('Codex automation: time triggers, quota migration, independent actions, bounded retries, restart safety, watcher and executor checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
