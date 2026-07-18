'use strict';
// Minimal reproduction of bracket loss
const lines = [
  '# Sample config',
  'provider = "deepseek"',
  '',
  '[hooks]',
  'enabled = true',
  '',
  '[[hooks.hooks]]',
  'event = "message_submit"',
  'command = "echo hello"',
  '',
  '[[hooks.hooks]]',
  'event = "turn_end"',
  'command = "echo done"',
  '',
  '[model]',
  'name = "test"',
];

// Verify input
console.log('=== INPUT ===');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('hooks') || lines[i].includes('model')) {
    console.log(`  line ${i}: [${lines[i].charCodeAt(0)}] ${JSON.stringify(lines[i])}`);
  }
}

// findHooksTableLine
let hooksLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^\[hooks\]\s*$/.test(lines[i])) { hooksLine = i; break; }
}

// findLastHooksHooksArrayLine
let lastArr = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^\[\[hooks\.hooks\]\]\s*$/.test(lines[i])) lastArr = i;
}

console.log(`\n[hooks] at line ${hooksLine}`);
console.log(`lastArr at line ${lastArr}`);

// Splice
const ourEntries = [
  '[[hooks.hooks]]',
  'event = "session_start"',
  'command = "test"',
  'timeout_secs = 5',
  'background = false',
  'continue_on_error = false',
  'name = "octopus"',
];
lines.splice(lastArr + 1, 0, '', ...ourEntries, '');

// Verify output
console.log('\n=== OUTPUT ===');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('hooks') || l.includes('model')) {
    const firstChar = l.charCodeAt(0);
    console.log(`  line ${i}: [${firstChar}=${String.fromCharCode(firstChar)}] ${JSON.stringify(l)}`);
  }
}

// The key test: join and re-split
const joined = lines.join('\n');
const reSplit = joined.split('\n');
console.log('\n=== RE-SPLIT CHECK ===');
for (let i = 0; i < reSplit.length; i++) {
  const l = reSplit[i];
  if (l.includes('hooks') || l.includes('model')) {
    const firstChar = l.charCodeAt(0);
    console.log(`  line ${i}: [${firstChar}] ${JSON.stringify(l)}`);
  }
}