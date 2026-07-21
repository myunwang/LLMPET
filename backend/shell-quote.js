'use strict';

// Quote one argument for the shell actually used by the hook runner.
// Never concatenate untrusted/unusual installation paths into a command with
// double quotes: `$()`, backticks and embedded quotes have special meaning on
// POSIX shells, while PowerShell uses a different escaping model.
function quotePosix(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function commandForNode(nodeBin, script, event, platform = process.platform) {
  if (platform === 'win32') {
    return `& ${quotePowerShell(nodeBin)} ${quotePowerShell(script)} ${quotePowerShell(event)}`;
  }
  return `${quotePosix(nodeBin)} ${quotePosix(script)} ${quotePosix(event)}`;
}

module.exports = { quotePosix, quotePowerShell, commandForNode };
