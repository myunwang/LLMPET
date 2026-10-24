'use strict';

// Do not require('electron'): newer releases download the binary on require.
// Resolve the package metadata and installation record without running code.
const fs = require('fs');
const path = require('path');

try {
  const packageFile = require.resolve('electron/package.json');
  const packageDir = path.dirname(packageFile);
  const pathFile = path.join(packageDir, 'path.txt');
  const installedPath = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8') : null;
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (!installedPath && !override) {
    throw new Error('Electron installation record (path.txt) is missing. Run npm run install:electron.');
  }
  const executable = path.join(override || path.join(packageDir, 'dist'), installedPath || 'electron');
  if (!fs.statSync(executable).isFile()) {
    throw new Error('The Electron executable is missing or is not a file.');
  }
  if (!override) {
    const expectedVersion = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
    const installedVersion = fs.readFileSync(path.join(packageDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
    if (installedVersion !== expectedVersion) throw new Error(`Electron version mismatch: expected ${expectedVersion}, found ${installedVersion}.`);
  }
  console.log(`[LLMPET] Electron runtime found: ${executable}`);
} catch (error) {
  console.error([
    `[LLMPET] Electron 安装不完整 / Electron installation is incomplete (${process.version}, ${process.platform}/${process.arch}).`,
    error.message,
    '',
    '请先使用 Node.js 22（22.12.0+），然后在项目目录执行：',
    'Use Node.js 22 (22.12.0+) and run these commands in the project directory:',
    '  npm ci --foreground-scripts',
    '  npm run install:electron',
    '  npm run check:electron',
    '  npm start',
    '',
    '如果 electron 包已安装但二进制缺失，可单独重试锁定版本的下载：',
    'If the electron package is installed but its binary is missing, retry its pinned installer:',
    '  npm run install:electron',
    '',
    '新版 Electron 需要单独安装二进制；请检查安装日志中的网络错误。',
    'Recent Electron versions require explicit binary installation; check the install log for network failures.',
    '排查步骤 / Troubleshooting: docs/LOCAL_DEPLOYMENT.md (also _EN.md / _JA.md).',
  ].join('\n'));
  process.exitCode = 1;
}
