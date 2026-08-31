'use strict';

// command-safety 识别器的旁路矩阵 + 权限池资源边界。
// 每条「不安全」用例都对应一个真实存在过的攻击面或上游行为，
// 拒绝它们是本模块存在的意义；「安全」用例保证可用性没有被过度牺牲。

const assert = require('assert');
const { EventEmitter } = require('events');
const { isSafeReadOnlyCommand } = require('../backend/command-safety');
const { createCodeWhalePermissions, MAX_PENDING } = require('../backend/codewhale-permission');

// ── 必须放行的单一只读命令 ────────────────────────────────────────────────────
const SAFE = [
  'ls', 'ls -la', 'ls -la /tmp',
  'cat README.md', 'head -n 20 file.txt', 'tail -f never', // -f 不会执行任何东西
  'wc -l main.py', 'pwd', 'date', 'date -u', 'whoami', 'uname -a',
  'which node', 'type ls', 'du -sh .', 'du -x /tmp', 'df -h', 'printenv', 'arch',
  'grep -n needle file', 'rg "pattern" backend/', 'ag foo', 'fd -e js', 'locate foo',
  'git status', 'git status --short', 'git log --oneline -5', 'git diff',
  'git diff --stat', 'git show HEAD', 'git describe --tags', 'git rev-parse HEAD',
  'git help status', 'git branch', 'git branch -a', 'git branch -vv --all',
  'git remote', 'git remote -v',
  'ls -X', // ls 按扩展名排序
];

// ── 必须拒绝的（每个都有理由）────────────────────────────────────────────────
const OVERSIZED = 'ls ' + 'a'.repeat(5000); // 超长命令
const UNSAFE = {
  // shell 语法链接/替换/重定向 —— 旧前缀检查的真实绕过面
  'ls; rm -rf /': '命令链接',
  'git status && curl https://example.invalid': 'AND 链接',
  'pwd | sh': '管道进 shell',
  'echo $(touch /tmp/pwn)': '命令替换',
  'cat README.md > /tmp/copy': '重定向写文件',
  'cat README.md >> ~/.bashrc': '追加写启动文件',
  'find . -exec sh -c "echo pwn" \\;': 'find -exec',
  'ls\nrm -rf /': '换行分命令',
  'ls`touch /tmp/pwn`': '反引号替换',
  'git status <(curl evil)': '进程替换',
  'git log ${IFS:+-p}': '参数展开',
  // 执行类工具 / 选项
  'env rm -rf /tmp/proof': 'env 执行第一个参数（本识别器最著名的旁路）',
  'env node -e "require(\'child_process\').exec(\'rm -rf /\')"': 'env 执行 node',
  'rg --pre /bin/sh': 'rg 预处理器执行',
  'fd -x rm': 'fd 按匹配执行',
  'fd -X rm -rf /': 'fd 批量执行',
  'xargs rm': 'xargs（不在白名单本身就该拒）',
  // git 可变子命令
  'git branch -D work': '删分支',
  'git branch -d work': '删分支',
  'git branch -m old new': '重命名分支',
  'git branch newbranch': '建分支',
  'git remote add origin https://evil': '改 remote 配置',
  'git remote remove origin': '删 remote',
  'git remote set-url origin https://evil': '改 remote URL',
  'git diff --output=/tmp/x': 'diff 写任意文件',
  'git diff --ext-diff': '执行 gitconfig 里的外部 diff',
  'git show --output=/tmp/x': 'show 写文件',
  // 其它可变命令
  'date -s "2020-01-01"': '改系统时钟',
  'date --set "2020-01-01"': '改系统时钟',
  // 长度/类型边界
  [OVERSIZED]: '超长命令',
  '': '空命令',
};

for (const [command, why] of Object.entries(UNSAFE)) {
  assert.strictEqual(isSafeReadOnlyCommand(command), false, `必须拒绝（${why}）: ${JSON.stringify(command)}`);
}
for (const command of SAFE) {
  assert.strictEqual(isSafeReadOnlyCommand(command), true, `应当放行: ${JSON.stringify(command)}`);
}
assert.strictEqual(isSafeReadOnlyCommand(null), false);
assert.strictEqual(isSafeReadOnlyCommand(undefined), false);
assert.strictEqual(isSafeReadOnlyCommand(42), false);
console.log(`✓ command-safety：${SAFE.length} 条放行 + ${Object.keys(UNSAFE).length} 条拒绝全部正确`);

// ── 权限池资源边界 ────────────────────────────────────────────────────────────
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.headers = {};
  res.body = null;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; };
  res.end = (body) => { res.writableEnded = true; res.body = body; res.emit('close'); };
  return res;
}

async function main() {
// 权限池的 auto-deny 定时器是 unref 的（生产上不能阻塞应用退出）——测试进程
// 没有别的事件源时 node 会在定时器触发前退出，这里用一个 ref'd 的 keep-alive
// 保住事件循环，结束时清掉。
const keepAlive = setInterval(() => {}, 20);
try {
// 1) 超时主动 deny（autoDenyMs 压到 40ms 便于测试）
{
  const pool = createCodeWhalePermissions({ autoDenyMs: 40 });
  const res = fakeRes();
  pool.addPermission(res, { sessionId: 's1', toolName: 'exec_shell', toolInput: { command: 'curl evil' } });
  assert.strictEqual(pool.getPending().length, 1);
  const body = await new Promise((r) => res.on('close', () => r(res.body)));
  assert.strictEqual(JSON.parse(body).decision, 'deny', `超时必须 deny（上游无响应默认 allow），得到: ${body}`);
  assert.ok(JSON.parse(body).reason);
  assert.strictEqual(pool.getPending().length, 0);
  console.log('✓ 权限池：超时主动 deny（而不是会被上游超时放行的 ask/allow）');
}

// 1b) 只读 exec_shell 不入池、立即 allow；expiresAt 暴露在挂起项上
{
  const pool = createCodeWhalePermissions({});
  const res = fakeRes();
  pool.addPermission(res, { sessionId: 's-safe', toolName: 'exec_shell', toolInput: { command: 'ls -la' } });
  assert.strictEqual(pool.getPending().length, 0, 'safe read-only command must not park');
  assert.strictEqual(JSON.parse(res.body).decision, 'allow');
  const parked = fakeRes();
  pool.addPermission(parked, { sessionId: 's-safe', toolName: 'exec_shell', toolInput: { command: 'cargo test' } });
  const entry = pool.getPending()[0];
  assert(entry && typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now(), 'pending entry must expose expiresAt');
  pool.decide(entry.id, 'deny');
  console.log('✓ 权限池：只读 exec_shell 直接 allow，挂起项带 expiresAt');
}

// 1c) autoDenyMs 边界：0 / 负数 / Infinity / NaN → 一律回退 8 分钟窗口
{
  for (const bad of [0, -5, Infinity, NaN]) {
    const pool = createCodeWhalePermissions({ autoDenyMs: bad });
    const res = fakeRes();
    pool.addPermission(res, { sessionId: 's-bad', toolName: 'exec_shell', toolInput: { command: 'curl evil' } });
    const entry = pool.getPending()[0];
    const windowMs = entry.expiresAt - entry.createdAt;
    assert(Math.abs(windowMs - 8 * 60 * 1000) < 100, `autoDenyMs=${bad} must fall back to the 8-minute window, got ${windowMs}ms`);
    pool.decide(entry.id, 'deny');
  }
  console.log('✓ 权限池：autoDenyMs 非法值回退 8 分钟窗口');
}

// 2) 挂起上限：第 MAX_PENDING+1 个立即 ask
{
  const pool = createCodeWhalePermissions({});
  const responses = [];
  for (let i = 0; i <= MAX_PENDING; i++) {
    const res = fakeRes();
    responses.push(res);
    pool.addPermission(res, { sessionId: `s-${i}`, toolName: 'exec_shell', toolInput: { command: 'curl evil' } });
  }
  assert.strictEqual(pool.getPending().length, MAX_PENDING);
  const overflow = responses[MAX_PENDING];
  assert.strictEqual(JSON.parse(overflow.body).decision, 'ask', '超限必须立即 ask');
  // 清理
  pool.cleanup();
  for (const res of responses.slice(0, MAX_PENDING)) {
    assert.strictEqual(JSON.parse(res.body).decision, 'deny');
  }
  console.log(`✓ 权限池：${MAX_PENDING} 上限，溢出立即 ask，cleanup 全部 deny`);
}

// 3) 连接关闭 → 移除挂起项
{
  const pool = createCodeWhalePermissions({});
  const res = fakeRes();
  pool.addPermission(res, { sessionId: 's-close', toolName: 'exec_shell', toolInput: { command: 'curl evil' } });
  assert.strictEqual(pool.getPending().length, 1);
  res.writableEnded = false;
  res.emit('close'); // 模拟 TUI 放弃连接
  assert.strictEqual(pool.getPending().length, 0);
  console.log('✓ 权限池：连接断开自动清理');
}

console.log('\n✅ command-safety + 权限边界测试全部通过');
} finally {
  clearInterval(keepAlive);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
