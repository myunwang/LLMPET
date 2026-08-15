'use strict';

// DeepSeek Harness (dsh) session watcher —— 只读监听 ~/.dsh/sessions 下的会话日志，
// 把 dsh 的会话状态翻译成 core 的事件流（agentId: 'dsh'）。
//
// 为什么又是「读文件」：dsh 确实带 Claude Code / Codex 两种 hook 桥接插件
// (@deepseek-ai/dsh-hooks-claude-code)，但它们默认不在 base bundle 里，要用户往
// 自己的 profile 里装插件 + 写 cordis.patch.yml 才能生效。为了一只桌宠去改用户的
// agent 组合，代价太大；而 session 日志是 dsh 的权威事件源（turn/step/tool/approval
// 全都有独立事件），tail 它零配置、零侵入，卸载桌宠不留任何痕迹——和 Codex 路径同款。
//
// 磁盘布局（packages/session/session-persistence-jsonl）：
//   $DSH_HOME|~/.dsh /sessions/--<归一化 cwd>--/<encodeSegment(sessionId)>/session.jsonl.zstd
//   压缩关掉时是 session.jsonl；两种后缀都认。日志是 append-only 的 JSONL：
//   第一行 header {type:'session',id,cwd,createdAt,delegationDepth,origin?}，其后每行一个事件
//   {type,seq,time,data}。无斜杠 tag 的行（text-chunks / reasoning-chunks / tool-call-chunks）
//   是流式增量的打包行，对桌宠没有信息量，跳过。
//
// 事件映射（dsh 日志 → core 状态机，词汇表完全复用 Claude / Codex 路径）：
//   header(首次发现)          → SessionStart(idle)   仅运行期间新出现的会话
//   turn/start                → TaskStarted(thinking) 清完成徽标、开启本轮
//   user/message(source.user) → UserPromptSubmit(thinking) + 情绪嗅探 + 首条兜底标题
//   step/start                → 本轮首个工具前 thinking，之后保持 working
//   tool/call, tool/code-dispatch-start → PreToolUse(working)
//   tool/result               → PostToolUse(working)；带 error → PostToolUseFailure(error)
//   assistant/message         → 记正文（回合结束当气泡）+ usage → 上下文用量
//   turn/end completed        → Stop(attention) → 庆祝 + 气泡
//   turn/end error            → ApiError(error)
//   turn/end 其他原因         → TurnAborted(idle) → 「中断」徽标（未知值不误庆祝）
//   approval/asked            → Notification → 「等你回复」（dsh 的授权在它自己的
//                               界面里回答，桌宠只镜像「有人在等你」这个事实）
//   approval/decided          → 回到 working/thinking 或 idle
//   compaction/start|end      → PreCompact(sweeping) → Reasoning
//   session/title             → 会话标题（dsh 自己起的标题比首条 prompt 好用）
//   request/header|context    → 模型名与上下文窗口（算 context%）
//
// 过滤：header 的 origin === 'subagent' 或 delegationDepth > 0 → 整个文件跳过
// （子 agent 线程不是用户会话，会把会话列表刷成审计日志）。
//
// zstd：日志默认是「独立帧串联」，且 Electron 33 的 Node 20 没有原生 zstd —— 切帧
// 与解码在 backend/zstd.js，这里只负责「读新增字节 → 拿到明文 → 攒整行」。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const { detectEmotion } = require('./emotion');
const { promptTitle } = require('./transcript');
const { decodeFrames, scanFrames, decodeFrame } = require('./zstd');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');
const LOG_NAMES = ['session.jsonl.zstd', 'session.jsonl'];
const POLL_MS = 2500;
const BACKFILL_MAX_AGE_MS = 30 * 60 * 1000; // 与 core 的 backfill 窗口对齐
const IDLE_UNTRACK_MS = 60 * 60 * 1000;     // 文件超过 1h 没动 → 不再跟踪（再动会重新发现）
const MAX_READ_PER_TICK = 512 * 1024;       // 单文件单轮读取上限
const MAX_FRAME_READ = 8 * 1024 * 1024;     // 单帧比上限还大时的逐步放宽封顶
const MAX_FRAME_DECODE = 32 * 1024 * 1024;  // 已知边界的大帧最多整帧解码 32MiB；再大则跳帧续读
const MAX_BACKFILL_BYTES = 16 * 1024 * 1024; // 启动整读封顶；更大的只认头部身份
const TAIL_PROBE_BYTES = 256 * 1024;        // 超大明文日志的尾部探针
const FULL_SWEEP_TICKS = 12;                // 每 ~30s 全量扫一次（捞回被 resume 的老会话）
const ASSISTANT_MAX = 2400;                 // 与 server.js 的 ASSISTANT_LAST_OUTPUT_MAX 一致

// dsh 工具名 → 既有词汇（adapter 的图标/中文标签按这个词查）。dsh 的工具是插件化的，
// 名字会随组合变化，所以除了精确表还留了几条形状规则，认不出来的原样透传（adapter 有 🔧 兜底）。
const TOOL_MAP = {
  bash: 'Bash', pwsh: 'Bash', shell: 'Bash', run_command: 'Bash',
  str_replace_editor: 'Edit', apply_patch: 'Edit', edit: 'Edit', edit_file: 'Edit',
  fs_write: 'Write', write: 'Write', create_file: 'Write',
  fs_read: 'Read', read: 'Read', read_file: 'Read', view: 'Read', view_image: 'Read',
  fs_search: 'Grep', grep: 'Grep', search: 'Grep', glob: 'Glob', find: 'Glob',
  web_search: 'WebSearch', web_fetch: 'WebFetch', web: 'WebSearch',
  todo: 'TodoWrite', todo_write: 'TodoWrite', update_plan: 'TodoWrite',
  task: 'Task', subagent: 'Task', subagent_report: 'Task', workflow: 'Task',
  run_code: 'Js', js: 'Js', jobs: 'Wait',
};
function mapTool(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Tool';
  const key = raw.toLowerCase();
  if (TOOL_MAP[key]) return TOOL_MAP[key];
  if (key.startsWith('subagent') || key.startsWith('agent_')) return 'Task';
  if (key.startsWith('grep') || key.includes('search')) return 'Grep';
  if (key.startsWith('fs_') || key.includes('read_file')) return 'Read';
  return raw;
}

// 会话目录名是 encodeSegment(sessionId)：安全字符原样，其余转成 ~XXXX（UTF-16 码元）。
// 只在 header 读不出来时兜底用（例如日志大到只读了头部却又恰好没解出来）。
function decodeSegment(seg) {
  return String(seg || '').replace(/~([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function readBytes(fp, start, len) {
  let fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

// scanFrames(Buffer) 很适合普通帧，但为了找到一个 20MiB 帧的末尾，不应该先把
// 20MiB 全塞进内存。这里对文件做同一套结构扫描：只读 magic / frame header /
// block header，payload 直接 seek 跳过。这样即便 dsh 正在追加一个超大帧，也能把
// cursor 稳定留在“上一个完整帧”的边界，而不是误记到 raw EOF。
const ZSTD_MAGIC = 0xFD2FB528;
const SKIP_MAGIC_MASK = 0xFFFFFFF0;
const SKIP_MAGIC_BASE = 0x184D2A50;

function readFdBytes(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return n === len ? buf : buf.subarray(0, n);
}

function scanFrameAt(fd, start, size) {
  const available = (pos, len) => pos >= 0 && len >= 0 && pos + len <= size;
  if (!available(start, 4)) return { torn: true, start };
  const magicBuf = readFdBytes(fd, start, 4);
  if (magicBuf.length < 4) return { torn: true, start };
  const magic = magicBuf.readUInt32LE(0);

  if ((magic & SKIP_MAGIC_MASK) === SKIP_MAGIC_BASE) {
    if (!available(start, 8)) return { torn: true, start };
    const head = readFdBytes(fd, start + 4, 4);
    if (head.length < 4) return { torn: true, start };
    const end = start + 8 + head.readUInt32LE(0);
    return end <= size ? { start, end, skippable: true } : { torn: true, start };
  }
  if (magic !== ZSTD_MAGIC) return { error: `invalid frame magic at byte ${start}`, start };

  let offset = start + 4;
  if (!available(offset, 1)) return { torn: true, start };
  const descriptor = readFdBytes(fd, offset, 1)[0];
  offset += 1;
  if ((descriptor & 0x18) !== 0) {
    return { error: `reserved frame-header bit at byte ${offset - 1}`, start };
  }
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const restHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (!available(offset, restHeaderBytes)) return { torn: true, start };
  offset += restHeaderBytes;

  for (;;) {
    if (!available(offset, 3)) return { torn: true, start };
    const block = readFdBytes(fd, offset, 3);
    if (block.length < 3) return { torn: true, start };
    const blockHeader = block.readUIntLE(0, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 0x03) {
      return { error: `reserved block type at byte ${offset - 3}`, start };
    }
    const payloadBytes = blockType === 0x01 ? 1 : blockSize;
    if (!available(offset, payloadBytes)) return { torn: true, start };
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (!available(offset, 4)) return { torn: true, start };
    offset += 4;
  }
  return { start, end: offset, skippable: false };
}

function scanFileFrames(fp, size, start = 0) {
  let fd = null;
  let offset = start;
  let lastFrame = null;
  try {
    fd = fs.openSync(fp, 'r');
    while (offset < size) {
      const span = scanFrameAt(fd, offset, size);
      if (span.error) return { committed: offset, lastFrame, error: span.error };
      if (span.torn) return { committed: offset, lastFrame, tornStart: offset };
      offset = span.end;
      if (!span.skippable) lastFrame = span;
    }
    return { committed: offset, lastFrame };
  } catch (e) {
    return { committed: start, lastFrame: null, error: e.message };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function scanOneFileFrame(fp, start, size) {
  let fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    return scanFrameAt(fd, start, size);
  } catch (e) {
    return { error: e.message, start };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function clipAssistant(s) {
  const text = String(s || '').trim();
  if (!text) return null;
  return text.length > ASSISTANT_MAX ? text.slice(0, ASSISTANT_MAX) : text;
}

// Message.content 是 ContentBlock[]（也兼容纯字符串）；只取文本块。
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof message.text === 'string' ? message.text : '';
}

// user/message 既是真人 prompt，也是 agent.inject() 的合成上下文（AGENTS.md、
// 技能正文、cron 通知……）。只有 source.kind === 'user' 才算「用户说话」，
// 否则一条技能注入就会让桌宠以为你提了新需求。
function isHumanPrompt(data) {
  if (!data || typeof data !== 'object') return false;
  const src = data.source;
  if (!src || typeof src !== 'object') return true; // 早期日志没有 source → 当真人
  return src.kind === 'user';
}

/**
 * assistant/message 的 usage → core 的 contextUsage 形状。
 * dsh 没有把「当前上下文占用」直接写进日志，这里用一次请求的 input+cache+output
 * 近似（对着 request/context 的 contextWindow 算百分比）——量级对得上，够 HUD 用；
 * 没有 contextWindow 时只报 used，不硬编模型窗口。
 */
function toContextUsage(usage, limit) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const used = num(usage.inputTokens) + num(usage.cacheReadTokens)
    + num(usage.cacheWriteTokens) + num(usage.outputTokens);
  if (!(used > 0)) return null;
  const out = { used, source: 'dsh' };
  if (Number.isFinite(limit) && limit > 0) {
    out.limit = limit;
    out.percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return out;
}

function isHeaderLine(obj) {
  return !!obj && obj.type === 'session' && typeof obj.id === 'string' && !!obj.id;
}

function isSupportedHeader(obj) {
  return isHeaderLine(obj) && obj.version === 0;
}

// Read the first complete zstd frame only. The persistence plugin deliberately
// stores the immutable SessionHeader in frame 1, so archive discovery does not
// need to decompress an entire (possibly multi-GB) conversation.
function firstLogLine(fp, size, zstd) {
  const cap = Math.min(size, zstd ? 1024 * 1024 : 64 * 1024);
  const head = readBytes(fp, 0, cap);
  if (!head || !head.length) return '';
  if (!zstd) return head.toString('utf8').split('\n')[0] || '';
  const scan = scanFrames(head);
  const frame = scan.frames[0];
  if (!frame) return '';
  try { return decodeFrame(head.subarray(frame.start, frame.end)).toString('utf8').split('\n')[0] || ''; }
  catch { return ''; }
}

/**
 * Cheap metadata probe used by the unified Session archive.
 * Unknown persistence versions fail closed instead of being guessed.
 */
function readSessionMetadata(fp) {
  let stat;
  try { stat = fs.statSync(fp); } catch { return null; }
  if (!stat.isFile() || !stat.size) return null;
  const zstd = String(fp).endsWith('.zstd');
  const header = parseLine(firstLogLine(fp, stat.size, zstd));
  if (!isSupportedHeader(header) || isSubagentHeader(header)) return null;

  // Titles normally arrive near session creation. Probe a bounded prefix only;
  // the file mtime remains the authoritative updated-at value.
  const probe = readBytes(fp, 0, Math.min(stat.size, 1024 * 1024));
  const text = probe ? (zstd ? decodeFrames(probe).text : probe.toString('utf8')) : '';
  let title = '';
  let promptFallback = '';
  let model = '';
  for (const line of text.split('\n')) {
    const obj = parseLine(line);
    if (!obj) continue;
    if (obj.type === 'session/title' && obj.data && typeof obj.data.title === 'string') {
      title = obj.data.title.trim() || title;
    } else if (!promptFallback && obj.type === 'user/message' && isHumanPrompt(obj.data)) {
      promptFallback = promptTitle(messageText(obj.data));
    } else if (obj.type === 'request/context' && obj.data && typeof obj.data.model === 'string') {
      model = obj.data.model;
    }
  }
  return {
    id: String(header.id), cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: Number(header.createdAt) || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs, size: stat.size, title: title || promptFallback || '',
    model, version: header.version,
  };
}

// Locate a valid frame boundary in a bounded tail window. This keeps handoff
// packets useful for very large histories: return recent dialogue, not the
// first 256 KB from months ago.
function recentZstdSnapshot(fp, size) {
  const windowSize = Math.min(size, MAX_FRAME_READ);
  const windowStart = size - windowSize;
  const buf = readBytes(fp, windowStart, windowSize);
  if (!buf || !buf.length) return { text: '', committed: 0 };
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== 0xFD2FB528) continue;
    const decoded = decodeFrames(buf.subarray(i));
    if (!decoded.error && decoded.consumed > 0 && decoded.text) {
      return { text: decoded.text, committed: windowStart + i + decoded.consumed };
    }
  }
  // Tail 窗口可能整个落在一个 >8MiB 帧的 payload 里，里面没有 frame magic。
  // 退回结构化文件扫描，至少拿到可靠 committed 边界；最后一帧不超过安全上限时
  // 也把它解出来，供启动 backfill 恢复最新状态。
  const scanned = scanFileFrames(fp, size);
  let text = '';
  if (!scanned.error && scanned.lastFrame) {
    const n = scanned.lastFrame.end - scanned.lastFrame.start;
    if (n <= MAX_FRAME_DECODE) {
      const frame = readBytes(fp, scanned.lastFrame.start, n);
      if (frame && frame.length === n) {
        try { text = decodeFrame(frame).toString('utf8'); } catch {}
      }
    }
  }
  return { text, committed: scanned.committed || 0 };
}

// Initial cursors also need a committed frame boundary. This covers dormant
// sessions that are too old to backfill today but may resume tomorrow: saving
// raw EOF while dsh is midway through a frame would poison that later resume.
function committedLogOffset(fp, size, zstd) {
  if (!zstd || size <= 0) return Math.max(0, size);
  if (size <= MAX_BACKFILL_BYTES) {
    const buf = readBytes(fp, 0, size);
    return buf ? decodeFrames(buf).consumed : 0;
  }
  return recentZstdSnapshot(fp, size).committed || 0;
}

// 整份日志的明文。压缩日志没法从中间切（帧边界只能从头数），只能整读；超大文件
// 只读头部认身份，尾部近况就不要了（宁可少一条标题，也不要卡住启动）。
function readLogText(fp, size, zstd) {
  if (size <= MAX_BACKFILL_BYTES) {
    const buf = readBytes(fp, 0, size);
    if (!buf) return '';
    return zstd ? decodeFrames(buf).text : buf.toString('utf8');
  }
  if (!zstd) {
    const head = readBytes(fp, 0, 64 * 1024);
    const tail = readBytes(fp, size - TAIL_PROBE_BYTES, TAIL_PROBE_BYTES);
    const headText = head ? head.toString('utf8').split('\n')[0] + '\n' : '';
    const tailLines = tail ? tail.toString('utf8').split('\n').slice(1).join('\n') : '';
    return headText + tailLines;
  }
  const head = readBytes(fp, 0, 256 * 1024);
  return head ? decodeFrames(head).text : '';
}

/**
 * 一份 dsh 会话日志里的事件行（会话交接要读对话正文时用）。
 * @param {string} fp session.jsonl[.zstd] 的路径
 * @returns {object[]} 解析出来的行；读不了就是空数组
 */
function readLogEntries(fp) {
  let size = 0;
  try { size = fs.statSync(fp).size; } catch { return []; }
  if (!size) return [];
  const out = [];
  const zstd = String(fp).endsWith('.zstd');
  const text = zstd && size > MAX_BACKFILL_BYTES
    ? recentZstdSnapshot(fp, size).text
    : readLogText(fp, size, zstd);
  for (const line of text.split('\n')) {
    const obj = parseLine(line);
    if (obj) out.push(obj);
  }
  return out;
}

// 子 agent 线程（subagent / fork）不是用户会话
function isSubagentHeader(header) {
  if (!header) return false;
  if (header.origin === 'subagent') return true;
  return Number.isFinite(header.delegationDepth) && header.delegationDepth > 0;
}

function createDshWatch(deps) {
  const core = deps.core;
  const sessionsDir = deps.sessionsDir || SESSIONS_DIR; // 测试可注入
  const pollMs = deps.pollMs || POLL_MS;

  /** @type {Map<string, object>} file path → tracker */
  const trackers = new Map();
  // 已见文件的增量游标：长寿会话静默超过 1h 会退场，回来时从这里续，
  // 而不是把整份日志当新会话重放（会炸出一串旧欢迎/庆祝/气泡）。
  const cursors = new Map();
  // 项目目录 mtime 缓存：dsh 的会话目录没有日期分区，全量扫描不能每轮做。
  // 新会话落地会顶掉父目录 mtime，靠它每轮只进「变过的项目目录」。
  const projectMtimes = new Map();
  let timer = null;
  let booted = false;
  let tickCount = 0;
  let missingLogged = false;

  function statEntry(fp) {
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return null;
      return { fp, size: st.size, mtimeMs: st.mtimeMs };
    } catch { return null; }
  }

  function listDirs(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { return []; }
  }

  // 一个会话目录里只可能有一份日志（root 的编码是全局一致的），两种后缀都试。
  function sessionLogIn(dir) {
    for (const name of LOG_NAMES) {
      const e = statEntry(path.join(dir, name));
      if (e) return e;
    }
    return null;
  }

  function scanProject(projectDir, out) {
    for (const sid of listDirs(projectDir)) {
      const e = sessionLogIn(path.join(projectDir, sid));
      if (e) out.push(e);
    }
  }

  // 热扫描：只进 mtime 变过的项目目录（新会话目录一落地就会顶掉父目录 mtime）。
  // 全量扫描：所有项目目录都进一遍，捞回「老会话被 resume」这种父目录没动的情况。
  function listSessionFiles(fullSweep) {
    const out = [];
    for (const name of listDirs(sessionsDir)) {
      const projectDir = path.join(sessionsDir, name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(projectDir).mtimeMs; } catch { continue; }
      const known = projectMtimes.get(projectDir);
      projectMtimes.set(projectDir, mtimeMs);
      if (!fullSweep && known === mtimeMs) continue;
      scanProject(projectDir, out);
    }
    return out;
  }

  function baseFields(t) {
    const f = { agentId: 'dsh', headless: false, transcriptPath: t.fp };
    if (t.cwd) f.cwd = t.cwd;
    if (t.model) f.model = t.model;
    return f;
  }

  function update(t, state, event, extra) {
    core.updateSession(t.sid, state, event, { ...baseFields(t), ...extra });
  }

  // 会话标题/模型这类纯展示字段不该进状态机（会污染 recentEvents 的徽标判定）。
  function meta(t, fields) {
    if (typeof core.setSessionMeta === 'function') core.setSessionMeta(t.sid, fields);
  }

  function beginTurn(t) {
    t.turnActive = true;
    t.didWorkThisTurn = false;
    t.lastTool = null;
  }

  function markWork(t) {
    t.turnActive = true;
    t.didWorkThisTurn = true;
  }

  // 本轮已经开过工具 → 后续推理仍属于「在执行」；首个工具之前才是纯思考。
  // （与 codex-watch 同一套判断，避免同一份状态语义在两个后端里漂移。）
  function activeTurnState(t) {
    return t.didWorkThisTurn ? 'working' : 'thinking';
  }

  // ── 逐行事件处理（仅 live 流量；backfill 不走这里） ─────────────────────────
  function handleLine(t, obj) {
    if (isHeaderLine(obj)) { applyHeader(t, obj, true); return; }
    if (t.ignored || !t.sid) return;
    const type = obj.type;
    if (typeof type !== 'string' || !type.includes('/')) return; // 打包行 / 未知行
    const data = obj.data || {};

    switch (type) {
      case 'turn/start':
        beginTurn(t);
        update(t, 'thinking', 'TaskStarted');
        break;

      case 'user/message': {
        if (!isHumanPrompt(data)) break;
        beginTurn(t);
        const text = messageText(data);
        const extra = {};
        if (!t.titleSet) {
          const title = promptTitle(text);
          if (title) { extra.sessionTitle = title; t.titleSet = true; }
        }
        const emo = detectEmotion(text, 'user');
        if (emo) extra.userEmotion = emo;
        update(t, 'thinking', 'UserPromptSubmit', extra);
        break;
      }

      case 'step/start':
        update(t, activeTurnState(t), 'Reasoning');
        break;

      case 'tool/call':
      case 'tool/code-dispatch-start':
        markWork(t);
        t.lastTool = mapTool(data.name);
        update(t, 'working', 'PreToolUse', { toolName: t.lastTool });
        break;

      case 'tool/result':
      case 'tool/code-dispatch': {
        markWork(t); // watcher 半途接手时，只看到结果也足以确认本轮已开工
        const failed = !!data.error || (data.message && data.message.isError === true)
          || data.isError === true;
        const toolName = data.name ? mapTool(data.name) : (t.lastTool || null);
        if (failed) update(t, 'error', 'PostToolUseFailure', { toolName });
        else update(t, 'working', 'PostToolUse', { toolName });
        break;
      }

      case 'assistant/message': {
        const text = messageText(data.message);
        if (text) t.lastAgentMessage = text;
        const cu = toContextUsage(data.usage, t.contextLimit);
        if (cu) core.setContextUsage(t.sid, cu);
        break;
      }

      case 'turn/end': {
        const kind = data.reason && typeof data.reason === 'object' ? data.reason.kind : null;
        t.turnActive = false;
        t.didWorkThisTurn = false;
        if (kind === 'error') {
          update(t, 'error', 'ApiError', { errorType: 'api_error' });
          break;
        }
        // Only an explicit completed outcome may celebrate. Developer-preview
        // Harness has emitted interrupted/max-tokens and may add more reasons;
        // treating an unknown value as success would surface a false completion.
        if (kind !== 'completed') { update(t, 'idle', 'TurnAborted'); break; }
        const text = clipAssistant(t.lastAgentMessage);
        const extra = {};
        if (text) {
          extra.assistantLastOutput = text;
          const emo = detectEmotion(text, 'assistant');
          if (emo) extra.assistantEmotion = emo;
        }
        t.lastAgentMessage = null;
        update(t, 'attention', 'Stop', extra);
        break;
      }

      // dsh 的授权问答发生在它自己的界面里（web/CLI），桌宠只镜像「有人在等你」。
      case 'approval/asked':
        t.pendingApprovals = (t.pendingApprovals || 0) + 1;
        update(t, 'notification', 'Notification');
        break;
      case 'approval/decided': {
        t.pendingApprovals = Math.max(0, (t.pendingApprovals || 0) - 1);
        if (t.pendingApprovals > 0) break; // 还有别的问题挂着，继续等
        const allowed = data.outcome === 'allowed-once';
        update(t, allowed ? activeTurnState(t) : 'idle', 'ApprovalDecided');
        break;
      }

      case 'compaction/start':
        update(t, 'sweeping', 'PreCompact');
        break;
      case 'compaction/end':
        update(t, activeTurnState(t), 'Reasoning');
        break;

      case 'llm/retry':
        // 一次请求失败后排队重试：和 Claude 路径的 API 错误同义，重试成功后
        // 下一条事件（step/start / assistant/message）会自然把状态带回来。
        update(t, 'error', 'ApiError', { errorType: 'api_error' });
        break;

      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title) { t.titleSet = true; meta(t, { sessionTitle: title }); }
        break;
      }

      case 'request/header': {
        const cfg = data.header && data.header.config;
        const model = cfg && typeof cfg.model === 'string' ? cfg.model : null;
        if (model && model !== t.model) { t.model = model; meta(t, { model }); }
        break;
      }
      case 'request/context': {
        if (Number.isFinite(data.contextWindow) && data.contextWindow > 0) t.contextLimit = data.contextWindow;
        if (typeof data.model === 'string' && data.model && data.model !== t.model) {
          t.model = data.model;
          meta(t, { model: data.model });
        }
        break;
      }

      default:
        break;
    }
  }

  function applyHeader(t, header, live) {
    if (!isSupportedHeader(header)) {
      t.ignored = true;
      t.broken = true;
      log('dsh', `unsupported session log version (${String(header && header.version)}) — ignoring ${path.basename(path.dirname(t.fp))}`);
      return;
    }
    t.sawHeader = true;
    t.sid = String(header.id);
    if (typeof header.cwd === 'string' && header.cwd) t.cwd = header.cwd;
    if (isSubagentHeader(header)) { t.ignored = true; return; }
    // 运行期间新出现的会话：SessionStart 进欢迎判定（真正的欢迎等首条 prompt）
    if (live) update(t, 'idle', 'SessionStart', { sessionSource: 'startup' });
  }

  // ── 读取：明文直接读，zstd 先切完整帧再解 ───────────────────────────────────
  // 返回本轮新解出的明文；null = 这轮没有可用的新内容（半帧 / 读不到）。
  function readNext(t, size) {
    const remaining = size - t.offset;
    if (remaining <= 0) return null;
    const cap = t.readCap || MAX_READ_PER_TICK;
    const buf = readBytes(t.fp, t.offset, Math.min(remaining, cap));
    if (!buf || !buf.length) return null;
    if (!t.zstd) { t.offset += buf.length; return buf.toString('utf8'); }

    const { text, consumed, error } = decodeFrames(buf);
    if (error && consumed === 0) {
      // 不是 zstd 帧边界了（换了压缩方式 / 文件被别的东西改写）：放弃这个文件，
      // 光标跟到文件末尾，避免每轮反复报错。
      t.broken = true;
      t.offset = size;
      log('dsh', `frame scan failed (${error}) — dropping ${path.basename(path.dirname(t.fp))}`);
      return null;
    }
    if (consumed === 0) {
      // 末尾半帧：正常情况下一轮补齐。但如果整个读取窗口都装不下一帧，
      // 就得放宽这个文件的读取上限，否则会永远卡在这里。
      if (buf.length >= cap && remaining > buf.length) {
        if (cap < MAX_FRAME_READ) {
          t.readCap = Math.min(cap * 4, MAX_FRAME_READ);
        } else {
          // 读取窗口已到 8MiB 仍没有完整帧：先从磁盘结构化找出这个帧的真实末尾。
          // 能安全整帧解码就处理；极端大帧则只跳过这一帧并继续后续事件，绝不能
          // 永久卡死在同一个 cursor。
          const span = scanOneFileFrame(t.fp, t.offset, size);
          if (span.error) {
            t.broken = true;
            t.offset = size;
            log('dsh', `frame scan failed (${span.error}) — dropping ${path.basename(path.dirname(t.fp))}`);
            return null;
          }
          if (span.torn) return null;
          const frameBytes = span.end - span.start;
          if (span.skippable || frameBytes > MAX_FRAME_DECODE) {
            t.offset = span.end;
            t.readCap = MAX_READ_PER_TICK;
            if (!span.skippable) {
              log('dsh', `oversized frame (${frameBytes} bytes) skipped in ${path.basename(path.dirname(t.fp))}; continuing`);
            }
            return '';
          }
          const frame = readBytes(t.fp, span.start, frameBytes);
          if (!frame || frame.length !== frameBytes) return null;
          try {
            t.offset = span.end;
            t.readCap = MAX_READ_PER_TICK;
            return decodeFrame(frame).toString('utf8');
          } catch (e) {
            // 边界有效但内容损坏：只丢这一帧，后续帧仍可继续消费。
            t.offset = span.end;
            t.readCap = MAX_READ_PER_TICK;
            log('dsh', `oversized frame decode failed (${e.message}) — skipped ${path.basename(path.dirname(t.fp))}`);
            return '';
          }
        }
      }
      return null;
    }
    t.readCap = MAX_READ_PER_TICK;
    t.offset += consumed;
    return text;
  }

  // ── 增量泵：读新增字节 → 攒整行 → handleLine ────────────────────────────────
  function pump(t, size) {
    if (t.broken) { t.offset = size; return; }
    if (size < t.offset) { t.offset = 0; t.carry = ''; } // 文件被回滚/重写
    const chunk = readNext(t, size);
    if (chunk === null) return;
    const lines = (t.carry + chunk).split('\n');
    t.carry = lines.pop() || ''; // 最后一段可能是半行，攒到下一轮
    for (const line of lines) {
      const obj = parseLine(line);
      if (!obj) continue;
      try { handleLine(t, obj); } catch (e) { log('dsh', 'handleLine error:', e.message); }
    }
    cursors.set(t.fp, { offset: t.offset, carry: t.carry });
  }

  // ── 启动 backfill：静默入库，不触发欢迎/庆祝 ───────────────────────────────
  function backfill(t, size, mtimeMs) {
    // A zstd file may end in a half-written frame. Start after the last COMPLETE
    // frame, never at raw EOF; otherwise the next tick starts in the middle of
    // that frame, marks the tracker broken, and loses the rest of the session.
    let text = '';
    if (t.zstd && size <= MAX_BACKFILL_BYTES) {
      const buf = readBytes(t.fp, 0, size);
      const decoded = buf ? decodeFrames(buf) : { text: '', consumed: 0 };
      text = decoded.text;
      t.offset = decoded.consumed;
    } else if (t.zstd) {
      const recent = recentZstdSnapshot(t.fp, size);
      text = readLogText(t.fp, size, t.zstd);
      if (recent.text) text += `\n${recent.text}`;
      t.offset = recent.committed || 0;
    } else {
      text = readLogText(t.fp, size, false);
      t.offset = size;
    }
    t.carry = '';
    cursors.set(t.fp, { offset: t.offset, carry: '' });
    let title = null;
    let promptFallback = null;
    let usage = null;
    let limit = null;
    let model = null;
    let pending = 0;
    let foldedState = 'idle';
    let turnActive = false;
    let didWork = false;
    for (const line of text.split('\n')) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (isHeaderLine(obj)) {
        if (!isSupportedHeader(obj)) {
          t.ignored = true;
          t.broken = true;
          log('dsh', `unsupported session log version (${String(obj.version)}) — ignoring ${path.basename(path.dirname(t.fp))}`);
          return;
        }
        t.sawHeader = true;
        t.sid = String(obj.id);
        if (typeof obj.cwd === 'string' && obj.cwd) t.cwd = obj.cwd;
        if (isSubagentHeader(obj)) { t.ignored = true; return; }
        continue;
      }
      switch (obj.type) {
        case 'turn/start': turnActive = true; didWork = false; foldedState = 'thinking'; break;
        case 'step/start': if (turnActive) foldedState = didWork ? 'working' : 'thinking'; break;
        case 'tool/call':
        case 'tool/code-dispatch-start':
          turnActive = true; didWork = true; foldedState = 'working'; break;
        case 'tool/result':
        case 'tool/code-dispatch':
          turnActive = true; didWork = true;
          foldedState = obj.data && (obj.data.error || obj.data.isError || (obj.data.message && obj.data.message.isError)) ? 'error' : 'working';
          break;
        case 'session/title':
          if (obj.data && typeof obj.data.title === 'string' && obj.data.title.trim()) {
            title = obj.data.title.trim();
          }
          break;
        case 'user/message':
          if (!promptFallback && isHumanPrompt(obj.data)) promptFallback = promptTitle(messageText(obj.data));
          break;
        case 'assistant/message':
          if (obj.data && obj.data.usage) usage = obj.data.usage;
          break;
        case 'request/context':
          if (obj.data && Number.isFinite(obj.data.contextWindow)) limit = obj.data.contextWindow;
          if (obj.data && typeof obj.data.model === 'string') model = obj.data.model;
          break;
        case 'request/header': {
          const cfg = obj.data && obj.data.header && obj.data.header.config;
          if (cfg && typeof cfg.model === 'string') model = cfg.model;
          break;
        }
        case 'approval/asked': pending++; foldedState = 'notification'; break;
        case 'approval/decided':
          pending = Math.max(0, pending - 1);
          if (!pending) foldedState = turnActive ? (didWork ? 'working' : 'thinking') : 'idle';
          break;
        case 'turn/end': {
          turnActive = false; didWork = false;
          const reason = obj.data && obj.data.reason;
          const kind = reason && typeof reason === 'object' ? reason.kind : null;
          foldedState = kind === 'error' ? 'error' : 'idle';
          break;
        }
        default: break;
      }
    }
    if (!t.sid) t.sid = decodeSegment(path.basename(path.dirname(t.fp)));
    if (t.ignored) return;
    if (Date.now() - mtimeMs > BACKFILL_MAX_AGE_MS) return; // 太久没动的不上列表

    if (limit) t.contextLimit = limit;
    if (model) t.model = model;
    t.titleSet = !!(title || promptFallback);
    t.pendingApprovals = pending;
    core.seedSession({
      id: t.sid,
      agentId: 'dsh',
      cwd: t.cwd || '',
      transcriptPath: t.fp,
      sessionTitle: title || promptFallback || null,
      contextUsage: toContextUsage(usage, limit),
      model: model || null,
      sourcePid: null,
      headless: false,
      state: pending > 0 ? 'notification' : foldedState,
      createdAt: mtimeMs,
      updatedAt: mtimeMs,
    });
  }

  // 老会话恢复（1h 后又开始写）：只补身份，不派 SessionStart，随后只泵增量。
  function hydrateHeader(t) {
    const head = readBytes(t.fp, 0, t.zstd ? 256 * 1024 : 64 * 1024);
    if (!head) return;
    const text = t.zstd ? decodeFrames(head).text : head.toString('utf8');
    const first = parseLine(text.split('\n')[0] || '');
    if (isHeaderLine(first) && !isSupportedHeader(first)) {
      t.ignored = true;
      t.broken = true;
      return;
    }
    if (isSupportedHeader(first)) {
      t.sawHeader = true;
      t.sid = String(first.id);
      if (typeof first.cwd === 'string' && first.cwd) t.cwd = first.cwd;
      if (isSubagentHeader(first)) t.ignored = true;
    }
    if (!t.sid) t.sid = decodeSegment(path.basename(path.dirname(t.fp)));
  }

  function newTracker(fp, cursor) {
    return {
      fp,
      zstd: fp.endsWith('.zstd'),
      sid: null,
      offset: cursor ? cursor.offset : 0,
      carry: cursor ? cursor.carry : '',
      readCap: MAX_READ_PER_TICK,
      ignored: false,
      broken: false,
      sawHeader: false,
      cwd: null,
      model: null,
      contextLimit: null,
      lastTool: null,
      lastAgentMessage: null,
      titleSet: false,
      turnActive: false,
      didWorkThisTurn: false,
      pendingApprovals: 0,
    };
  }

  function tick() {
    const now = Date.now();
    const fullSweep = !booted || (tickCount % FULL_SWEEP_TICKS === 0);
    tickCount++;
    let found;
    try {
      if (!fs.existsSync(sessionsDir)) {
        if (!missingLogged) { log('dsh', `no ${sessionsDir} — dsh not installed? watcher idle`); missingLogged = true; }
        return;
      }
      found = listSessionFiles(fullSweep);
    } catch (e) {
      log('dsh', 'scan failed:', e.message);
      return;
    }

    // ① 发现新文件 → 建 tracker（启动首轮静默 backfill，之后按新会话走事件流）
    for (const { fp, size, mtimeMs } of found) {
      if (trackers.has(fp)) continue;
      if (!booted) {
        // 首轮把所有历史日志的 EOF 记下来：某个旧会话之后重新活跃时从这里续，
        // 不会因为 mtime 变新就被当成全新会话整份重放。
        if (!cursors.has(fp)) cursors.set(fp, {
          offset: committedLogOffset(fp, size, fp.endsWith('.zstd')),
          carry: '',
        });
        if (now - mtimeMs > IDLE_UNTRACK_MS) continue;
        const t = newTracker(fp, null);
        trackers.set(fp, t);
        backfill(t, size, mtimeMs);
        continue;
      }
      if (now - mtimeMs > IDLE_UNTRACK_MS) continue; // 陈年文件不建 tracker
      const prior = cursors.get(fp);
      const t = newTracker(fp, prior);
      trackers.set(fp, t);
      if (prior) {
        hydrateHeader(t);
        if (t.offset > size) { t.offset = size; t.carry = ''; }
        log('dsh', `resume session log: ${path.basename(path.dirname(fp))} @ ${t.offset}`);
      } else {
        log('dsh', `new session log: ${path.basename(path.dirname(fp))}`);
      }
    }

    // ② 泵所有已跟踪文件——直接 stat，不依赖本轮扫描列表（热扫描只看变过的项目目录，
    // 但已跟踪会话每一轮都要跟进增量）。
    for (const [fp, t] of trackers) {
      const e = statEntry(fp);
      if (!e) { trackers.delete(fp); continue; }
      if (now - e.mtimeMs > IDLE_UNTRACK_MS) {
        cursors.set(fp, { offset: t.offset, carry: t.carry });
        trackers.delete(fp);
        continue;
      }
      if (t.ignored && t.sawHeader) { // subagent：光标跟上即可
        t.offset = e.size;
        t.carry = '';
        cursors.set(fp, { offset: t.offset, carry: '' });
        continue;
      }
      pump(t, e.size);
    }
    booted = true;
  }

  function start() {
    if (timer) return;
    try { tick(); } catch (e) { log('dsh', 'initial tick failed:', e.message); }
    timer = setInterval(() => { try { tick(); } catch (e) { log('dsh', 'tick failed:', e.message); } }, pollMs);
    if (timer.unref) timer.unref();
    log('dsh', `watching ${sessionsDir} (poll ${pollMs}ms)`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, tick, _trackers: trackers, _cursors: cursors };
}

module.exports = {
  createDshWatch,
  mapTool,
  messageText,
  isHumanPrompt,
  toContextUsage,
  decodeSegment,
  readLogEntries,
  readSessionMetadata,
  isSupportedHeader,
  SESSIONS_DIR,
};
