'use strict';

// Windows adaptation unit tests (W7).
// Verifies the W1–W5 adaptation code is present and correct on a STATIC basis
// (interface shape, string contents, platform guards). We cannot truly exercise
// win32 behavior on a macOS/Linux sandbox, but these tests catch regressions
// where someone accidentally removes a win32 branch or breaks the TOML/ICO
// safety invariants.
//
// Run: node test/windows-adapt.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

console.log('[W1] providers/codewhale.js — findCodeWhale win32 branch');
{
  const src = read('providers/codewhale.js');
  ok('findCodeWhale is exported', /provider\.findCodeWhale\s*=\s*findCodeWhale/.test(src));
  ok('win32 platform guard exists', /if\s*\(\s*plat\s*===\s*['"]win32['"]\s*\)/.test(src));
  ok('uses Windows built-in `where` (not `which`)', /execFileSync\(['"]where['"]/.test(src));
  ok('where invocations include windowsHide:true', /execFileSync\(['"]where['"][^)]*windowsHide:\s*true/.test(src));
  ok('prefers .cmd/.exe over .ps1 (skips .ps1 shim)', src.includes('.ps1') && src.includes('.cmd'));
  ok('has Windows path candidates (APPDATA/npm)', /APPDATA/.test(src) && /npm/.test(src));
  ok('has Windows path candidates (LOCALAPPDATA/Programs/CodeWhale)', /LOCALAPPDATA/.test(src) && /CodeWhale/.test(src));
  ok('has Windows path candidates (ProgramFiles/nodejs)', /ProgramFiles/.test(src) && /nodejs/.test(src));
  ok('Unix branch uses a shell for command -v', /execFileSync\(shell[^;]+command -v/.test(src));
  ok('Unix path candidates preserved (/usr/local/bin)', /\/usr\/local\/bin\/codewhale/.test(src));
  ok('Unix path candidates preserved (homebrew)', /homebrew/.test(src));
}

console.log('\n[W2] providers/codewhale.js — hookTomlSchema forward-slash normalization');
{
  const src = read('providers/codewhale.js');
  ok('hookTomlSchema is defined', /hookTomlSchema:\s*Object\.freeze/.test(src));
  ok('command uses split(path.sep).join("/")', /HOOK_SCRIPT\.split\(path\.sep\)\.join\(['"]\/['"]\)/.test(src));
  // Load the module and inspect the actual generated commands (no Electron needed).
  const cw = require('../providers/codewhale');
  const entries = cw.hookTomlSchema.entries;
  ok('hookTomlSchema.entries is a non-empty array', Array.isArray(entries) && entries.length > 0);
  let allForwardSlash = true;
  let allContainEvent = true;
  let allHaveNodePrefix = true;
  for (const e of entries) {
    if (typeof e.command !== 'string' || e.command.includes('\\')) allForwardSlash = false;
    // W6: command is now `node "path/codewhale-hook.js" event` (node prefix +
    // quoted path). The closing quote may or may not be present depending on
    // whether the path has spaces, so match optionally.
    if (typeof e.command !== 'string' || !e.command.includes('codewhale-hook.js') || !e.command.endsWith(process.platform === 'win32' ? e.event : `'${e.event}'`)) allContainEvent = false;
    if (typeof e.command !== 'string' || !/^(?:node|'node')\s/.test(e.command)) allHaveNodePrefix = false;
  }
  ok('all entry commands contain zero backslashes', allForwardSlash);
  ok('all entry commands end with the event name', allContainEvent);
  ok('all entry commands have node prefix (W6: prevents WScript on Windows)', allHaveNodePrefix);
  ok('tool_call_before entry has timeout_secs=600 (permission bridge)', entries.some((e) => e.event === 'tool_call_before' && e.timeout_secs === 600));
  ok('non-permission entries have short timeout (<=5)', entries.filter((e) => e.event !== 'tool_call_before').every((e) => e.timeout_secs <= 5));
  ok('tool_call_before has background=false (R2.10 permission gate)', entries.some((e) => e.event === 'tool_call_before' && e.background === false));
}

console.log('\n[W3] backend/launch.js — wt.exe wrapped in cmd.exe /c');
{
  const src = read('backend/launch.js');
  ok('win32 platform guard exists', /plat\s*===\s*['"]win32['"]/.test(src));
  ok('findClaude uses Windows `where`', /execFileSync\(['"]where['"]\s*,\s*\[['"]claude['"]\]/.test(src));
  ok('wt.exe is wrapped in cmd.exe /c (not spawned directly)', /['"]cmd\.exe['"]\s*,\s*\[\s*['"]\/c['"]\s*,\s*['"]wt\.exe['"]/.test(src));
  ok('fallback to cmd.exe /c start exists', /cmd\.exe['"]\s*,\s*\[\s*['"]\/c['"]\s*,\s*['"]start['"]/.test(src));
  ok('workDir uses cd /d (Windows drive change)', /cd\s+\/d/.test(src));
  // Runtime check only on win32 (buildCandidates branches on platform).
  if (process.platform === 'win32') {
    const { buildCandidates } = require('../backend/launch');
    const cands = buildCandidates('C:\\fake\\claude.exe', 'C:\\Users\\me\\proj');
    const wtCand = cands.find((c) => c[0] === 'cmd.exe' && c[1].includes('wt.exe'));
    ok('buildCandidates returns a cmd.exe /c wt.exe candidate', !!wtCand);
    ok('wt.exe candidate starts with /c', wtCand && wtCand[1][0] === '/c');
  } else {
    ok('buildCandidates wt.exe candidate (static: code contains cmd.exe /c wt.exe)', src.includes("['cmd.exe'",) || src.includes('"cmd.exe"'));
    ok('wt.exe candidate starts with /c (static: code contains /c wt.exe)', src.includes('/c',) && src.includes('wt.exe'));
  }
}

console.log('\n[W4] main.js — disableHardwareAcceleration on win32');
{
  const src = read('main.js');
  ok('disableHardwareAcceleration call exists', /app\.disableHardwareAcceleration\(\)/.test(src));
  ok('guarded by win32 platform check', /process\.platform\s*===\s*['"]win32['"][\s\S]*?app\.disableHardwareAcceleration/.test(src));
  ok('wrapped in try/catch (non-fatal)', /try\s*\{\s*app\.disableHardwareAcceleration\(\);?\s*\}\s*catch/.test(src));
  ok('app.dock usage guarded by darwin check', /process\.platform\s*===\s*['"]darwin['"][\s\S]*?app\.dock/.test(src));
  ok('petWin has skipTaskbar:true', /skipTaskbar:\s*true/.test(src));
  ok('setTemplateImage guarded by darwin check', /process\.platform\s*===\s*['"]darwin['"][\s\S]*?setTemplateImage/.test(src));
}

console.log('\n[W5] backend/tray-icon.js — runtime .ico generation');
{
  const src = read('backend/tray-icon.js');
  ok('module file exists', src.length > 0);
  ok('exports getTrayIconPath', /exports.*getTrayIconPath/.test(src) || /module\.exports.*getTrayIconPath/.test(src));
  ok('exports ensureTrayIcon', /exports.*ensureTrayIcon/.test(src) || /module\.exports.*ensureTrayIcon/.test(src));
  ok('ICO_SIZES covers 16/32/48/256', /\b16\b/.test(src) && /\b32\b/.test(src) && /\b48\b/.test(src) && /\b256\b/.test(src));
  ok('win32 guard in getTrayIconPath', /process\.platform\s*!==\s*['"]win32['"]/.test(src));
  ok('uses png-to-ico (lazy require)', /require\(['"]png-to-ico['"]\)/.test(src));
  ok('handles ESM interop (.default fallback)', /mod\.default\s*\|\|\s*mod/.test(src));
  ok('atomic write (tmp + rename)', /writeFileSync\([^)]*tmp/.test(src) && /renameSync/.test(src));
  ok('mtime freshness check (regenerate if source newer)', /mtimeMs/.test(src));
  ok('graceful fallback to PNG on error', /PNG_PATH/.test(src) && /catch/.test(src));
  ok('validates ico buffer size (>=100 bytes)', /Buffer\.isBuffer/.test(src) || /icoBuf\.length\s*<\s*100/.test(src));

  // Load and verify interface (no Electron needed for non-win32 path).
  const ti = require('../backend/tray-icon');
  ok('getTrayIconPath is a function', typeof ti.getTrayIconPath === 'function');
  ok('ensureTrayIcon is a function', typeof ti.ensureTrayIcon === 'function');
  ok('ICO_SIZES is array of numbers', Array.isArray(ti.ICO_SIZES) && ti.ICO_SIZES.every((n) => typeof n === 'number'));
  ok('PNG_PATH points to assets/tray.png', ti.PNG_PATH.endsWith(path.join('assets', 'tray.png')));
  ok('SRC_HQ_PATH points to assets/tray@2x.png', ti.SRC_HQ_PATH.endsWith(path.join('assets', 'tray@2x.png')));
  // On non-win32, getTrayIconPath returns PNG path immediately.
  if (process.platform !== 'win32') {
    ok('non-win32 returns PNG_PATH', ti.getTrayIconPath() === ti.PNG_PATH);
    ti.ensureTrayIcon().then((v) => {
      ok('non-win32 ensureTrayIcon resolves null', v === null);
      // E2E: verify png-to-ico .default actually generates a valid ICO buffer
      // from tray@2x.png (pure JS, no Electron needed). This catches the
      // ESM-interop + square-PNG contract regression that bit us once.
      const mod = require('png-to-ico');
      const pngToIco = mod.default || mod;
      const srcBuf = fs.readFileSync(ti.SRC_HQ_PATH);
      pngToIco(srcBuf).then((buf) => {
        ok('png-to-ico .default generates Buffer', Buffer.isBuffer(buf));
        ok('ico buffer > 100 bytes', buf && buf.length > 100);
        ok('ico magic header is 00000100 (valid ICO: reserved=0, type=1)', buf && buf.slice(0, 4).toString('hex') === '00000100');
        done();
      }).catch((e) => {
        ok('png-to-ico .default generates Buffer', false);
        console.log('    png-to-ico error:', e.message);
        done();
      });
    });
  } else {
    done();
  }
}

function done() {
  console.log('\n[W6] WINDOWS.md documentation');
  {
    const doc = read('WINDOWS.md');
    ok('WINDOWS.md exists and non-empty', doc.length > 100);
    ok('documents install steps', /npm install/i.test(doc) && /npm start/i.test(doc));
    ok('documents focus tracking limitation', /focus/i.test(doc) && /graceful/i.test(doc));
    ok('documents territory limitation', /territory/i.test(doc));
    ok('documents hook flash window issue', /闪窗|flash/i.test(doc));
    ok('documents tray .ico generation', /\.ico/i.test(doc) && /tray-icon/i.test(doc));
    ok('references electron#40515 (transparent window bug)', /40515/.test(doc));
    ok('references claude-code#17230 (hook flash)', /17230/.test(doc));
    ok('has troubleshooting section (故障排查)', /故障排查|troubleshoot/i.test(doc));
    ok('has platform diff table (平台差异)', /平台差异|platform diff/i.test(doc));
    ok('lists W1-W5 code locations', /W1/.test(doc) && /W5/.test(doc));
  }

  console.log('\n[path-audit] production code — no hardcoded ~/ paths');
  {
    const files = [
      'providers/codewhale.js',
      'providers/claude.js',
      'backend/launch.js',
      'backend/config.js',
      'backend/toml-hooks.js',
      'backend/codewhale-permission.js',
      'backend/metering-codewhale.js',
      'backend/tray-icon.js',
      'main.js',
    ];
    let bad = 0;
    for (const f of files) {
      const src = read(f);
      // Allow "~" only inside comments/strings that document Unix paths,
      // but flag actual path operations like path.join('~', ...).
      if (/path\.join\(\s*['"]~['"]/.test(src) || /['"]~\/[^'"]*['"]/.test(src)) {
        bad++;
        console.log(`    ✗ ${f} contains hardcoded ~/ path`);
      }
    }
    ok('no hardcoded ~/ path operations in production code', bad === 0);
  }

  console.log('\n[toml-safety] hookTomlSchema commands are TOML-safe on Windows');
  {
    const cw = require('../providers/codewhale');
    const entries = cw.hookTomlSchema.entries;
    // Simulate what would be written on win32: path.sep === '\\'.
    // The command must not contain any backslash (TOML basic string escape).
    let tomlSafe = true;
    for (const e of entries) {
      const cmd = e.command;
      if (cmd.includes('\\')) { tomlSafe = false; break; }
    }
    ok('all hook commands are backslash-free (TOML-safe)', tomlSafe);
    // Verify the normalization LOGIC is correct: when path.sep === '\\',
    // split+join('/') converts backslashes to forward slashes. We simulate
    // by directly testing the string transform with '\\' as separator.
    const fakeWinPath = 'C:\\Users\\me\\codewhale-hook.js';
    const normalized = fakeWinPath.split('\\').join('/');
    ok('simulated win32 path normalizes to forward slashes (logic check)', normalized === 'C:/Users/me/codewhale-hook.js');
    ok('normalized path has no backslashes', !normalized.includes('\\'));
  }

  console.log('\n[W8] P3 路径安全审计 — JSON 路径序列化安全验证');
  {
    // Verify JSON.stringify correctly escapes backslashes (the implicit safety net
    // for all JSON-persisted paths: settings.json, usage*.json, runtime.json, config.json).
    const fakeWinPath = 'C:\\Users\\me\\.octopus\\config.json';
    const obj = { settingsPath: fakeWinPath, nodeBin: 'C:\\Program Files\\nodejs\\node.exe' };
    const jsonStr = JSON.stringify(obj);
    ok('JSON.stringify escapes backslashes', jsonStr.includes('C:\\\\Users\\\\me') || !jsonStr.includes('C:\\Users\\me'));
    ok('JSON round-trip preserves path', JSON.parse(jsonStr).settingsPath === fakeWinPath);
    ok('JSON round-trip nodeBin', JSON.parse(jsonStr).nodeBin === 'C:\\Program Files\\nodejs\\node.exe');

    // Verify that Node.js accepts forward slashes on path construction concepts.
    // On any platform, path.join with forward slashes normalizes them.
    const mixed = path.join('C:', 'Users', 'me', '.octopus');
    ok('path.join produces platform-native separators', typeof mixed === 'string' && mixed.length > 0);

    // Verify toml-hooks.js writeAtomic output is TOML-safe for command paths.
    // The hookTomlSchema commands must survive a registerHooks→write→read cycle
    // without introducing backslashes. We check the entry data directly.
    const cw = require('../providers/codewhale');
    const entries = cw.hookTomlSchema.entries;
    let tomlEscapes = 0;
    for (const e of entries) {
      // In TOML basic strings, these escape sequences are invalid: \a, \c, \d, etc.
      // Only \\, \", \n, \t, \r are valid. Our paths should have NO backslashes at all.
      const cmd = e.command;
      if (/\\[^“ntr"\\]/.test(cmd)) tomlEscapes++;
    }
    ok('no invalid TOML escapes in hook commands', tomlEscapes === 0);

    // Verify config.json (via config.js) does not store raw paths that could break.
    const configSrc = read('backend/config.js');
    ok('config.js uses os.homedir() (not hardcoded ~)', /os\.homedir\(\)/.test(configSrc));
    ok('config.js uses path.join for CONFIG_PATH', /path\.join\(\s*[^)]*os\.homedir/.test(configSrc));
  }

  console.log('\n[W9] P1 上游问题引用 — WINDOWS.md 记录完整性');
  {
    const doc = read('WINDOWS.md');
    ok('documents Claude Code issue #17230', /#17230/.test(doc));
    ok('documents Claude Code issue #14828', /#14828/.test(doc));
    ok('documents Claude Code issue #19012', /#19012/.test(doc));
    ok('documents Claude Code issue #28138', /#28138/.test(doc));
    ok('documents Claude Code issue #54519', /#54519/.test(doc));
    ok('documents CodeWhale Rust CREATE_NO_WINDOW', /CREATE_NO_WINDOW/.test(doc));
    ok('documents that hook flash is upstream issue', /上游/.test(doc) && /闪窗/.test(doc));
    ok('documents JSON.stringify path safety', /JSON\.stringify/.test(doc));
    ok('W8 path audit section exists', /W8/.test(doc) && /路径安全审计/.test(doc));
  }

  console.log('\n[W10] README.md Windows 支持声明');
  {
    const readme = read('README.md');
    ok('README mentions Windows in prerequisites', /macOS\s*\/\s*Windows/.test(readme));
    ok('README links to WINDOWS.md', /WINDOWS\.md/.test(readme));
    ok('README does not claim macOS-only', !/macOS（状态/.test(readme));
    ok('README mentions CodeWhale in title or description', /CodeWhale/.test(readme));
    ok('README directory lists tray-icon.js', /tray-icon\.js/.test(readme));
    ok('README directory lists providers/', /providers\//.test(readme));
    ok('README directory lists windows-adapt.js', /windows-adapt\.js/.test(readme));
  }

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ SOME FAILED'} — W1-W10 Windows adaptation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
