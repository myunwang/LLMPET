'use strict';

// Real Electron + real main/preload/renderer IPC, isolated from the user's home.
// No inference requests or power actions are allowed by this launch check.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

if (!process.versions.electron) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-automation-ui-'));
  const child = require('child_process').spawn(require('electron'), [__filename], {
    cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, LLMPET_UI_TEST_DIR: testDir },
  });
  child.on('error', err => { console.error(err); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
} else {
  const { app, BrowserWindow } = require('electron');
  const testDir = process.env.LLMPET_UI_TEST_DIR;
  if (!testDir || !path.isAbsolute(testDir)) throw new Error('Isolated test directory required');
  os.homedir = () => testDir;
  app.setPath('userData', path.join(testDir, 'electron'));
  process.env.OCTOPUS_ALLOW_MULTI = '1';
  process.env.OCTOPUS_NO_HOOKS = '1';
  process.env.OCTOPUS_NO_NET = '1';
  process.env.LLMPET_NO_DSH = '0';
  // Fail closed even if a regression tries to execute one of these commands.
  const cp = require('child_process'), originalExec = cp.execFile, originalSpawn = cp.spawn;
  cp.execFile = (file, ...args) => {
    if (/shutdown|systemctl|osascript/i.test(file)) throw new Error('Power actions forbidden in launch test');
    return originalExec(file, ...args);
  };
  cp.spawn = (file, ...args) => {
    if (/codex|claude|dsh|shutdown|systemctl/i.test(file)) throw new Error('Inference/power forbidden in launch test');
    return originalSpawn(file, ...args);
  };
  const stateDir = path.join(testDir, '.octopus');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ agentStartup: { claude: false, codex: false, dsh: false } }));
  fs.writeFileSync(path.join(stateDir, 'codex-automation.json'), JSON.stringify({ version: 1, countersVersion: 2, rules: [], jobs: [], history: [], seen: [], counts: {}, attempts: {}, quotas: {
    'openai:codex': { provider: 'openai', source: 'account', limitId: 'codex', at: Date.now(),
      primary: { windowMinutes: 300, usedPercent: 48, resetsAt: Date.now() + 3600000 }, secondary: { windowMinutes: 10080, usedPercent: 88, resetsAt: Date.now() + 86400000 } },
  } }));
  const sid = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa', d = new Date();
  const sessions = path.join(testDir, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-test-${sid}.jsonl`);
  const event = payload => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload }) + '\n';
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: root, model_provider: 'openai' } }) + '\n'
    + event({ type: 'task_complete', turn_id: 'historical' }));
  const sid2 = '019f5103-921c-7ac1-9a8d-c4f8ff8a67bb';
  fs.writeFileSync(path.join(sessions, `rollout-other-${sid2}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: sid2, cwd: testDir, model_provider: 'custom' } }) + '\n'
    + JSON.stringify({ type: 'turn_context', payload: { cwd: testDir, model: 'test-model' } }) + '\n' + event({ type: 'task_complete', turn_id: 'other-history' }));
  fs.writeFileSync(path.join(testDir, '.codex', 'session_index.jsonl'), [
    { id: sid, thread_name: 'UI 测试原会话' }, { id: sid2, thread_name: 'UI 测试替换会话' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  for (let i = 0; i < 6; i++) {
    const id = `019f5103-921c-7ac1-9a8d-c4f8ff8a67d${i}`;
    fs.writeFileSync(path.join(sessions, `rollout-fold-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n'
      + event({ type: 'task_complete', turn_id: `fold-history-${i}` }));
  }
  const frozenTime = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(rollout, frozenTime, frozenTime);
  const claudeId = '019f5103-921c-7ac1-9a8d-c4f8ff8a67cc';
  const claudeDir = path.join(testDir, '.claude', 'projects', 'fixture'); fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${claudeId}.jsonl`), JSON.stringify({ type: 'user', sessionId: claudeId, timestamp: new Date().toISOString(), cwd: root, message: { role: 'user', content: 'fixture' } }) + '\n');
  const dshDir = path.join(testDir, '.dsh', 'sessions', 'fixture', 'ses_fixture'); fs.mkdirSync(dshDir, { recursive: true });
  const dshLog = path.join(dshDir, 'session.jsonl');
  fs.writeFileSync(dshLog, JSON.stringify({ type: 'session', version: 0, id: 'ses_fixture', cwd: root, delegationDepth: 0 }) + '\n');
  const errors = [];
  const openedSessions = [], copiedPrompts = [];
  require('electron').shell.openExternal = async url => { openedSessions.push(url); };
  require('electron').clipboard.writeText = value => { copiedPrompts.push(value); };
  const automationModule = require('../backend/codex-automation'), createAutomation = automationModule.createAgentAutomation;
  automationModule.createAgentAutomation = deps => createAutomation({ ...deps, run: (job, cb) => job.prompt === 'UI_BUSY_WRITER'
    ? Promise.resolve({ ok: false, kind: 'session_busy', executorRoute: 'desktop', message: 'Fixture active writer' }) : deps.run(job, cb) });
  app.on('web-contents-created', (_event, wc) => wc.on('console-message', (_e, level, message) => {
    if (level === 3 && !message.includes('Content Security Policy')) errors.push(message);
  }));
  require('../main');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn) {
    for (let i = 0; i < 80; i++) { const value = await fn(); if (value) return value; await pause(100); }
    throw new Error('UI condition timed out');
  }
  (async () => {
    await app.whenReady();
    const pet = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pet.html') && !w.webContents.isLoading()));
    await pet.webContents.executeJavaScript('window.pet.openSessionArchive()');
    const win = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('archive.html') && !w.webContents.isLoading()));
    await until(() => win.webContents.executeJavaScript('!!document.getElementById("auto-form")'));
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return r.value.choices.some(s=>s.title==="UI 测试替换会话")})()'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-page="automation"]').click();
      const pause = ms => new Promise(r => setTimeout(r, ms));
      const set = (id, value) => { const e = document.getElementById('auto-' + id); e.value = value; e.dispatchEvent(new Event('change')); };
      const visible = id => document.getElementById('auto-' + id).getClientRects().length > 0;
      const discovered = await window.pet.getAutomation();
      if (!['codex','claude','dsh'].every(agent=>discovered.value.sessions.some(s=>s.agent===agent))) throw Error('Some agent sessions are missing');
      if (!discovered.value.diagnostics.sourceRoot || !document.getElementById('auto-diagnostics').textContent.includes('sessions')) throw Error('Scan diagnostics missing');
      const ruleCard = document.getElementById('auto-rules').closest('article');
      const sessionCard = document.getElementById('auto-live').closest('article');
      if (!(ruleCard.compareDocumentPosition(sessionCard) & Node.DOCUMENT_POSITION_FOLLOWING)) throw Error('Saved rules must precede discovered sessions');
      const displayed = () => document.querySelectorAll('#auto-live [data-auto="select"]').length;
      const all = discovered.value.choices.filter(s => s.agent === 'codex').length;
      if (all <= 5 || displayed() !== 5 || !visible('show-all')) throw Error('Discovered sessions must initially show five rows');
      document.getElementById('auto-show-all').click();
      if (displayed() !== all || document.getElementById('auto-show-all').getAttribute('aria-expanded') !== 'true') throw Error('Expand must show every discovered session');
      document.getElementById('auto-show-all').click();
      if (displayed() !== 5) throw Error('Collapse must return to five sessions');
      const sessionInput = document.getElementById('auto-session'), firstOption = document.querySelector('#auto-sessions option');
      sessionInput.focus(); sessionInput.value = '019'; sessionInput.dispatchEvent(new Event('input'));
      await pause(1200);
      if (document.querySelector('#auto-sessions option') !== firstOption) throw Error('Session dropdown options were replaced while choosing; native popup closes');
      sessionInput.value = ${JSON.stringify(sid)}; sessionInput.dispatchEvent(new Event('input')); await pause(1100);
      if (sessionInput.value !== ${JSON.stringify(sid)} || document.activeElement !== sessionInput) throw Error('Selected session and focus must survive refresh');
      sessionInput.value = ''; sessionInput.blur();
      for (const agent of ['codex','claude','dsh']) {
        set('agent', agent);
        if (document.querySelector('#auto-trigger [value="quota_exhausted"], #auto-trigger [value="quota_restored"], #auto-action [value="wait_quota"]')) throw Error('Removed quota choices are still offered');
        if ([...document.querySelectorAll('#auto-trigger [value^="quota_"]')].some(o=>o.disabled !== (agent!=='codex'))) throw Error('Account quota triggers require Codex');
      }
      if (!document.getElementById('auto-quotas').textContent.includes('48%') || !document.getElementById('auto-quotas').textContent.includes('88%')) throw Error('Both account quota windows must be visible');
      set('agent', 'codex'); set('trigger', 'completed');
      if (document.getElementById('auto-action').value || visible('prompt-field') || visible('cwd-field') || visible('idle-field') || visible('limits') || visible('time-field')) throw Error('Action-specific fields visible before selection');
      set('action', 'new_task');
      if (!visible('prompt-field') || !visible('cwd-field') || visible('idle-field') || !document.getElementById('auto-prompt').required) throw Error('New task fields incorrect');
      set('prompt', 'Draft that must not be sent by a shutdown rule'); set('cwd', ${JSON.stringify(root)});
      set('action', 'continue');
      if (!visible('prompt-field') || visible('cwd-field') || visible('idle-field') || document.getElementById('auto-prompt').required) throw Error('Continuation fields incorrect');
      set('action', 'shutdown');
      if (visible('prompt-field') || visible('cwd-field') || !visible('idle-field') || !visible('limits')) throw Error('Shutdown must hide irrelevant inputs');
      set('session', ${JSON.stringify(sid)}); set('name', '任务结束或中断后关机'); set('trigger', 'ended');
      document.getElementById('auto-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause(250); const a = await window.pet.getAutomation();
      if (!a.ok || a.value.rules.length !== 1) throw Error('Rule IPC save failed');
      const r = a.value.rules[0];
      if ((a.value.counts[r.id] || 0) !== 0) throw Error('Saving a rule must show 0 successful runs');
      if (r.enabled || r.delaySeconds < 60 || r.maxRuns !== 1 || r.trigger !== 'ended') throw Error('Unsafe shutdown defaults or combined trigger missing');
      if (r.prompt || r.cwd || r.limitId) throw Error('Hidden field drafts leaked into the saved shutdown rule');
      if (r.sessionTitle !== 'UI 测试原会话' || !document.getElementById('auto-rules').textContent.includes('UI 测试原会话')) throw Error('Saved rule must show its task title');
      if (!document.getElementById('auto-notice').textContent.includes('保存成功')) throw Error('Save success feedback missing');
      const choose = async id => {
        document.querySelector('[data-auto="reselect"][data-id="'+r.id+'"]').click();
        if (!document.querySelector('#auto-live [data-auto="select"][data-id="'+id+'"]')) document.getElementById('auto-show-all').click();
        const button = document.querySelector('#auto-live [data-auto="select"][data-id="'+id+'"]');
        if (!button) throw Error('One-click discovered conversation selection missing');
        button.click(); await pause(200);
      };
      await choose(${JSON.stringify(sid2)});
      const changed = (await window.pet.getAutomation()).value.rules.find(x=>x.id===r.id);
      if (changed.sessionId !== ${JSON.stringify(sid2)} || changed.sessionTitle !== 'UI 测试替换会话' || changed.sessionProvider !== 'custom' || changed.sessionModel !== 'test-model') throw Error('Reselection must persist the new conversation and its own model/provider');
      if (!document.getElementById('auto-notice').textContent.includes('已重新选择对话并保存')) throw Error('Reselection feedback missing');
      await choose(${JSON.stringify(sid)});
      document.getElementById('auto-clear').click();
      set('session', ${JSON.stringify(sid)}); set('name', '指定时间继续'); set('trigger', 'scheduled'); set('action', 'continue');
      const at = Math.floor((Date.now()+3600000)/1000)*1000, d = new Date(at);
      set('time', new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,19));
      if (!visible('time-field') || !document.getElementById('auto-time').required || visible('limits') || !visible('prompt-field') || visible('cwd-field') || visible('idle-field')) throw Error('Timed continuation fields incorrect');
      document.getElementById('auto-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause(250); const b = await window.pet.getAutomation();
      const timerRule = b.value.rules.find(x=>x.trigger==='scheduled');
      if (b.value.rules.length !== 2 || b.value.jobs.length || timerRule.scheduledAt!==at || timerRule.maxRuns!==1 || timerRule.sessionCwd!==${JSON.stringify(root)}) throw Error('Local execution time or source session did not round trip');
      const pending = await window.pet.saveAutomationRule({ ...timerRule, enabled: true });
      document.querySelector('[data-auto="reset"][data-id="'+timerRule.id+'"]').click(); await pause(200);
      const afterReset = (await window.pet.getAutomation()).value;
      if (!pending.ok || afterReset.counts[timerRule.id] !== 0 || afterReset.jobs.filter(j=>j.ruleId===timerRule.id&&j.status==='scheduled').length!==1) throw Error('Reset must work with a queued timer and preserve 0/1');
      await window.pet.cancelAutomationJob(afterReset.jobs.find(j=>j.ruleId===timerRule.id).id);
      await window.pet.saveAutomationRule({ ...r, enabled: true });
      return { actions: b.value.rules.map(x => x.action), ruleId: r.id };
    })()`);
    assert.deepStrictEqual(result.actions, ['shutdown', 'continue']);
    fs.appendFileSync(rollout, event({ type: 'task_started', turn_id: 'live-completion' })
      + event({ type: 'task_complete', turn_id: 'live-completion' }));
    fs.utimesSync(rollout, frozenTime, frozenTime);
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return r.value.jobs.filter(j=>j.action==="shutdown").length===1})()'));
    const cancelled = await win.webContents.executeJavaScript(`(async()=>{
      const r=await window.pet.getAutomation(); const job=r.value.jobs[0];
      if(job.action!=='shutdown'||job.dueAt-Date.now()<50000)throw Error('Countdown missing');
      await new Promise(r=>setTimeout(r,100));
      const cancel=document.querySelector('[data-auto="cancel"][data-id="'+job.id+'"]');if(!cancel)throw Error('Cancel UI missing');cancel.click();
      await new Promise(r=>setTimeout(r,200));const next=await window.pet.getAutomation();return next.value.jobs[0].status;
    })()`);
    assert.strictEqual(cancelled, 'cancelled');
    await win.webContents.executeJavaScript(`window.pet.resetAutomationCount(${JSON.stringify(result.ruleId)})`);
    fs.appendFileSync(rollout, event({ type: 'task_started', turn_id: 'live-interruption' })
      + event({ type: 'turn_aborted', turn_id: 'live-interruption', reason: 'interrupted' }));
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return r.value.jobs.filter(j=>j.action==="shutdown").length===2})()'));
    await win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();if(r.value.jobs[0].trigger!=="interrupted")throw Error("Combined trigger missed interruption");await window.pet.cancelAutomationJob(r.value.jobs[0].id)})()');
    await win.webContents.executeJavaScript(`(async()=>{
      const set=(id,value)=>{const e=document.getElementById('auto-'+id);e.value=value;e.dispatchEvent(new Event('change'))};
      for(const [agent,id] of [['claude',${JSON.stringify(claudeId)}],['dsh','ses_fixture']]){
        document.getElementById('auto-clear').click();set('agent',agent);set('session',id);set('trigger','ended');set('action','shutdown');set('name',agent+' 结束后关机');document.getElementById('auto-enabled').checked=true;
        document.getElementById('auto-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,150));
      }
      const s=await window.pet.getAutomation();if(!['claude','dsh'].every(a=>s.value.rules.some(r=>r.agent===a)))throw Error('Multi-agent rule round trip failed');
    })()`);
    const runtime = JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8'));
    const post = data => new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = require('http').request({ hostname: '127.0.0.1', port: runtime.port, path: '/state', method: 'POST', headers: { 'x-octopus-token': runtime.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error(`Hook HTTP ${res.statusCode}`))); });
      req.on('error', reject); req.end(body);
    });
    await post({ session_id: claudeId, cwd: root, state: 'thinking', event: 'UserPromptSubmit' });
    await post({ session_id: claudeId, cwd: root, state: 'attention', event: 'Stop' });
    fs.appendFileSync(dshLog, JSON.stringify({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }) + '\n'
      + JSON.stringify({ type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }) + '\n');
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return ["claude","dsh"].every(a=>r.value.jobs.some(j=>j.agent===a))})()'));
    await win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();for(const j of r.value.jobs)if(j.status==="scheduled")await window.pet.cancelAutomationJob(j.id);await window.pet.rescanAutomationSessions()})()');
    await win.webContents.executeJavaScript(`(async()=>{
      const set=(id,value)=>{const e=document.getElementById('auto-'+id);e.value=value;e.dispatchEvent(new Event('change'))};
      for(const trigger of ['quota_5h_restored','quota_weekly_restored']) {
        document.getElementById('auto-clear').click();set('agent','codex');set('session',${JSON.stringify(sid)});set('trigger',trigger);set('action','continue');
        if(document.getElementById('auto-quota-note').hidden||!document.getElementById('auto-time-field').hidden)throw Error('Quota form must identify account scope');
        document.getElementById('auto-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,150));
      }
      const s=(await window.pet.getAutomation()).value;
      if(!['quota_5h_restored','quota_weekly_restored'].every(t=>s.rules.some(r=>r.trigger===t&&!r.enabled&&r.limitId==='codex')))throw Error('Separate quota rules did not save');
      const result=await window.pet.saveAutomationRule({sessionId:${JSON.stringify(sid)},agent:'codex',trigger:'scheduled',scheduledAt:Date.now()+1500,action:'continue',prompt:'UI_BUSY_WRITER',enabled:true});
      if(!result.ok)throw Error('Busy writer fixture failed to queue');
    })()`);
    await until(() => win.webContents.executeJavaScript('(async()=>{const s=(await window.pet.getAutomation()).value;return s.jobs.some(j=>j.status==="waiting_session")})()'));
    await win.webContents.executeJavaScript(`(async()=>{
      const s=(await window.pet.getAutomation()).value,j=s.jobs.find(j=>j.status==='waiting_session');
      if((s.counts[j.ruleId]||0)!==0||(s.attempts[j.ruleId]||0)!==0)throw Error('Writer lock must not consume counts');
      const b=document.querySelector('[data-auto="open-session"][data-id="'+j.id+'"]');if(!b)throw Error('Open original session action missing');if(!document.getElementById('auto-jobs').textContent.includes('桌面原生'))throw Error('Selected desktop route is missing');b.click();
      await new Promise(r=>setTimeout(r,150));await window.pet.cancelAutomationJob(j.id);
    })()`);
    assert(openedSessions.includes(`codex://threads/${sid}`)); assert(copiedPrompts.includes('UI_BUSY_WRITER'));
    for (const [lang, title] of [['en', 'Task automation'], ['ja', 'タスク自動化'], ['zh', '任务自动化']]) {
      win.webContents.send('archive:config', { lang });
      await until(() => win.webContents.executeJavaScript(`document.getElementById('page-title').textContent===${JSON.stringify(title)}`));
    }
    const css = await win.webContents.executeJavaScript(`(()=>{const s=document.getElementById('auto-action'),style=getComputedStyle(s);return {height:s.clientHeight,line:parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.4,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    assert(css.height > css.line + 18, `Select text must fit vertically: ${JSON.stringify(css)}`); assert(!css.overflow);
    await win.webContents.executeJavaScript("document.getElementById('auto-clear').click()");
    await win.webContents.executeJavaScript("document.getElementById('auto-action').value='shutdown';document.getElementById('auto-action').dispatchEvent(new Event('change'))");
    fs.writeFileSync(path.join(testDir, 'automation.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(920, 700); await pause(150);
    assert(!(await win.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth')), 'Narrow workbench must not overflow');
    assert.deepStrictEqual(errors, [], 'Renderer must launch without errors');
    console.log('LLMPET automation launch passed: discovery, five-row expansion, stable selection, rule titles, schedules, pending reset at 0/1, two account quota windows/triggers, writer waiting and open-session IPC, cancellation, diagnostics, zh/en/ja');
    console.log(`Screenshot: ${path.join(testDir, 'automation.png')}`);
    app.quit();
  })().catch(err => { fs.writeFileSync(path.join(testDir, 'failure.txt'), err.stack); console.error(err.stack); setTimeout(() => app.exit(1), 100); });
  setTimeout(() => { console.error('Launch check timed out'); app.exit(2); }, 25000).unref();
}
