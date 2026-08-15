'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 主进程 -> 渲染进程
  onEvent: (cb) => ipcRenderer.on('pet:event', (_e, data) => cb(data)),
  onStats: (cb) => ipcRenderer.on('pet:stats', (_e, data) => cb(data)),
  onMeme: (cb) => ipcRenderer.on('pet:meme', (_e, data) => cb(data)),
  onTravel: (cb) => ipcRenderer.on('pet:travel', (_e, data) => cb(data)),
  onMemeCatalogChanged: (cb) => ipcRenderer.on('pet:meme-catalog-changed', (_e, data) => cb(data)),
  onPanelStats: (cb) => ipcRenderer.on('panel:stats', (_e, data) => cb(data)),
  onConfig: (cb) => {
    ipcRenderer.on('pet:config', (_e, data) => cb(data));
    ipcRenderer.on('panel:config', (_e, data) => cb(data));
    ipcRenderer.on('archive:config', (_e, data) => cb(data));
  },
  onPrice: (cb) => ipcRenderer.on('panel:price', (_e, data) => cb(data)),
  onArchiveChanged: (cb) => ipcRenderer.on('archive:changed', (_e, data) => cb(data)),
  onWorkbenchStats: (cb) => ipcRenderer.on('workbench:stats', (_e, data) => cb(data)),
  onWorkbenchPrice: (cb) => ipcRenderer.on('workbench:price', (_e, data) => cb(data)),
  onProgramsChanged: (cb) => ipcRenderer.on('programs:changed', (_e, data) => cb(data)),
  onProgramSkillsChanged: (cb) => ipcRenderer.on('program-skills:changed', (_e, data) => cb(data)),
  // 渲染进程 -> 主进程
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
  openSessionArchive: () => ipcRenderer.send('open-session-archive'),
  closeSessionArchive: () => ipcRenderer.send('close-session-archive'),
  getSessionArchive: (query) => ipcRenderer.invoke('session-archive-list', query),
  setSessionArchiveSettings: (settings) => ipcRenderer.invoke('session-archive-settings', settings),
  backupSessionsNow: () => ipcRenderer.invoke('session-archive-backup-now'),
  resumeArchivedSession: (key, targetAgent) => ipcRenderer.invoke('session-archive-resume', key, targetAgent),
  restoreArchivedSession: (key) => ipcRenderer.invoke('session-archive-restore', key),
  revealArchivedSession: (key) => ipcRenderer.invoke('session-archive-reveal', key),
  openSessionBackupFolder: () => ipcRenderer.send('session-archive-open-backup'),
  getGeneratedPrograms: () => ipcRenderer.invoke('generated-programs-list'),
  launchGeneratedProgram: (id) => ipcRenderer.invoke('generated-program-launch', id),
  revealGeneratedProgram: (id) => ipcRenderer.invoke('generated-program-reveal', id),
  removeGeneratedProgram: (id) => ipcRenderer.invoke('generated-program-remove', id),
  getProgramSkills: () => ipcRenderer.invoke('program-skills-status'),
  installProgramSkill: (provider) => ipcRenderer.invoke('program-skill-install', provider),
  removeProgramSkill: (provider) => ipcRenderer.invoke('program-skill-remove', provider),
  setMode: (m) => ipcRenderer.send('set-mode', m),
  setSkin: (s) => ipcRenderer.send('set-skin', s),
  toggleMute: () => ipcRenderer.send('toggle-mute'),
  setSessionPrefs: (pinned, archived) => ipcRenderer.send('set-session-prefs', pinned, archived),
  territoryRunNow: () => ipcRenderer.send('territory-run-now'),
  lootCodexPet: () => ipcRenderer.send('loot-codex-pet'),
  territoryToggleAuto: () => ipcRenderer.send('territory-toggle-auto'),
  quit: () => ipcRenderer.send('quit-app'),
  // 双宠模式：只收起自己这只宠（独立事件，另一只和 app 不受影响）
  closePet: () => ipcRenderer.send('close-pet'),
  // 手动拖动窗口
  getWinPos: () => ipcRenderer.invoke('get-win-pos'),
  getWindowMetrics: () => ipcRenderer.invoke('get-window-metrics'),
  setWinPos: (x, y) => ipcRenderer.send('set-win-pos', x, y),
  // 唤起 Claude / Codex / dsh 客户端（dsh 起的是本地 web 界面）
  launchClaude: () => ipcRenderer.send('launch-claude'),
  launchCodex: () => ipcRenderer.send('launch-codex'),
  launchDsh: () => ipcRenderer.send('launch-dsh'),
  // 原生授权：通过本地 HTTP server 回 CC 决策（allow/deny），不需按键/Accessibility
  decidePermission: (permId, behavior) => ipcRenderer.send('permission-decide', permId, behavior),
  // 对话类（继续/选择/方案）：不再替你打字，改为定位并唤起该会话所在的窗口/终端
  focusSession: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  // 面板会话行点 id 芯片 → 复制完整 session id，方便贴给另一个 agent 去 resume
  copySessionId: (sessionId) => ipcRenderer.invoke('copy-session-id', sessionId),
  // 会话接管：同代理走官方 resume/fork，跨代理由主进程生成脱敏交接包后新开 CLI。
  takeOverSession: (sessionId, targetAgent) => ipcRenderer.invoke('session-takeover', sessionId, targetAgent),
  getMemeCatalog: () => ipcRenderer.invoke('meme-catalog'),
  triggerMeme: (sessionId, memeId) => ipcRenderer.invoke('meme-trigger', sessionId, memeId),
  getTravel: () => ipcRenderer.invoke('travel-get'),
  getTravelPostcards: () => ipcRenderer.invoke('travel-postcards'),
  startTravel: (sessionId, templateId, mission) => ipcRenderer.invoke('travel-start', sessionId, templateId, mission),
  wanderTravel: () => ipcRenderer.invoke('travel-wander'),
  cancelTravel: () => ipcRenderer.invoke('travel-cancel'),
  // 左键主操作（非待处理情形）：由后端决定聚焦会话 / 开面板 / 新开 CLI
  primaryAction: () => ipcRenderer.send('primary-action'),
  // 透明空白处点击穿透：渲染端命中测试后切换（true=穿透，鼠标事件仍转发回来）
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // 选项面板需要更高窗口
  setPetTall: (tall) => ipcRenderer.send('pet-tall', tall),
  // 记事本行动中心需要一大块区域
  setPetBig: (on) => ipcRenderer.send('pet-big', on),
  // 按弹层内容精确定高（动态，避免固定大窗口留白）；w/h<=0 复位
  setPetSize: (w, h, anchor) => ipcRenderer.send('set-pet-size', w, h, anchor),
  // 详情面板按内容高度自适应，避免底部留白 / 内容多时被切
  setPanelHeight: (h) => ipcRenderer.send('set-panel-height', h),
  // 在桌宠输入框打字时，让窗口拿到键盘焦点(隐藏 Dock 的 accessory app 默认拿不到)；用完归还
  focusPet: () => ipcRenderer.send('pet-focus'),
  blurPet: () => ipcRenderer.send('pet-blur'),
  // 打开日志文件
  openLog: () => ipcRenderer.send('open-log'),
  // 渲染端把关键 UI 决策写进日志(便于自检验证，不靠截图)
  petLog: (tag, msg) => ipcRenderer.send('pet-log', tag, msg),
  // 上报「用户正在交互」(选项面板/右键菜单/记事本)——领地模式据此避战/撤退
  uiBusy: (on) => ipcRenderer.send('ui-busy', on),
  petVisualBounds: (rect) => ipcRenderer.send('pet-visual-bounds', rect),
});
