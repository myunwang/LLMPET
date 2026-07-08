'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 主进程 -> 渲染进程
  onEvent: (cb) => ipcRenderer.on('pet:event', (_e, data) => cb(data)),
  onStats: (cb) => ipcRenderer.on('pet:stats', (_e, data) => cb(data)),
  onPanelStats: (cb) => ipcRenderer.on('panel:stats', (_e, data) => cb(data)),
  onConfig: (cb) => {
    ipcRenderer.on('pet:config', (_e, data) => cb(data));
    ipcRenderer.on('panel:config', (_e, data) => cb(data));
  },
  onPrice: (cb) => ipcRenderer.on('panel:price', (_e, data) => cb(data)),
  // 渲染进程 -> 主进程
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
  setMode: (m) => ipcRenderer.send('set-mode', m),
  setSkin: (s) => ipcRenderer.send('set-skin', s),
  setBudget: (v) => ipcRenderer.send('set-budget', v),
  toggleMute: () => ipcRenderer.send('toggle-mute'),
  quit: () => ipcRenderer.send('quit-app'),
  // 手动拖动窗口
  getWinPos: () => ipcRenderer.invoke('get-win-pos'),
  setWinPos: (x, y) => ipcRenderer.send('set-win-pos', x, y),
  // 唤起 Claude 客户端
  launchClaude: () => ipcRenderer.send('launch-claude'),
  // 原生授权：通过本地 HTTP server 回 CC 决策（allow/deny），不需按键/Accessibility
  decidePermission: (permId, behavior) => ipcRenderer.send('permission-decide', permId, behavior),
  // 对话类（继续/选择/方案）：不再替你打字，改为定位并唤起该会话所在的窗口/终端
  focusSession: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  // 左键主操作（非待处理情形）：由后端决定聚焦会话 / 开面板 / 新开 CLI
  primaryAction: () => ipcRenderer.send('primary-action'),
  // 透明空白处点击穿透：渲染端命中测试后切换（true=穿透，鼠标事件仍转发回来）
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // 选项面板需要更高窗口
  setPetTall: (tall) => ipcRenderer.send('pet-tall', tall),
  // 记事本行动中心需要一大块区域
  setPetBig: (on) => ipcRenderer.send('pet-big', on),
  // 按弹层内容精确定高（动态，避免固定大窗口留白）；w/h<=0 复位
  setPetSize: (w, h) => ipcRenderer.send('set-pet-size', w, h),
  // 详情面板按内容高度自适应，避免底部留白 / 内容多时被切
  setPanelHeight: (h) => ipcRenderer.send('set-panel-height', h),
  // 在桌宠输入框打字时，让窗口拿到键盘焦点(隐藏 Dock 的 accessory app 默认拿不到)；用完归还
  focusPet: () => ipcRenderer.send('pet-focus'),
  blurPet: () => ipcRenderer.send('pet-blur'),
  // 打开日志文件
  openLog: () => ipcRenderer.send('open-log'),
  // 渲染端把关键 UI 决策写进日志(便于自检验证，不靠截图)
  petLog: (tag, msg) => ipcRenderer.send('pet-log', tag, msg),
});
