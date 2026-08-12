'use strict';

const $ = (id) => document.getElementById(id);
const COPY = {
  zh: {
    title: '会话档案馆', subtitle: 'Claude Code 与 Codex 的全部本机会话', total: '全部会话', source: '来源', backup: '本机备份',
    backupTitle: '定期备份', backupNote: '默认关闭 · 只存本机 · 不上传云端', backupNever: '尚未备份', backupNow: '立即备份', folder: '打开目录', close: '关闭', backupInterval: '备份周期',
    search: '搜索标题、项目、路径或 Session ID', all: '全部', allSources: '全来源', desktop: '客户端', cli: 'CLI', saved: '已备份', active: '活跃',
    scanning: '正在扫描…', results: '{n} 条会话', emptyTitle: '选择一条会话', emptyCopy: '查看来源、项目、备份状态，并继续或交给另一个 Agent 接管。',
    indexNote: '索引只保存元数据；会话正文仍由 Claude/Codex 管理。', noResults: '没有符合条件的会话', available: '源会话可用', missing: '源会话已不在原位置',
    project: '项目', origin: '来源', updated: '最后更新', size: '文件大小', sessionId: 'Session ID', path: '原始路径',
    continueClaude: '由 Claude 继续', continueCodex: '由 Codex 继续', restore: '恢复原会话', reveal: '在 Finder 中显示',
    handoffNote: '同代理会使用官方 resume；跨代理会生成本地交接单。源会话正在工作时不会被停止。',
    localWarning: '开启后会立即进行首次本机备份，预计需要 {size} 空间。它不能防止整块硬盘损坏，也不是云同步。是否继续？',
    backupRunning: '正在备份 {done}/{total}…', backupDone: '备份完成：新增/更新 {copied}，未变化 {skipped}，失败 {failed}', backupFailed: '备份失败，请查看日志。',
    opening: '正在打开会话…', restoring: '正在恢复原会话…', restored: '原会话已恢复，可以继续打开。', restoreFailed: '恢复失败；现有文件不会被覆盖。', openFailed: '无法打开：源会话可能已被删除或 CLI 未登录。', every6: '每 6 小时', every12: '每 12 小时', every24: '每天', every72: '每 3 天', every168: '每周',
  },
  en: {
    title: 'Session archive', subtitle: 'Every local Claude Code and Codex session', total: 'All sessions', source: 'Sources', backup: 'Local backup',
    backupTitle: 'Scheduled backup', backupNote: 'Off by default · local only · no cloud upload', backupNever: 'Never backed up', backupNow: 'Back up now', folder: 'Open folder', close: 'Close', backupInterval: 'Backup interval',
    search: 'Search title, project, path, or Session ID', all: 'All', allSources: 'All sources', desktop: 'Desktop', cli: 'CLI', saved: 'Backed up', active: 'Active',
    scanning: 'Scanning…', results: '{n} sessions', emptyTitle: 'Select a session', emptyCopy: 'Inspect its source and backup, then resume it or hand it to another agent.',
    indexNote: 'The index stores metadata only. Claude and Codex still own the transcript.', noResults: 'No matching sessions', available: 'Source available', missing: 'Source is no longer in its original location',
    project: 'Project', origin: 'Source', updated: 'Last updated', size: 'File size', sessionId: 'Session ID', path: 'Original path',
    continueClaude: 'Continue with Claude', continueCodex: 'Continue with Codex', restore: 'Restore source session', reveal: 'Reveal in Finder',
    handoffNote: 'Same-provider sessions use official resume. Cross-provider takeover creates a local handoff packet. Live source work is not stopped.',
    localWarning: 'Enabling this starts the first local backup immediately and may use about {size}. This is not cloud sync and cannot protect against a lost disk. Continue?',
    backupRunning: 'Backing up {done}/{total}…', backupDone: 'Backup complete: {copied} copied, {skipped} unchanged, {failed} failed', backupFailed: 'Backup failed. Check the log.',
    opening: 'Opening session…', restoring: 'Restoring the source session…', restored: 'The source session was restored and can be opened again.', restoreFailed: 'Restore failed. Existing files were not overwritten.', openFailed: 'Could not open it. The source may be gone or the CLI may be signed out.', every6: 'Every 6 hours', every12: 'Every 12 hours', every24: 'Daily', every72: 'Every 3 days', every168: 'Weekly',
  },
  ja: {
    title: 'セッション保管庫', subtitle: 'Claude Code と Codex のすべてのローカルセッション', total: '全セッション', source: '起動元', backup: 'ローカルバックアップ',
    backupTitle: '定期バックアップ', backupNote: '初期設定はオフ · ローカルのみ · クラウド送信なし', backupNever: '未バックアップ', backupNow: '今すぐ保存', folder: 'フォルダを開く', close: '閉じる', backupInterval: '保存間隔',
    search: 'タイトル・プロジェクト・パス・Session ID を検索', all: 'すべて', allSources: 'すべての起動元', desktop: 'デスクトップ', cli: 'CLI', saved: '保存済み', active: 'アクティブ',
    scanning: 'スキャン中…', results: '{n} 件', emptyTitle: 'セッションを選択', emptyCopy: '起動元と保存状態を確認し、再開または別の Agent に引き継げます。',
    indexNote: '索引に保存するのはメタデータのみです。本文は Claude/Codex が管理します。', noResults: '該当するセッションはありません', available: '元セッションあり', missing: '元の場所にセッションがありません',
    project: 'プロジェクト', origin: '起動元', updated: '最終更新', size: 'ファイルサイズ', sessionId: 'Session ID', path: '元のパス',
    continueClaude: 'Claude で続ける', continueCodex: 'Codex で続ける', restore: '元セッションを復元', reveal: 'Finder で表示',
    handoffNote: '同じプロバイダーは公式 resume、別プロバイダーはローカル引継ぎ資料を使います。実行中の元セッションは停止しません。',
    localWarning: '有効にすると最初のローカルバックアップをすぐ開始し、約 {size} 使用する可能性があります。クラウド同期ではなく、ディスク消失には対応できません。続けますか？',
    backupRunning: '{done}/{total} を保存中…', backupDone: '保存完了：更新 {copied}、変更なし {skipped}、失敗 {failed}', backupFailed: 'バックアップに失敗しました。ログを確認してください。',
    opening: 'セッションを開いています…', restoring: '元セッションを復元しています…', restored: '元セッションを復元しました。再び開けます。', restoreFailed: '復元に失敗しました。既存ファイルは上書きしていません。', openFailed: '開けませんでした。元データがないか、CLI のログインが切れている可能性があります。', every6: '6 時間ごと', every12: '12 時間ごと', every24: '毎日', every72: '3 日ごと', every168: '毎週',
  },
};

let lang = 'zh';
let config = { sessionArchive: { backupEnabled: false, backupIntervalHours: 24 } };
let data = { sessions: [], total: 0, summary: null };
let loadedOnce = false;
let selectedKey = '';
let provider = 'all';
let origin = 'all';
let backup = 'all';
let search = '';
let searchTimer = null;

const copy = () => COPY[lang] || COPY.zh;
const template = (value, vars = {}) => String(value || '').replace(/\{(\w+)\}/g, (_, key) => vars[key] == null ? '' : String(vars[key]));
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const PROVIDER_ICONS = Object.freeze({
  claude: '../assets/agents/claude.webp',
  codex: '../assets/agents/codex.webp',
});
const providerIcon = (value) => `<img src="${PROVIDER_ICONS[value === 'codex' ? 'codex' : 'claude']}" alt="" draggable="false">`;

function fmtBytes(value) {
  const n = Number(value) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtDate(value) {
  if (!value) return '—';
  const locale = lang === 'ja' ? 'ja-JP' : lang === 'en' ? 'en-US' : 'zh-CN';
  return new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function providerLabel(value) { return value === 'codex' ? 'Codex' : 'Claude'; }
function originLabel(value) { return value === 'desktop' ? copy().desktop : value === 'cli' ? 'CLI' : '—'; }

function applyCopy() {
  const c = copy();
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = `LLMPET · ${c.title}`;
  $('page-title').textContent = c.title; $('page-subtitle').textContent = c.subtitle;
  $('close').setAttribute('aria-label', c.close);
  $('backup-toggle').parentElement.title = c.backupTitle;
  $('backup-interval').setAttribute('aria-label', c.backupInterval);
  $('summary-total-label').textContent = c.total; $('summary-source-label').textContent = c.source; $('summary-backup-label').textContent = c.backup;
  $('backup-title').textContent = c.backupTitle; $('backup-note').textContent = c.backupNote;
  $('backup-now').textContent = c.backupNow; $('backup-folder').textContent = c.folder; $('search').placeholder = c.search;
  $('empty-title').textContent = c.emptyTitle; $('empty-copy').textContent = c.emptyCopy; $('status').textContent = c.indexNote;
  const providerButtons = $('provider-filters').querySelectorAll('button');
  providerButtons[0].textContent = c.all;
  const originButtons = $('origin-filters').querySelectorAll('button');
  originButtons[0].textContent = c.allSources; originButtons[1].textContent = c.desktop; originButtons[2].textContent = c.cli; originButtons[3].textContent = c.saved;
  const interval = $('backup-interval');
  interval.options[0].textContent = c.every6; interval.options[1].textContent = c.every12; interval.options[2].textContent = c.every24; interval.options[3].textContent = c.every72; interval.options[4].textContent = c.every168;
}

async function load() {
  $('result-count').textContent = copy().scanning;
  try {
    data = await window.pet.getSessionArchive({ search, provider, origin, backup, pageSize: 500 });
    loadedOnce = true;
    render();
  } catch (error) {
    setStatus(error && error.message ? error.message : copy().backupFailed, 'error');
  }
}

function render() {
  renderSummary();
  renderList();
  renderDetail();
}

function renderSummary() {
  if (!loadedOnce) {
    $('summary-total').textContent = '—';
    $('summary-split').textContent = 'Claude — · Codex —';
    $('summary-source').textContent = '—';
    $('summary-source-split').textContent = `${copy().desktop} — · CLI —`;
    $('summary-backup').textContent = '—';
    $('summary-backup-time').textContent = copy().backupNever;
    $('result-count').textContent = copy().scanning;
    $('scan-time').textContent = '';
    $('storage-size').textContent = '';
    renderBackupSettings();
    return;
  }
  const s = data.summary || {};
  $('summary-total').textContent = s.total == null ? '—' : s.total;
  $('summary-split').textContent = `Claude ${s.claude || 0} · Codex ${s.codex || 0}`;
  $('summary-source').textContent = `${(s.desktop || 0) + (s.cli || 0)}`;
  $('summary-source-split').textContent = `${copy().desktop} ${s.desktop || 0} · CLI ${s.cli || 0}`;
  $('summary-backup').textContent = `${s.backedUp || 0}/${s.total || 0}`;
  $('summary-backup-time').textContent = s.lastBackupAt ? fmtDate(s.lastBackupAt) : copy().backupNever;
  $('result-count').textContent = template(copy().results, { n: data.total || 0 });
  $('scan-time').textContent = s.lastScanAt ? fmtDate(s.lastScanAt) : '';
  $('storage-size').textContent = s.bytes ? fmtBytes(s.bytes) : '';
  renderBackupSettings();
}

function renderBackupSettings() {
  const settings = config.sessionArchive || {};
  $('backup-toggle').checked = settings.backupEnabled === true;
  $('backup-interval').value = String(settings.backupIntervalHours || 24);
  $('backup-interval').disabled = settings.backupEnabled !== true;
}

function rowBadges(session) {
  const badges = [`<span class="badge ${session.origin}">${escapeHtml(originLabel(session.origin))}</span>`];
  if (session.active) badges.unshift(`<span class="badge saved">${escapeHtml(copy().active)}</span>`);
  if (session.backupAvailable) badges.push(`<span class="badge saved">${escapeHtml(copy().saved)}</span>`);
  if (!session.sourceAvailable) badges.push(`<span class="badge missing">${escapeHtml(copy().missing)}</span>`);
  return badges.join('');
}

function renderList() {
  const list = $('session-list');
  if (!data.sessions || !data.sessions.length) {
    list.innerHTML = `<div class="list-empty">${escapeHtml(copy().noResults)}</div>`;
    return;
  }
  if (!selectedKey || !data.sessions.some((session) => session.key === selectedKey)) selectedKey = data.sessions[0].key;
  list.innerHTML = data.sessions.map((session) => `
    <div class="session-row ${session.key === selectedKey ? 'active' : ''}" data-key="${escapeHtml(session.key)}">
      <div class="provider-icon ${session.provider === 'codex' ? 'codex' : 'claude'}" title="${escapeHtml(providerLabel(session.provider))}">${providerIcon(session.provider)}</div>
      <div class="session-copy">
        <strong>${escapeHtml(session.title || session.project || session.id)}</strong>
        <small>${escapeHtml(session.project || session.cwd || session.id)} · ${escapeHtml(fmtDate(session.updatedAt))}</small>
      </div>
      <div class="session-badges">${rowBadges(session)}</div>
    </div>`).join('');
  list.querySelectorAll('.session-row').forEach((row) => row.addEventListener('click', () => {
    selectedKey = row.dataset.key;
    renderList();
    renderDetail();
  }));
}

function renderDetail() {
  const session = data.sessions && data.sessions.find((item) => item.key === selectedKey);
  const detail = $('detail');
  if (!session) {
    detail.className = 'detail empty-detail';
    detail.innerHTML = `<div class="empty-illustration">⌁</div><h2>${escapeHtml(copy().emptyTitle)}</h2><p>${escapeHtml(copy().emptyCopy)}</p>`;
    return;
  }
  const c = copy();
  detail.className = 'detail';
  detail.innerHTML = `
    <div class="detail-heading">
      <div><div class="detail-provider">${escapeHtml(providerLabel(session.provider))} · ${escapeHtml(originLabel(session.origin))}</div>
      <h2>${escapeHtml(session.title || session.project || session.id)}</h2><div class="detail-project">${escapeHtml(session.project || '—')}</div></div>
      <span class="availability ${session.sourceAvailable ? '' : 'missing'}">${escapeHtml(session.sourceAvailable ? c.available : c.missing)}</span>
    </div>
    <div class="meta-grid">
      <div class="meta-item"><span>${escapeHtml(c.project)}</span><strong>${escapeHtml(session.project || '—')}</strong></div>
      <div class="meta-item"><span>${escapeHtml(c.origin)}</span><strong>${escapeHtml(`${providerLabel(session.provider)} · ${originLabel(session.origin)}`)}</strong></div>
      <div class="meta-item"><span>${escapeHtml(c.updated)}</span><strong>${escapeHtml(fmtDate(session.updatedAt))}</strong></div>
      <div class="meta-item"><span>${escapeHtml(c.size)}</span><strong>${escapeHtml(fmtBytes(session.size))}</strong></div>
      <div class="meta-item"><span>${escapeHtml(c.sessionId)}</span><strong>${escapeHtml(session.id)}</strong></div>
      <div class="meta-item"><span>${escapeHtml(c.backup)}</span><strong>${escapeHtml(session.backupAvailable ? fmtDate(session.backedUpAt) : c.backupNever)}</strong></div>
    </div>
    <div class="path-card"><span>${escapeHtml(c.path)}</span><code>${escapeHtml(session.sourcePath || '—')}</code></div>
    <div class="detail-actions">
      <button class="action-button primary" data-target="claude" ${session.sourceAvailable ? '' : 'disabled'}>${escapeHtml(c.continueClaude)}</button>
      <button class="action-button secondary" data-target="codex" ${session.sourceAvailable ? '' : 'disabled'}>${escapeHtml(c.continueCodex)}</button>
      ${!session.sourceAvailable && session.backupAvailable ? `<button class="action-button primary" id="restore-session">${escapeHtml(c.restore)}</button>` : ''}
      <button class="action-button" id="reveal-session" ${(session.sourceAvailable || session.backupAvailable) ? '' : 'disabled'}>${escapeHtml(c.reveal)}</button>
    </div>
    <div class="detail-note">${escapeHtml(c.handoffNote)}</div>`;
  detail.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => openSession(session, button.dataset.target)));
  const reveal = $('reveal-session');
  if (reveal) reveal.addEventListener('click', () => window.pet.revealArchivedSession(session.key));
  const restore = $('restore-session');
  if (restore) restore.addEventListener('click', () => restoreSession(session));
}

async function openSession(session, target) {
  setStatus(copy().opening, 'busy');
  const result = await window.pet.resumeArchivedSession(session.key, target);
  if (!result || !result.ok) setStatus(copy().openFailed, 'error');
  else setStatus(copy().indexNote, '');
}

async function restoreSession(session) {
  setStatus(copy().restoring, 'busy');
  const result = await window.pet.restoreArchivedSession(session.key);
  if (!result || !result.ok) setStatus(copy().restoreFailed, 'error');
  else { setStatus(copy().restored, ''); await load(); }
}

function setStatus(message, cls = '') {
  $('status').textContent = message;
  $('status').className = cls;
}

document.getElementById('close').addEventListener('click', () => window.pet.closeSessionArchive());
document.getElementById('backup-folder').addEventListener('click', () => window.pet.openSessionBackupFolder());
document.getElementById('backup-now').addEventListener('click', async () => {
  if (!data.summary || !data.summary.backedUp) {
    const estimate = fmtBytes(data.summary && data.summary.bytes);
    if (!window.confirm(template(copy().localWarning, { size: estimate }))) return;
  }
  $('backup-now').disabled = true;
  setStatus(template(copy().backupRunning, { done: 0, total: (data.summary && data.summary.available) || 0 }), 'busy');
  const result = await window.pet.backupSessionsNow();
  $('backup-now').disabled = false;
  if (!result || !result.ok) setStatus(copy().backupFailed, 'error');
  await load();
});
document.getElementById('backup-toggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  if (enabled) {
    const estimate = fmtBytes(data.summary && data.summary.bytes);
    if (!window.confirm(template(copy().localWarning, { size: estimate }))) { event.target.checked = false; return; }
  }
  config.sessionArchive = await window.pet.setSessionArchiveSettings({ backupEnabled: enabled });
  renderSummary();
});
document.getElementById('backup-interval').addEventListener('change', async (event) => {
  config.sessionArchive = await window.pet.setSessionArchiveSettings({ backupIntervalHours: Number(event.target.value) });
  renderSummary();
});
document.getElementById('search').addEventListener('input', (event) => {
  search = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 180);
});
document.querySelectorAll('[data-provider]').forEach((button) => button.addEventListener('click', () => {
  provider = button.dataset.provider;
  document.querySelectorAll('[data-provider]').forEach((item) => item.classList.toggle('active', item === button));
  load();
}));
document.querySelectorAll('[data-origin]').forEach((button) => button.addEventListener('click', () => {
  const value = button.dataset.origin;
  origin = value === 'desktop' || value === 'cli' ? value : 'all';
  backup = value === 'backed-up' ? 'backed-up' : 'all';
  document.querySelectorAll('[data-origin]').forEach((item) => item.classList.toggle('active', item === button));
  load();
}));

window.pet.onConfig((next) => {
  config = { ...config, ...(next || {}) };
  lang = ['zh', 'en', 'ja'].includes(config.lang) ? config.lang : 'zh';
  applyCopy();
  if (loadedOnce) render();
  else renderSummary();
});
window.pet.onArchiveChanged((event) => {
  if (!event) return;
  if (event.type === 'backup-progress') {
    setStatus(template(copy().backupRunning, { done: event.completed, total: event.total }), 'busy');
  } else if (event.type === 'backup-complete') {
    setStatus(template(copy().backupDone, event), event.failed ? 'error' : '');
    load();
  } else if (event.type === 'scan-complete') {
    load();
  }
});

applyCopy();
renderSummary();
window.pet.getConfig().then((next) => {
  config = { ...config, ...(next || {}) };
  lang = ['zh', 'en', 'ja'].includes(config.lang) ? config.lang : 'zh';
  applyCopy();
  load();
});
