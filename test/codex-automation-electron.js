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
  const sid = '019f5103-921c-7ac1-9a8d-c4f8ff8a67aa', d = new Date();
  const sessions = path.join(testDir, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-test-${sid}.jsonl`);
  const event = payload => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload }) + '\n';
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: root, model_provider: 'openai' } }) + '\n'
    + event({ type: 'task_complete', turn_id: 'historical' }));
  const frozenTime = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(rollout, frozenTime, frozenTime);
  const claudeId = '019f5103-921c-7ac1-9a8d-c4f8ff8a67cc';
  const claudeDir = path.join(testDir, '.claude', 'projects', 'fixture'); fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${claudeId}.jsonl`), JSON.stringify({ type: 'user', sessionId: claudeId, timestamp: new Date().toISOString(), cwd: root, message: { role: 'user', content: 'fixture' } }) + '\n');
  const dshDir = path.join(testDir, '.dsh', 'sessions', 'fixture', 'ses_fixture'); fs.mkdirSync(dshDir, { recursive: true });
  const dshLog = path.join(dshDir, 'session.jsonl');
  fs.writeFileSync(dshLog, JSON.stringify({ type: 'session', version: 0, id: 'ses_fixture', cwd: root, delegationDepth: 0 }) + '\n');
  const errors = [];
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
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-page="automation"]').click();
      const pause = ms => new Promise(r => setTimeout(r, ms));
      const set = (id, value) => { const e = document.getElementById('auto-' + id); e.value = value; e.dispatchEvent(new Event('change')); };
      const visible = id => document.getElementById('auto-' + id).getClientRects().length > 0;
      const discovered = await window.pet.getAutomation();
      if (!['codex','claude','dsh'].every(agent=>discovered.value.sessions.some(s=>s.agent===agent))) throw Error('Some agent sessions are missing');
      if (!discovered.value.diagnostics.sourceRoot || !document.getElementById('auto-diagnostics').textContent.includes('sessions')) throw Error('Scan diagnostics missing');
      set('agent', 'claude'); set('trigger', 'quota_exhausted');
      if (!visible('quota-note') || !document.querySelector('#auto-action [value="continue"]').disabled || !document.querySelector('#auto-trigger [value="quota_restored"]').disabled) throw Error('Unsupported quota capabilities must be explicit');
      set('agent', 'codex'); set('trigger', 'completed');
      if (document.getElementById('auto-action').value || visible('prompt-field') || visible('cwd-field') || visible('bucket-field') || visible('idle-field') || visible('limits')) throw Error('Action-specific fields visible before selection');
      set('action', 'new_task');
      if (!visible('prompt-field') || !visible('cwd-field') || visible('idle-field') || visible('bucket-field') || !document.getElementById('auto-prompt').required) throw Error('New task fields incorrect');
      set('prompt', 'Draft that must not be sent by a shutdown rule'); set('cwd', ${JSON.stringify(root)});
      set('trigger', 'quota_exhausted'); set('bucket', 'draft-bucket'); set('action', 'continue');
      if (!visible('prompt-field') || visible('cwd-field') || !visible('bucket-field') || visible('idle-field') || document.getElementById('auto-prompt').required) throw Error('Continuation fields incorrect');
      set('action', 'shutdown');
      if (visible('prompt-field') || visible('cwd-field') || visible('bucket-field') || !visible('idle-field') || !visible('limits')) throw Error('Shutdown must hide irrelevant inputs');
      set('session', ${JSON.stringify(sid)}); set('name', '任务结束或中断后关机'); set('trigger', 'ended');
      document.getElementById('auto-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause(250); const a = await window.pet.getAutomation();
      if (!a.ok || a.value.rules.length !== 1) throw Error('Rule IPC save failed');
      const r = a.value.rules[0];
      if (r.enabled || r.delaySeconds < 60 || r.maxRuns !== 1 || r.trigger !== 'ended') throw Error('Unsafe shutdown defaults or combined trigger missing');
      if (r.prompt || r.cwd || r.limitId) throw Error('Hidden field drafts leaked into the saved shutdown rule');
      document.getElementById('auto-clear').click();
      set('session', ${JSON.stringify(sid)}); set('name', '额度恢复后继续'); set('trigger', 'quota_exhausted'); set('action', 'wait_quota');
      if (!visible('prompt-field') || !visible('bucket-field') || visible('cwd-field') || visible('idle-field')) throw Error('Wait-for-quota fields incorrect');
      document.getElementById('auto-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await pause(250); const b = await window.pet.getAutomation();
      if (b.value.rules.length !== 2 || b.value.jobs.length) throw Error('Historical events replayed or second action missing');
      await window.pet.saveAutomationRule({ ...r, enabled: true });
      return { actions: b.value.rules.map(x => x.action), ruleId: r.id };
    })()`);
    assert.deepStrictEqual(result.actions, ['shutdown', 'wait_quota']);
    fs.appendFileSync(rollout, event({ type: 'task_started', turn_id: 'live-completion' })
      + event({ type: 'task_complete', turn_id: 'live-completion' }));
    fs.utimesSync(rollout, frozenTime, frozenTime);
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return r.value.jobs.length===1})()'));
    const cancelled = await win.webContents.executeJavaScript(`(async()=>{
      const r=await window.pet.getAutomation(); const job=r.value.jobs[0];
      if(job.action!=='shutdown'||job.dueAt-Date.now()<50000)throw Error('Countdown missing');
      const cancel=document.querySelector('[data-auto="cancel"]');if(!cancel)throw Error('Cancel UI missing');cancel.click();
      await new Promise(r=>setTimeout(r,200));const next=await window.pet.getAutomation();return next.value.jobs[0].status;
    })()`);
    assert.strictEqual(cancelled, 'cancelled');
    await win.webContents.executeJavaScript(`window.pet.resetAutomationCount(${JSON.stringify(result.ruleId)})`);
    fs.appendFileSync(rollout, event({ type: 'task_started', turn_id: 'live-interruption' })
      + event({ type: 'turn_aborted', turn_id: 'live-interruption', reason: 'interrupted' }));
    await until(() => win.webContents.executeJavaScript('(async()=>{const r=await window.pet.getAutomation();return r.value.jobs.length===2})()'));
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
    console.log('LLMPET automation launch passed: Codex/Claude/DSH discovery and rules, frozen-mtime recovery, hook/log triggers, cancellation, conditional fields, diagnostics, zh/en/ja');
    console.log(`Screenshot: ${path.join(testDir, 'automation.png')}`);
    app.quit();
  })().catch(err => { console.error(err.stack); app.exit(1); });
  setTimeout(() => { console.error('Launch check timed out'); app.exit(2); }, 25000).unref();
}
