'use strict';

// Codex rollout watcher — 只读监听 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，
// 把 Codex CLI / Codex Desktop 的会话状态翻译成 core 的事件流（agentId: 'codex'）。
//
// 为什么走「读文件」而不是钩子：Codex 只有一个全局 notify 配置位，这台机器上
// 已被 ChatGPT 桌面 App 占用（SkyComputerUseClient turn-ended），覆盖它会弄坏
// 用户的桌面集成。rollout JSONL 是 Codex 的权威事件源（事件粒度到 tool call +
// token_count），增量 tail 零侵入、零配置，卸载桌宠也不留任何痕迹。
//
// 事件映射（rollout → core 状态机，词汇表完全复用 Claude 路径）：
//   session_meta            → SessionStart(idle)   仅运行期间新建的文件
//   user_message            → UserPromptSubmit(thinking) + 情绪嗅探
//   task_started            → TaskStarted(thinking) 清完成徽标/开启本轮
//   function_call / custom_tool_call / web_search_call → PreToolUse(working=工具在跑)
//   *_output / patch_apply_end / mcp_tool_call_end     → PostToolUse(working=任务仍在执行)
//   reasoning / agent_reasoning → 首个工具前 thinking；首个工具后保持 working
//   task_complete            → Stop(attention) + assistant_last_output → 庆祝+气泡
//   turn_aborted             → TurnAborted(idle) → 「中断」徽标
//   context_compacted        → PreCompact(sweeping)
//   request_user_input function_call → Notification + 问题/选项 → 镜像 Codex 选择卡
//   *_approval_request / elicitation_request → Notification → 「等你回复」
//   token_count              → setContextUsage(上下文%) + 原始 rate_limits 兼容解析
//
// 过滤：thread_source === 'subagent'（guardian / auto-review 等内部线程）整个
// 文件跳过——它们不是用户会话，会把会话列表刷成审计日志。
//
// 大文件安全：rollout 可达十几 MB。启动 backfill 只探头部(session_meta 必在第
// 一行)和尾部若干 KB 静默入库（不回放历史、不触发欢迎/庆祝）；此后每轮 poll 只
// 读新增字节（单轮上限 512KB，读不完下一轮继续）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');
const { detectEmotion } = require('./emotion');
const { promptTitle } = require('./transcript');
const { createCodexSessionIndex, DEFAULT_PATH: DEFAULT_SESSION_INDEX_PATH } = require('./codex-session-index');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const POLL_MS = 2500;
const BACKFILL_MAX_AGE_MS = 30 * 60 * 1000; // 与 core 的 backfill 窗口对齐
const IDLE_UNTRACK_MS = 60 * 60 * 1000;     // 文件超过 1h 没动 → 不再跟踪（再动会重新发现）
const MAX_READ_PER_TICK = 512 * 1024;       // 单文件单轮读取上限
const HOT_DAYS = 3;                         // 每轮都扫的近几天日期目录（新会话都落这里）
const FULL_SWEEP_TICKS = 12;                // 每 ~30s 全量扫一次所有日期目录（见 sweepAllRecent）
const FIRST_LINE_MAX = 1024 * 1024;         // session_meta 行封顶（实测带 base_instructions 可达 35KB+）
const TAIL_PROBE_BYTES = 128 * 1024;
const ASSISTANT_MAX = 2400;                 // 与 server.js 的 ASSISTANT_LAST_OUTPUT_MAX 一致

// Codex 工具名 → 既有词汇（adapter 的图标/中文标签按这个词查）
const TOOL_MAP = {
  exec_command: 'Bash', exec: 'Bash', write_stdin: 'Bash',
  apply_patch: 'Edit',
  js: 'Js', wait: 'Wait',
  update_plan: 'TodoWrite',
  view_image: 'Read',
  web_search: 'WebSearch',
};
const mapTool = (name) => TOOL_MAP[name] || String(name || 'Tool');

function fileSessionId(fp, metaId) {
  if (metaId) return String(metaId);
  // rollout-2026-07-11T04-50-16-<uuid>.jsonl → uuid 兜底
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fp);
  return m ? m[1] : path.basename(fp, '.jsonl');
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

function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// 读第一行（session_meta）。带超长 base_instructions 的 meta 行实测可达 35KB+，
// 固定小探针会把它截断导致解析失败（cwd/subagent 判定全丢）——分块读到第一个
// 换行为止，FIRST_LINE_MAX 封顶。
function readFirstLine(fp) {
  const chunkSize = 64 * 1024;
  let buf = Buffer.alloc(0);
  let pos = 0;
  while (pos < FIRST_LINE_MAX) {
    const chunk = readBytes(fp, pos, chunkSize);
    if (!chunk || !chunk.length) break;
    const nl = chunk.indexOf(0x0a);
    if (nl !== -1) return Buffer.concat([buf, chunk.slice(0, nl)]).toString('utf8');
    buf = Buffer.concat([buf, chunk]);
    pos += chunk.length;
    if (chunk.length < chunkSize) break; // EOF 且没有换行
  }
  return buf.length ? buf.toString('utf8') : null;
}

function clipAssistant(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  return t.length > ASSISTANT_MAX ? t.slice(0, ASSISTANT_MAX) : t;
}

// Codex 把 request_user_input 记成 response_item/function_call，arguments 是
// JSON 字符串（而不是 event_msg/request_user_input）。只取 UI 必需的结构，
// 避免把整个工具 payload 塞进快照。LLMPET 对 Codex rollout 仍是只读：
// 选项会镜像展示，回答仍由 Codex 客户端/CLI 完成。
function parseRequestUserInput(raw) {
  let args = raw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return []; }
  }
  if (!args || typeof args !== 'object' || !Array.isArray(args.questions)) return [];
  return args.questions.slice(0, 3).map((q, index) => {
    if (!q || typeof q !== 'object') return null;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) return null;
    const options = Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => {
      if (!o || typeof o !== 'object' || typeof o.label !== 'string' || !o.label.trim()) return null;
      return {
        label: o.label.trim(),
        description: typeof o.description === 'string' ? o.description.trim() : '',
      };
    }).filter(Boolean) : [];
    return {
      header: typeof q.header === 'string' ? q.header.trim() : '',
      id: typeof q.id === 'string' && q.id ? q.id : `question_${index + 1}`,
      question,
      options,
      multiSelect: q.multiSelect === true || q.multi_select === true,
    };
  }).filter(Boolean);
}

// token_count → core 的 contextUsage 形状。last_token_usage.total_tokens ≈ 当前
// 上下文里的 token 数（含缓存读），对着 model_context_window 算百分比。
function toContextUsage(info) {
  if (!info || typeof info !== 'object') return null;
  const last = info.last_token_usage || {};
  const used = Number(last.total_tokens);
  const limit = Number(info.model_context_window);
  if (!Number.isFinite(used) || used <= 0) return null;
  const out = { used, source: 'codex' };
  if (Number.isFinite(limit) && limit > 0) {
    out.limit = limit;
    out.percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return out;
}

// rate_limits → 兼容旧 rollout 的极简形状。LLMPET 不再把它展示为固定
// 5 小时限制；保留解析仅供协议兼容和独立诊断。
function toRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const p = rl.primary || {};
  const s = rl.secondary || {};
  const out = { ts: Date.now() };
  if (Number.isFinite(p.used_percent)) {
    out.usedPercent = p.used_percent;
    out.windowMinutes = Number(p.window_minutes) || null;
    out.resetsAt = Number(p.resets_at) ? Number(p.resets_at) * 1000 : null;
  }
  if (Number.isFinite(s.used_percent)) {
    out.secondaryUsedPercent = s.used_percent;
    out.secondaryWindowMinutes = Number(s.window_minutes) || null;
  }
  if (typeof rl.plan_type === 'string') out.planType = rl.plan_type;
  return out.usedPercent != null || out.secondaryUsedPercent != null ? out : null;
}

function createCodexWatch(deps) {
  const core = deps.core;
  const onRateLimits = typeof deps.onRateLimits === 'function' ? deps.onRateLimits : () => {};
  const sessionsDir = deps.sessionsDir || SESSIONS_DIR; // 测试可注入
  const pollMs = deps.pollMs || POLL_MS;
  const sessionIndex = createCodexSessionIndex(
    deps.sessionIndexPath || (deps.sessionsDir
      ? path.join(path.dirname(sessionsDir), 'session_index.jsonl')
      : DEFAULT_SESSION_INDEX_PATH),
  );

  /** @type {Map<string, object>} file path → tracker */
  const trackers = new Map();
  // 已见文件的增量游标。长寿会话可能静默 1h 后重新写入；只删 tracker 而不保留
  // offset，会把整份 rollout 当成新会话从头重放，触发旧欢迎/完成/气泡风暴。
  // 启动首轮也会记录所有历史文件的 EOF，使旧会话再次活跃时只吃新增内容。
  const cursors = new Map();
  let timer = null;
  let booted = false;      // 首轮扫描 = backfill；之后的新文件才是「新会话」
  let tickCount = 0;       // 全量扫描节拍（FULL_SWEEP_TICKS 轮一次）
  let missingLogged = false;
  let rateLimits = null;

  // 热扫描：最近 HOT_DAYS 天的日期目录（新会话都创建在「今天」的目录里）
  function dayDirs() {
    const dirs = [];
    for (let back = 0; back < HOT_DAYS; back++) {
      const d = new Date(Date.now() - back * 86400000);
      dirs.push(path.join(
        sessionsDir,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ));
    }
    return dirs;
  }

  function statEntry(fp) {
    try {
      const st = fs.statSync(fp);
      return { fp, size: st.size, mtimeMs: st.mtimeMs };
    } catch { return null; }
  }

  function listRolloutFiles() {
    const out = [];
    for (const dir of dayDirs()) {
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const e = statEntry(path.join(dir, n));
        if (e) out.push(e);
      }
    }
    return out;
  }

  // 全量扫描：递归所有 年/月/日 目录。正常 watcher 只收 1h 内仍在写的
  // 文件；“掠夺”会显式请求最近历史会话，因此也复用这里但不设时间上限。
  // rollout 永远留在「会话开始日」的目录里——ChatGPT Desktop 一个对话连聊几天，
  // 文件还在 5 天前的目录里被追加（实测踩坑）。只扫今天/昨天永远看不见它，
  // 所以启动第一轮 + 之后每 FULL_SWEEP_TICKS 轮做一次全量兜底。
  function sweepAllRecent(onFile, maxAgeMs = IDLE_UNTRACK_MS) {
    const out = [];
    const now = Date.now();
    let years;
    try { years = fs.readdirSync(sessionsDir); } catch { return out; }
    for (const y of years) {
      if (!/^\d{4}$/.test(y)) continue;
      let months;
      try { months = fs.readdirSync(path.join(sessionsDir, y)); } catch { continue; }
      for (const m of months) {
        if (!/^\d{2}$/.test(m)) continue;
        let days;
        try { days = fs.readdirSync(path.join(sessionsDir, y, m)); } catch { continue; }
        for (const d of days) {
          if (!/^\d{2}$/.test(d)) continue;
          let names;
          try { names = fs.readdirSync(path.join(sessionsDir, y, m, d)); } catch { continue; }
          for (const n of names) {
            if (!n.endsWith('.jsonl')) continue;
            const e = statEntry(path.join(sessionsDir, y, m, d, n));
            if (!e) continue;
            if (onFile) onFile(e);
            if (now - e.mtimeMs <= maxAgeMs) out.push(e);
          }
        }
      }
    }
    return out;
  }

  function baseFields(t) {
    const f = {
      agentId: 'codex',
      headless: false,
      transcriptPath: t.fp,
    };
    if (t.cwd) f.cwd = t.cwd;
    if (t.model) f.model = t.model;
    if (t.originator) f.originator = t.originator;
    if (t.sessionTitle) f.sessionTitle = t.sessionTitle;
    return f;
  }

  function update(t, state, event, extra) {
    core.updateSession(t.sid, state, event, { ...baseFields(t), ...extra });
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

  function activeTurnState(t) {
    return t.didWorkThisTurn ? 'working' : 'thinking';
  }

  // ── 逐行事件处理（仅 live 流量；backfill 不走这里） ─────────────────────────
  function handleLine(t, obj) {
    const type = obj.type;
    const p = obj.payload || {};

    if (type === 'session_meta') {
      const alreadyKnown = t.sawMeta;
      applyMeta(t, p);
      if (t.ignored) return;
      // 新版 Codex 会在同一个长寿 rollout 的后续回合再次写 session_meta。
      // 它只是元数据刷新，不能把已经 task_started 的回合重置成 idle。
      if (!alreadyKnown) {
        // 运行期间新出现的会话：SessionStart 进欢迎判定（真正的欢迎等首条 prompt）
        update(t, 'idle', 'SessionStart', { sessionSource: 'startup' });
      }
      return;
    }
    if (t.ignored) return;

    if (type === 'turn_context') {
      if (typeof p.cwd === 'string' && p.cwd) t.cwd = p.cwd;
      if (typeof p.model === 'string' && p.model) t.model = p.model;
      return;
    }

    if (type === 'compacted') { update(t, 'sweeping', 'PreCompact'); return; }

    // rollout 是「事项完成才落盘」：function_call 落盘 = 工具正在跑。工具结果
    // 落盘并不表示整轮任务停止执行，后续 reasoning 也属于这次 Working 生命周期。
    // 因此本轮首个工具前可显示 thinking；一旦发生工具活动就锁定 working，直到
    // task_complete / turn_aborted。不能拿“最后一行是不是 reasoning”猜整轮状态。
    if (type === 'response_item') {
      const pt = p.type;
      if (pt === 'function_call' || pt === 'custom_tool_call') {
        // request_user_input 是 Codex 内建交互工具，不是一个“正在执行”
        // 的普通工具。先于通用 function_call 分支截获，否则它只会
        // 被记成 PreToolUse，问题与选项全部丢失。
        if (p.name === 'request_user_input') {
          const questions = parseRequestUserInput(p.arguments);
          update(t, 'notification', 'Notification', {
            codexChoice: {
              id: String(p.call_id || p.id || `codex-choice-${Date.now()}`),
              questions,
            },
          });
          return;
        }
        markWork(t);
        t.lastTool = mapTool(p.name);
        update(t, 'working', 'PreToolUse', { toolName: t.lastTool });
      } else if (pt === 'web_search_call') {
        markWork(t);
        t.lastTool = 'WebSearch';
        update(t, 'working', 'PreToolUse', { toolName: 'WebSearch' });
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        markWork(t); // watcher 若在工具执行中恢复，只有 output 也足以确认本轮已开工
        update(t, 'working', 'PostToolUse', { toolName: t.lastTool || null });
      } else if (pt === 'reasoning') {
        update(t, activeTurnState(t), 'Reasoning');
      }
      return;
    }

    if (type !== 'event_msg') return;
    const et = p.type;

    switch (et) {
      case 'user_message': {
        beginTurn(t);
        const msg = typeof p.message === 'string' ? p.message : '';
        const extra = {};
        if (!t.titleSet) {
          const title = promptTitle(msg);
          if (title) { extra.sessionTitle = title; t.titleSet = true; }
        }
        const emo = detectEmotion(msg, 'user');
        if (emo) extra.userEmotion = emo;
        update(t, 'thinking', 'UserPromptSubmit', extra);
        break;
      }
      case 'task_started':
        beginTurn(t);
        update(t, 'thinking', 'TaskStarted');
        break;
      case 'agent_message':
        // 兜底记住最后一条正文（task_complete 通常自带 last_agent_message）
        if (typeof p.message === 'string' && p.message) t.lastAgentMessage = p.message;
        break;
      case 'task_complete': {
        const text = clipAssistant(
          typeof p.last_agent_message === 'string' && p.last_agent_message
            ? p.last_agent_message
            : t.lastAgentMessage,
        );
        const extra = {};
        if (text) {
          extra.assistantLastOutput = text;
          const emo = detectEmotion(text, 'assistant');
          if (emo) extra.assistantEmotion = emo;
        }
        t.lastAgentMessage = null;
        update(t, 'attention', 'Stop', extra);
        t.turnActive = false;
        t.didWorkThisTurn = false;
        break;
      }
      case 'turn_aborted':
        update(t, 'idle', 'TurnAborted');
        t.turnActive = false;
        t.didWorkThisTurn = false;
        break;
      case 'context_compacted':
        update(t, 'sweeping', 'PreCompact');
        break;
      // *_end 仍处于同一个正在执行的任务；它们也可能是 watcher 恢复后看到的
      // 第一条工具事件，因此必须补记 didWorkThisTurn。
      case 'patch_apply_end':
        if (p.success === false) update(t, 'error', 'PostToolUseFailure', { toolName: 'Edit' });
        else {
          markWork(t);
          update(t, 'working', 'PostToolUse', { toolName: 'Edit' });
        }
        break;
      case 'mcp_tool_call_end':
        markWork(t);
        update(t, 'working', 'PostToolUse', {
          toolName: (p.invocation && p.invocation.tool) ? String(p.invocation.tool) : 'Tool',
        });
        break;
      case 'web_search_end':
        markWork(t);
        update(t, 'working', 'PostToolUse', { toolName: 'WebSearch' });
        break;
      // agent_reasoning：首个工具前是思考；工具链开始后仍属于执行阶段。
      case 'agent_reasoning':
        update(t, activeTurnState(t), 'Reasoning');
        break;
      case 'token_count': {
        const cu = toContextUsage(p.info);
        if (cu) core.setContextUsage(t.sid, cu);
        const rl = toRateLimits(p.rate_limits);
        if (rl) { rateLimits = rl; onRateLimits(rl); }
        break;
      }
      case 'error':
      case 'stream_error':
        update(t, 'error', 'ApiError', { errorType: 'api_error' });
        break;
      default:
        // 授权/追问类事件（TUI 的 on-request 审批等；名字随版本演进，按后缀匹配）
        if (/approval_request$/.test(et) || et === 'request_user_input' || et === 'elicitation_request') {
          const questions = et === 'request_user_input' || et === 'elicitation_request'
            ? parseRequestUserInput(p.arguments || p)
            : [];
          update(t, 'notification', 'Notification', questions.length ? {
            codexChoice: {
              id: String(p.call_id || p.id || p.request_id || `codex-choice-${Date.now()}`),
              questions,
            },
          } : undefined);
        }
        break;
    }
  }

  function applyMeta(t, meta) {
    t.sawMeta = true;
    t.sid = fileSessionId(t.fp, meta.id || meta.session_id);
    if (typeof meta.cwd === 'string' && meta.cwd) t.cwd = meta.cwd;
    if (typeof meta.originator === 'string') t.originator = meta.originator;
    // guardian / auto-review 等内部子线程：整个文件不是用户会话
    const src = meta.source;
    if (meta.thread_source === 'subagent' || (src && typeof src === 'object' && src.subagent)) {
      t.ignored = true;
    }
    const officialTitle = sessionIndex.get(t.sid);
    if (officialTitle) {
      t.sessionTitle = officialTitle;
      t.titleSet = true;
    }
  }

  function hydrateMeta(t) {
    const headLine = readFirstLine(t.fp);
    if (headLine) {
      const first = parseLine(headLine);
      if (first && first.type === 'session_meta') applyMeta(t, first.payload || {});
    }
    if (!t.sid) t.sid = fileSessionId(t.fp, null);
  }

  // ── 启动 backfill：头部读 meta、尾部读近况，静默入库 ─────────────────────────
  function backfill(t, size, mtimeMs) {
    hydrateMeta(t);
    t.offset = size; // 历史不回放，此后只吃新增
    cursors.set(t.fp, { offset: size, carry: '' });
    if (t.ignored) return;
    if (Date.now() - mtimeMs > BACKFILL_MAX_AGE_MS) return; // 太久没动的不上列表

    let title = t.sessionTitle || null;
    let contextUsage = null;
    const pendingChoices = new Map();
    const start = Math.max(0, size - TAIL_PROBE_BYTES);
    const tail = readBytes(t.fp, start, size - start);
    if (tail) {
      const lines = tail.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // 掐头（可能是半行）
      for (const line of lines) {
        const obj = parseLine(line);
        if (!obj) continue;
        const p = obj.payload || {};
        if (obj.type === 'response_item') {
          if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'request_user_input') {
            const questions = parseRequestUserInput(p.arguments);
            if (questions.length) pendingChoices.set(String(p.call_id || p.id || ''), { id: String(p.call_id || p.id || ''), questions });
          } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
            pendingChoices.delete(String(p.call_id));
          }
          continue;
        }
        if (obj.type !== 'event_msg') continue;
        if (p.type === 'user_message' && !title) title = promptTitle(String(p.message || ''));
        if (p.type === 'token_count') {
          const cu = toContextUsage(p.info);
          if (cu) contextUsage = cu;
          const rl = toRateLimits(p.rate_limits);
          if (rl && (!rateLimits || rl.ts >= rateLimits.ts)) { rateLimits = rl; onRateLimits(rl); }
        }
      }
    }
    const pendingChoice = [...pendingChoices.values()].pop() || null;
    core.seedSession({
      id: t.sid,
      agentId: 'codex',
      cwd: t.cwd || '',
      transcriptPath: t.fp,
      sessionTitle: title,
      contextUsage,
      originator: t.originator || null,
      sourcePid: null,
      headless: false,
      state: pendingChoice ? 'notification' : 'idle',
      codexChoice: pendingChoice,
      createdAt: mtimeMs,
      updatedAt: mtimeMs,
    });
    t.titleSet = !!title;
    t.sessionTitle = title;
  }

  // “掠夺”要拿的是用户最近的 Codex 会话，而不是仅限 30 分钟内仍活跃的
  // watcher 集合。按 mtime 倒序扫描历史 rollout，只读 meta + 128KB 尾部，
  // 过滤 guardian/subagent 后静默补进 core；不回放历史事件。
  function seedRecent(limit = 3) {
    const wanted = Math.max(0, Math.min(20, Number(limit) || 0));
    if (!wanted) return [];
    const files = sweepAllRecent(null, Number.POSITIVE_INFINITY)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const ids = [];
    for (const file of files) {
      const t = newTracker(file.fp, null);
      hydrateMeta(t);
      if (t.ignored || !t.sid) continue;

      let title = t.sessionTitle || null;
      let contextUsage = null;
      const start = Math.max(0, file.size - TAIL_PROBE_BYTES);
      const tail = readBytes(file.fp, start, file.size - start);
      if (tail) {
        const lines = tail.toString('utf8').split('\n');
        if (start > 0) lines.shift();
        for (const line of lines) {
          const obj = parseLine(line);
          if (!obj || obj.type !== 'event_msg') continue;
          const p = obj.payload || {};
          if (p.type === 'user_message') title = promptTitle(String(p.message || '')) || title;
          if (p.type === 'token_count') contextUsage = toContextUsage(p.info) || contextUsage;
        }
      }
      core.seedSession({
        id: t.sid,
        agentId: 'codex',
        cwd: t.cwd || '',
        transcriptPath: t.fp,
        sessionTitle: title,
        contextUsage,
        originator: t.originator || null,
        sourcePid: null,
        headless: false,
        state: 'idle',
        createdAt: file.mtimeMs,
        updatedAt: file.mtimeMs,
      });
      ids.push(t.sid);
      if (ids.length >= wanted) break;
    }
    return ids;
  }

  // ── 增量泵：读新增字节 → 攒整行 → handleLine ────────────────────────────────
  function pump(t, size) {
    if (size < t.offset) { t.offset = 0; t.carry = ''; } // 文件被截断/重写
    if (size <= t.offset) return;
    const len = Math.min(size - t.offset, MAX_READ_PER_TICK);
    const chunk = readBytes(t.fp, t.offset, len);
    if (!chunk) return;
    t.offset += chunk.length;
    const text = t.carry + chunk.toString('utf8');
    const lines = text.split('\n');
    t.carry = lines.pop() || ''; // 最后一段可能是半行，攒到下一轮
    for (const line of lines) {
      const obj = parseLine(line);
      if (!obj) continue;
      try { handleLine(t, obj); } catch (e) { log('codex', 'handleLine error:', e.message); }
    }
    cursors.set(t.fp, { offset: t.offset, carry: t.carry });
  }

  function newTracker(fp, cursor) {
    return {
      fp, sid: null, offset: cursor ? cursor.offset : 0, carry: cursor ? cursor.carry : '',
      ignored: false, sawMeta: false, cwd: null, model: null, lastTool: null,
      lastAgentMessage: null, sessionTitle: null, titleSet: false,
      turnActive: false, didWorkThisTurn: false,
    };
  }

  function refreshOfficialTitles() {
    if (!sessionIndex.refresh()) return;
    if (!core || typeof core.setSessionMeta !== 'function') return;
    for (const t of trackers.values()) {
      if (!t.sid || t.ignored) continue;
      const title = sessionIndex.get(t.sid);
      if (!title || title === t.sessionTitle) continue;
      t.sessionTitle = title;
      t.titleSet = true;
      core.setSessionMeta(t.sid, { sessionTitle: title });
    }
  }

  function tick() {
    let found;
    const now = Date.now();
    const fullSweep = !booted || (tickCount % FULL_SWEEP_TICKS === 0);
    tickCount++;
    refreshOfficialTitles();
    try {
      if (!fs.existsSync(sessionsDir)) {
        if (!missingLogged) { log('codex', `no ${sessionsDir} — Codex not installed? watcher idle`); missingLogged = true; }
        return;
      }
      found = listRolloutFiles();
      if (fullSweep) {
        const seen = new Set(found.map((f) => f.fp));
        // 首轮把所有历史 rollout 的 EOF 记下来。之后某个旧文件重新活跃时，
        // 可以从这个游标继续，而不是因为 mtime 变新就误当作全新文件重放。
        const rememberAtBoot = !booted
          ? (f) => { if (!cursors.has(f.fp)) cursors.set(f.fp, { offset: f.size, carry: '' }); }
          : null;
        for (const f of sweepAllRecent(rememberAtBoot)) if (!seen.has(f.fp)) found.push(f);
      }
    } catch (e) {
      log('codex', 'scan failed:', e.message);
      return;
    }
    // ① 发现新文件 → 建 tracker（启动第一轮走静默 backfill，之后按新会话走事件流）
    for (const { fp, size, mtimeMs } of found) {
      if (trackers.has(fp)) continue;
      if (now - mtimeMs > IDLE_UNTRACK_MS) continue; // 陈年文件不建 tracker
      const prior = booted ? cursors.get(fp) : null;
      const t = newTracker(fp, prior);
      trackers.set(fp, t);
      if (!booted) {
        backfill(t, size, mtimeMs);
      } else if (prior) {
        // 旧/暂停会话恢复：meta 只用于恢复身份，不派发 SessionStart；随后只泵增量。
        hydrateMeta(t);
        if (t.offset > size) { t.offset = size; t.carry = ''; }
        log('codex', `resume rollout: ${path.basename(fp)} @ ${t.offset}`);
      } else {
        log('codex', `new rollout: ${path.basename(fp)}`);
      }
    }
    // ② 泵所有已跟踪文件——直接 stat，不依赖本轮扫描列表：旧日期目录里的
    // 长寿会话只在全量扫描轮被「发现」，但每一轮都要跟进它的新增内容。
    for (const [fp, t] of trackers) {
      const e = statEntry(fp);
      if (!e) { trackers.delete(fp); continue; }              // 文件没了
      if (now - e.mtimeMs > IDLE_UNTRACK_MS) {
        cursors.set(fp, { offset: t.offset, carry: t.carry });
        trackers.delete(fp);
        continue;
      } // 凉了，退场但保留游标
      if (t.ignored && t.sawMeta) {
        t.offset = e.size;
        t.carry = '';
        cursors.set(fp, { offset: t.offset, carry: '' });
        continue;
      } // subagent：光标跟上即可
      pump(t, e.size);
    }
    booted = true;
  }

  function start() {
    if (timer) return;
    try { tick(); } catch (e) { log('codex', 'initial tick failed:', e.message); }
    timer = setInterval(() => { try { tick(); } catch (e) { log('codex', 'tick failed:', e.message); } }, pollMs);
    if (timer.unref) timer.unref();
    log('codex', `watching ${sessionsDir} (poll ${pollMs}ms)`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start, stop, tick, seedRecent, getRateLimits: () => rateLimits,
    _trackers: trackers, _cursors: cursors, _sessionIndex: sessionIndex,
  };
}

module.exports = { createCodexWatch, toContextUsage, toRateLimits, mapTool, parseRequestUserInput };
