'use strict';

// backend/zstd.js 单元测试 —— dsh 的会话日志是「独立 zstd 帧串联」，桌宠必须
// 能在文件还在写的时候只吃完整帧。fixture 是一份真实形状的 session.jsonl.zstd
// （Node 22 的 zstdCompressSync + checksum 生成，三帧：header / 两个写入批次），
// 以 base64 内联，这样跑测试的 Node 有没有原生 zstd 都不影响结果。
// Run: node test/zstd.js

const assert = require('assert');
const { scanFrames, decodeFrame, decodeFrames, hasNativeZstd } = require('../backend/zstd');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 三帧：{header} / {turn/start + user/message} / {tool/call + assistant/message + turn/end}
const FIXTURE_B64 = 'KLUv/SSMjQMAMscXG4C5OYB3hMXKciOetJLoPQZiQ0ZMxkpjKksAJ4CGn00Zea9/hWVfErPuBNbWpuWHp9GG9lxzOMQeCmVEFEUQSJB3kN/0p4xOTq425zCaRs5lRNB7wmjWlurVyHeLNSMFAGxBXFWBjMtRKPvaliY2F77kKLUv/WQAAN0FACKKJSuAqenInQF27OPmsDhFqpD7YMvX2nI3blqGZqxJ87BIAHmlNuhaQtGF1Q0WyXzj+L32/Wsw0yBQxq/5mDc4oCSJCcKhKmCoFB4opIlpQaIaIioQEqbvALdj347bQczXbJwDwAyUUAAEGeNIi5EfBXKUyZxsH+1bt+ZLVZmq6rIwFmzPj9Nfuhfg+PWGraPioOzv+RH0ow0AKgEwC0Mcyt8hIuJQqyK8BhiYYAB34JkShCKhoNZL7QGCue+jKLUv/WTdANUIACYQNi6ARUkHAI1RlAYBGDjGzKk2hlK2FIL2lqRN0vYlN2L4Aw1SQvQNtdbIo2gGhWToKAAmAC0AC34h14/w2ck8KaUeSiklkRAMLHh9mn564BuUn+44uRwOY328tod+FBFCIDpJZn0cvdncMGfjvb/oeO7Vx02gfDqFc+G5T1/W8UxB0+anC9KOPRY8r1YYQru2zSN0T0/hHWICIyDCIqNCAsAFRYCjg3YCvld72Xq6w6AHjffeGW112sO2qSzjVCgScSzk+sxqa3l8M9CVDJDjp/eUEmBSD5SyMhkAfStDZIICysFkv+X2ZmkLaBxNvbS5xE0Mi2cBxYionO2xw4/lQayg/VBEIAA0B5Mt2AP2oRgIoyDYOtiWKGD4gP0=';
const FIXTURE = Buffer.from(FIXTURE_B64, 'base64');

console.log(`[Z0] 解码器：${hasNativeZstd ? '原生 zlib zstd' : '内置 fzstd（Electron 33 = Node 20 走这条）'}`);

console.log('[Z1] 扫帧：只认结构完整的帧');
check('三帧串联全部认出，且首尾相接无空隙', () => {
  const scan = scanFrames(FIXTURE);
  assert.strictEqual(scan.frames.length, 3);
  assert.strictEqual(scan.tornStart, undefined);
  assert.strictEqual(scan.frames[0].start, 0);
  assert.strictEqual(scan.frames[2].end, FIXTURE.length);
  for (let i = 1; i < scan.frames.length; i++) {
    assert.strictEqual(scan.frames[i].start, scan.frames[i - 1].end);
  }
});

check('末尾半帧只算到上一帧，并给出半帧起点', () => {
  const full = scanFrames(FIXTURE);
  const cut = FIXTURE.subarray(0, FIXTURE.length - 7); // 砍掉最后一帧的尾巴
  const scan = scanFrames(cut);
  assert.strictEqual(scan.frames.length, 2);
  assert.strictEqual(scan.tornStart, full.frames[2].start);
});

check('只写了几个字节（连帧头都不全）→ 没有完整帧，等下一轮', () => {
  const scan = scanFrames(FIXTURE.subarray(0, 3));
  assert.strictEqual(scan.frames.length, 0);
  assert.strictEqual(scan.tornStart, 0);
});

check('不是 zstd 数据 → 报 error 而不是抛异常', () => {
  const scan = scanFrames(Buffer.from('{"type":"session"}\n', 'utf8'));
  assert.ok(scan.error, '应给出 error 让调用方放弃这个文件');
  assert.strictEqual(scan.frames.length, 0);
});

console.log('[Z2] 解码：逐帧解，串联帧一个都不能少');
check('decodeFrame：单帧 → 该批次的明文', () => {
  const { frames } = scanFrames(FIXTURE);
  const head = decodeFrame(FIXTURE.subarray(frames[0].start, frames[0].end)).toString('utf8');
  const first = JSON.parse(head.trim());
  assert.strictEqual(first.type, 'session');
  assert.strictEqual(first.id, 'dsh-sess-zstd-1');
  assert.strictEqual(first.cwd, '/tmp/zproj');
});

check('decodeFrames：三帧全解出来（原生一次性解压只会给第一帧，这里必须给全）', () => {
  const { text, consumed, error } = decodeFrames(FIXTURE);
  assert.ok(!error);
  assert.strictEqual(consumed, FIXTURE.length);
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.type), [
    'session', 'turn/start', 'user/message', 'tool/call', 'assistant/message', 'turn/end',
  ]);
  assert.deepStrictEqual(lines.map((l) => l.seq).filter((n) => n !== undefined), [0, 1, 2, 3, 4]);
});

check('decodeFrames：半帧不消费——consumed 停在最后一个完整帧末尾', () => {
  const full = scanFrames(FIXTURE);
  const cut = FIXTURE.subarray(0, FIXTURE.length - 7);
  const { text, consumed } = decodeFrames(cut);
  assert.strictEqual(consumed, full.frames[1].end);
  assert.ok(!text.includes('turn/end'), '半帧里的事件不能提前吐出来');
  // 补齐剩下的字节后，接着读就能拿到最后一帧
  const rest = decodeFrames(FIXTURE.subarray(consumed));
  assert.ok(rest.text.includes('turn/end'));
  assert.strictEqual(consumed + rest.consumed, FIXTURE.length);
});

process.exit(failures ? 1 : 0);
