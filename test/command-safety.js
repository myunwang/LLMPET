'use strict';

// command-safety 识别器的旁路矩阵。
// 每条「不安全」用例都对应一个真实存在过的攻击面或上游行为，
// 拒绝它们是本模块存在的意义；「安全」用例保证可用性没有被过度牺牲。

const assert = require('assert');
const { isSafeReadOnlyCommand } = require('../backend/command-safety');

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

console.log('\n✅ command-safety 识别器测试全部通过（权限池边界随 CodeWhale provider PR 测试）');
