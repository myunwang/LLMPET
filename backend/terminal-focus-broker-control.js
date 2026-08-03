'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const BROKER_INSTALLER = path.join(__dirname, 'install-terminal-focus-broker.ps1');

function parseResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  try {
    const parsed = JSON.parse(lines.at(-1) || '');
    return parsed && typeof parsed.ok === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function configureTerminalFocusBroker(enabled, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
  const execFileFn = options.execFile || execFile;
  const installRoot = options.installRoot || path.resolve(__dirname, '..');
  const clientPath = options.clientPath || process.execPath;
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', options.installerPath || BROKER_INSTALLER,
    '-Mode', enabled ? 'install' : 'uninstall',
    '-InstallRoot', installRoot,
    '-ClientPath', clientPath,
    '-ProfilePath', options.profilePath || os.homedir(),
    '-CallerProcessId', String(options.callerProcessId || process.pid),
  ];
  if (options.noLaunch) args.push('-NoLaunch');
  if (options.selfTest) args.push('-SelfTest');
  return new Promise((resolve) => {
    execFileFn('powershell.exe', args, { timeout: 15000, windowsHide: true }, (error, stdout) => {
      const parsed = parseResult(stdout);
      if (parsed) return resolve(parsed);
      resolve({ ok: false, reason: error && error.killed ? 'broker-config-timeout' : 'broker-config-failed' });
    });
  });
}

module.exports = { configureTerminalFocusBroker, BROKER_INSTALLER, parseResult };
