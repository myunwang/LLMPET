'use strict';

// Check the same resolved executable that Electron's CLI will launch. Requiring
// the package alone only checks path.txt, which may outlive a deleted binary.
const fs = require('fs');

try {
  const executable = require('electron');
  if (typeof executable !== 'string' || !fs.statSync(executable).isFile()) {
    throw new Error('The Electron executable is missing or is not a file.');
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
    '  npm run check:electron',
    '  npm start',
    '',
    '如果 electron 包已安装但二进制缺失，可单独重试锁定版本的下载：',
    'If the electron package is installed but its binary is missing, retry its pinned installer:',
    '  node node_modules/electron/install.js',
    '',
    '检查 / Check: npm config get ignore-scripts; ELECTRON_SKIP_BINARY_DOWNLOAD.',
    '安装时禁用脚本或跳过下载会导致二进制缺失；也请检查下载日志中的网络错误。',
    'Disabled install scripts, skipped downloads, or network failures can leave the binary missing.',
    '排查步骤 / Troubleshooting: docs/LOCAL_DEPLOYMENT.md (also _EN.md / _JA.md).',
  ].join('\n'));
  process.exitCode = 1;
}
