const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teleprompter', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  getApiKey: () => ipcRenderer.invoke('settings:hasApiKey'),
  hasApiKey: (provider) => ipcRenderer.invoke('settings:hasApiKey', provider),
  saveApiKeyForProvider: (provider, value) => ipcRenderer.invoke('settings:saveApiKeyForProvider', provider, value),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  clearApiKey: (provider) => ipcRenderer.invoke('settings:clearApiKey', provider),
  testConnection: (provider, model) => ipcRenderer.invoke('settings:testConnection', provider, model),
  getDefaultModel: (provider) => ipcRenderer.invoke('settings:getDefaultModel', provider),
  regenerateSystemPrompt: () => ipcRenderer.invoke('settings:regenerateSystemPrompt'),

  addContextFile: (filePath, label) =>
    ipcRenderer.invoke('context:addFile', { filePath, label }),
  getContextFiles: () => ipcRenderer.invoke('context:getFiles'),
  clearContext: () => ipcRenderer.invoke('context:clear'),
  clearQuestionsHistory: () => ipcRenderer.invoke('context:clearHistory'),

  pickContextFile: () => ipcRenderer.invoke('dialog:pickContextFile'),

  onContextUpdated: (callback) => {
    ipcRenderer.on('context:updated', () => callback());
  },

  startListening: () => ipcRenderer.invoke('listener:start'),
  stopListening: () => ipcRenderer.invoke('listener:stop'),
  toggleListening: () => ipcRenderer.invoke('listener:toggle'),
  getListenerStatus: () => ipcRenderer.invoke('listener:status'),
  answerFromScreenshot: () => ipcRenderer.invoke('screenshot:answer'),

  hideWindow: () => ipcRenderer.invoke('window:hide'),
  showWindow: () => ipcRenderer.invoke('window:show'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  onAssist: (callback) => {
    ipcRenderer.on('assist:newSuggestion', (_event, payload) => {
      callback(payload);
    });
  },

  onAssistStream: (callback) => {
    ipcRenderer.on('assist:streamChunk', (_event, chunk) => {
      callback(chunk);
    });
  },

  // Audio devices
  getInputDevices: () => ipcRenderer.invoke('audio:getInputDevices'),
  getAutoDeviceName: () => ipcRenderer.invoke('audio:getAutoDeviceName'),
  openSystemSoundSettings: () => ipcRenderer.invoke('audio:openSystemSoundSettings'),

  onAudioLevel: (callback) => {
    ipcRenderer.on('audio:level', (_event, level) => callback(level));
  },

  getReadableAnswer: (questionZh, contextFromConcise, options) =>
    ipcRenderer.invoke('assist:getReadableAnswer', questionZh, contextFromConcise, options),
  persistExpandedFromCard: (payload) => ipcRenderer.invoke('assist:persistExpandedFromCard', payload),

  exportInterviewSession: () => ipcRenderer.invoke('interview:exportSessionPdf'),
  prepareInterviewSessionExport: () => ipcRenderer.invoke('interview:prepareSessionExportPdf'),
  finalizeInterviewSessionExport: (tempPdfPath) =>
    ipcRenderer.invoke('interview:finalizeSessionExportPdf', tempPdfPath),

  // 组会/项目介绍模式
  analyzeMeetingDocuments: () => ipcRenderer.invoke('meeting:analyzeDocuments'),
  clearMeetingDocuments: () => ipcRenderer.invoke('meeting:clearDocuments'),

  // 翻译总结模式
  translateStart: () => ipcRenderer.invoke('translate:start'),
  translateStop: () => ipcRenderer.invoke('translate:stop'),
  translateSummarize: () => ipcRenderer.invoke('translate:summarize'),
  onTranslateChunk: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('translate:chunk', handler);
    return () => ipcRenderer.removeListener('translate:chunk', handler);
  },

  // ── Mac 音频引导（仅 darwin 平台有效，Windows 调用会静默失败） ──────────
  macCheckBlackHole: () => ipcRenderer.invoke('mac:checkBlackHole'),
  macCheckMultiOutput: () => ipcRenderer.invoke('mac:checkMultiOutput'),
  macSetupDone: () => ipcRenderer.invoke('mac:setupDone'),
  macMarkSetupDone: () => ipcRenderer.invoke('mac:markSetupDone'),
  macOpenAudioMidiSetup: () => ipcRenderer.invoke('mac:openAudioMidiSetup'),
  macOpenSoundPreferences: () => ipcRenderer.invoke('mac:openSoundPreferences'),
  macOpenExternalUrl: (url) => ipcRenderer.invoke('mac:openExternalUrl', url),
  getPlatform: () => process.platform,  // 直接读取，无需 IPC，跨平台安全
});

