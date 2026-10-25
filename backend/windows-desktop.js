'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

// One hidden helper per app: EnumWindows/SetWindowPos stay fast enough to
// animate without compiling C# or starting PowerShell on every frame.
function createWindowsDesktop(options = {}) {
  let child = null;
  let sequence = 0;
  const pending = new Map();
  function stop(reason = 'helper-stopped') {
    const current = child;
    child = null;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: reason });
    }
    pending.clear();
    if (current) current.kill();
  }
  function start() {
    if (child) return;
    const current = (options.spawn || spawn)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'windows-desktop.ps1'),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = current;
    let error = '';
    current.stderr.on('data', (data) => { error = (error + data.toString()).slice(-1500); });
    const fail = () => { if (child === current) stop(error || 'helper-exited'); };
    current.on('error', fail);
    current.on('exit', fail);
    current.stdin.on('error', fail);
    readline.createInterface({ input: current.stdout }).on('line', (line) => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      const entry = pending.get(result.id);
      if (!entry) return;
      pending.delete(result.id);
      clearTimeout(entry.timer);
      entry.resolve(result);
    });
  }
  function request(command, params = {}) {
    return new Promise((resolve) => {
      try { start(); } catch (error) { resolve({ ok: false, error: error.message }); return; }
      const id = ++sequence;
      const timer = setTimeout(() => stop('helper-timeout'), options.timeoutMs || 10000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ ...params, command, id }) + '\n');
    });
  }
  return { request, stop };
}

module.exports = { createWindowsDesktop };
