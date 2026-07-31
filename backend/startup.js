'use strict';

// Keep the packaged desktop app available to the lightweight hook process.
// Login startup covers machine restarts; hook recovery covers an app process
// that was terminated after login. Recovery is deliberately rate-limited so a
// burst of lifecycle events cannot create a burst of Electron processes.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECOVERY_COOLDOWN_MS = 30_000;
const RECOVERY_STAMP_PATH = path.join(os.homedir(), '.octopus', 'hook-recovery.json');

function recoveryExecutable(hookDir, platform = process.platform) {
  if (!hookDir) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const appRoot = pathApi.resolve(hookDir, '..', '..', '..');
  if (platform === 'win32') return pathApi.join(appRoot, 'LLMPET.exe');
  if (platform === 'darwin') return pathApi.join(appRoot, 'MacOS', 'LLMPET');
  return null;
}

function ensureLoginStartup(electronApp, options = {}) {
  const platform = options.platform || process.platform;
  const executable = options.executable || process.execPath;
  if (!electronApp || !electronApp.isPackaged || !['win32', 'darwin'].includes(platform)) return false;

  const settings = { openAtLogin: true };
  if (platform === 'win32') {
    settings.path = executable;
    settings.args = ['--autostart'];
  }
  electronApp.setLoginItemSettings(settings);
  return true;
}

function recoverPackagedApp(options = {}) {
  const platform = options.platform || process.platform;
  const executable = options.executable || recoveryExecutable(options.hookDir, platform);
  const stampPath = options.stampPath || RECOVERY_STAMP_PATH;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : RECOVERY_COOLDOWN_MS;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const spawn = options.spawn || childProcess.spawn;

  if (!executable || !existsSync(executable)) return false;

  try {
    const previous = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (Number.isFinite(previous.at) && now - previous.at < cooldownMs) return false;
  } catch {}

  try {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ at: now }), 'utf8');
    const child = spawn(executable, ['--hook-recovery'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  RECOVERY_COOLDOWN_MS,
  recoveryExecutable,
  ensureLoginStartup,
  recoverPackagedApp,
};
