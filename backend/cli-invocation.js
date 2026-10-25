'use strict';

const path = require('path');

// Windows cannot spawn npm .cmd shims directly. Only fixed CLI flags and a
// validated session UUID may enter cmd.exe; free-form prompts go through stdin.
function cliInvocation(file, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { file, args, options: {} };
  if (!path.win32.isAbsolute(file) || /["%\r\n!^&|<>]/.test(file)
      || args.some((arg) => !/^[a-zA-Z0-9_.:/=-]+$/.test(String(arg)))) {
    throw new Error('Unsupported Windows CLI launcher; use the native .exe or a standard npm shim.');
  }
  return {
    file: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `""${file}" ${args.join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}

module.exports = { cliInvocation };
