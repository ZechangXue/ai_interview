import { app, BrowserWindow, ipcMain, nativeTheme, screen, dialog, Tray, Menu, globalShortcut, nativeImage, desktopCapturer } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import portAudio from 'naudiodon';
import { AudioListener } from './audioCapture';
import { RealtimeTranscriber } from './realtimeTranscriber';
import { RealtimeAllInOne } from './realtimeAllInOne';
import { transcribeSegment } from './asrService';
import {
  generateAssist,
  generateAssistStream,
  generateCustomSystemPrompt,
  READABLE_SYSTEM_PROMPT,
  buildReadableSystemPrompt,
  buildSystemContent,
  generateAssistOllama,
  generateAssistGemini,
  testConnectionOpenAICompatible,
  testConnectionOllama,
  testConnectionGemini,
  buildConciseSystemPrompt,
  generateReadableAnswerWithContent,
  generateMeetingAssistStream,
  generateAssistFromImage,
  generateAssistGeminiFromImage
} from './llmClient';
import { generateReadableAnswerViaRealtime } from './realtimeReadableAnswer';
import {
  getOpenAICompatibleBaseUrl,
  isOpenAICompatible,
  getRealtimeModelOrNull,
  DEFAULT_MODEL_BY_PROVIDER
} from './providerConfig';
import {
  addContextFile,
  clearContextFiles,
  getContextFiles,
  getContextSummary,
  pushQuestionHistory,
  getQuestionHistory,
  clearQuestionHistory,
  markContextFileRagIndexed,
  updateContextFileSummary,
  setStructuredContext,
  getStructuredContext,
  pushAnswerSummary,
  mergeExpandedIntoAnswerSummary,
  clearAnswerSummaries,
  getAnswerSummaries,
  addStructuredDoc,
  addSemanticChunks,
  clearDocsByType
} from './contextStore';
import { analyzeDocumentForRag } from './ragIndex';
import { classifyDocumentType } from './docClassifier';
import { planAnswerContext, buildMeetingAnswerContext, buildInterviewDocContent } from './retrieval';
import { generateSemanticChunks } from './chunking';
import { createEmbedding } from './embeddings';
import { addChunkEmbeddings, clearChunkEmbeddingsByDocType, type ChunkEmbedding } from './vectorStore';
import { v4 as uuidv4 } from 'uuid';
import {
  getSettings,
  updateSettings,
  getApiKey,
  saveApiKey,
  saveApiKeyForProvider,
  clearApiKey,
  hasApiKey
} from './settingsStore';
import {
  getMatchingDemoEntry,
  demoEntryToAssistJSON,
  demoEntryToReadableJSON
} from './demoAnswerLibrary';
import {
  clearSessionInterviewLog,
  appendSessionInterviewEntry,
  updateSessionInterviewExpanded
} from './sessionInterviewLog';
import {
  exportSessionInterviewToPdf,
  prepareSessionInterviewExportPdf,
  finalizeSessionInterviewExportPdf
} from './interviewSessionExport';
import {
  isNoiseOrUnrecognizedQuestionZh,
  type AssistJSON,
  type AssistEventPayload,
  type ListenerStatus,
  type ApiProvider,
  type ContextDocType,
  type ContextLabel
} from './types';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { registerMacIpcHandlers } from './macIpcHandlers';

// ─────────────────────────────────────────────
// 音频设备工具函数
// ─────────────────────────────────────────────

// naudiodon 将 GBK 字节传给 V8 时，V8 按 UTF-8 解析，无效字节已被替换为 U+FFFD
// （不同字体渲染成 □ 或 ◆），原始中文字节不可恢复。
// 解决方案：设备名通常是 "中文前缀 (English Name)" 格式，直接提取括号内的英文部分。
function fixDeviceName(raw: string): string {
  // 检测是否含有乱码字符：U+FFFD 替换字符、U+0080-U+00FF 高 Latin 字节、U+25A0-U+25FF 几何图形
  const GARBLED = /[\uFFFD\u0080-\u00FF\u25A0-\u25FF]/;

  if (!GARBLED.test(raw)) return raw;

  // "乱码前缀 (English Device Name)" → 提取 "English Device Name"
  const parenIdx = raw.indexOf('(');
  if (parenIdx > 0) {
    const before = raw.slice(0, parenIdx).trim();
    const closeIdx = raw.lastIndexOf(')');
    if (GARBLED.test(before) && closeIdx > parenIdx) {
      const inside = raw.slice(parenIdx + 1, closeIdx).trim();
      const after = raw.slice(closeIdx + 1).trim();
      if (inside.length > 1) return after ? `${inside} ${after}` : inside;
    }
  }

  // 没有括号：直接剥离乱码字符并清理多余空格
  return raw.replace(/[\uFFFD\u0080-\u00FF\u25A0-\u25FF]/g, '').replace(/\s{2,}/g, ' ').trim() || raw;
}

// 按优先级匹配环回设备，用于捕捉「系统正在播放的声音」（面试官/视频声）
// 1) WASAPI Loopback：名称形如 "扬声器名 [Loopback]"，直接对应系统输出设备，无需立体声混音
// 2) 虚拟输入设备：立体声混音 / Virtual Desktop Audio 等（若存在）
const LOOPBACK_KEYWORDS = [
  'virtual desktop audio',
  'stereo mix',
  '立体声混音',
  'wave out mix',
  'what u hear',
  'loopback',
  'blackhole', // Mac: BlackHole 虚拟声卡（在 Windows 上不存在此设备，无副作用）
];

/** 若当前 PortAudio 暴露了 WASAPI Loopback 设备，返回默认播放设备对应的 loopback（名称含 [Loopback]） */
function getDefaultWASAPILoopbackDevice(): { id: number; name: string } | null {
  try {
    const all = portAudio.getDevices() as { id: number; name: string; maxInputChannels: number; maxOutputChannels: number; hostAPIName: string }[];
    const inputDevices = all.filter(d => d.maxInputChannels > 0);
    const loopbacks = inputDevices.filter(d => fixDeviceName(d.name).includes('[Loopback]'));
    if (loopbacks.length === 0) return null;

    const hostAPIs = (portAudio as any).getHostAPIs?.() as { HostAPIs: { name: string; defaultOutput: number }[] } | undefined;
    if (hostAPIs?.HostAPIs) {
      const wasapi = hostAPIs.HostAPIs.find((h: { name: string }) => h.name === 'WASAPI');
      if (wasapi != null && wasapi.defaultOutput != null && all[wasapi.defaultOutput]) {
        const outputName = all[wasapi.defaultOutput].name;
        const loopbackName = `${outputName} [Loopback]`;
        const match = loopbacks.find(d => fixDeviceName(d.name) === loopbackName || fixDeviceName(d.name).includes(outputName));
        if (match) return { id: match.id, name: fixDeviceName(match.name) };
      }
    }
    return { id: loopbacks[0].id, name: fixDeviceName(loopbacks[0].name) };
  } catch { /* ignore */ }
  return null;
}

function autoDetectLoopbackDeviceId(): { id: number; name: string } | null {
  try {
    const wasapi = getDefaultWASAPILoopbackDevice();
    if (wasapi) return wasapi;

    const all = portAudio.getDevices() as { id: number; name: string; maxInputChannels: number; hostAPIName: string }[];
    const inputDevices = all.filter(d => d.maxInputChannels > 0);
    const mme = inputDevices.filter(d => d.hostAPIName === 'MME');
    const candidates = mme.length > 0 ? mme : inputDevices;

    for (const keyword of LOOPBACK_KEYWORDS) {
      const match = candidates.find(d => fixDeviceName(d.name).toLowerCase().includes(keyword));
      if (match) return { id: match.id, name: fixDeviceName(match.name) };
    }
  } catch { /* ignore */ }
  return null;
}

// 返回实际要使用的 device ID：
// - 用户手动指定（非 -1）时直接用指定值
// - Windows 上 -1 表示“系统播放（WASAPI 环回）”，直接返回 -1
// - 非 Windows 上 -1 时尝试检测环回设备，否则用系统默认
function resolveAudioDeviceId(configured: number): number {
  if (configured !== -1) return configured;
  if (process.platform === 'win32') return -1; // WASAPI loopback path
  return autoDetectLoopbackDeviceId()?.id ?? -1;
}

// 给音频模块绑定 level 事件，转发到 renderer
function attachLevelForwarder(module: { on: (e: string, cb: (...args: any[]) => void) => void }) {
  module.on('level', (level: number) => {
    mainWindow?.webContents.send('audio:level', level);
  });
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let audioListener: AudioListener | null = null;
let realtimeTranscriber: RealtimeTranscriber | null = null;
let realtimeAllInOne: RealtimeAllInOne | null = null;
let screenshotSelectionWindow: BrowserWindow | null = null;

/** Realtime 一体：若 response.done 时还没有 input_audio_transcription，则先挂起，等转写回调再写入一键导出 */
type PendingRealtimeSessionExport = {
  question_zh: string;
  concise_answer_en: string;
  expanded_answer_en?: string;
  keywords_en?: string[];
};

let pendingRealtimeSessionExport: PendingRealtimeSessionExport | null = null;
/** Realtime 一轮 done 后若还在等 ASR 再写导出，则暂缓 stop WS，超时后放弃 */
let pendingAsrExportTimeout: ReturnType<typeof setTimeout> | null = null;
let allInOnePostTurnCleanupScheduled = false;

/** 从 answerSummaries 取该题最近一次展开（解决：晚到 ASR 写入导出时，极简预取已先 merge 进 summaries 但 session 文件尚无行） */
function expandedAnswerEnForQuestionZh(questionZh: string): string | undefined {
  const q = questionZh.trim();
  const summaries = getAnswerSummaries();
  for (let i = summaries.length - 1; i >= 0; i--) {
    if ((summaries[i].question_zh ?? '').trim() === q) {
      const e = summaries[i].expanded_answer_en?.trim();
      if (e) return e;
    }
  }
  return undefined;
}

type ScreenshotSelection = {
  rect: { x: number; y: number; width: number; height: number };
  displayId: number;
};

function selectionOverlayHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin:0; width:100%; height:100%; overflow:hidden; cursor:crosshair; background:rgba(0,0,0,0.16); }
    #box { position:absolute; border:2px solid #60a5fa; background:rgba(96,165,250,0.18); box-shadow:0 0 0 9999px rgba(0,0,0,0.28); display:none; }
    #hint { position:fixed; top:18px; left:50%; transform:translateX(-50%); color:white; font:14px system-ui,sans-serif; background:rgba(15,23,42,0.75); padding:8px 12px; border-radius:6px; pointer-events:none; }
  </style>
</head>
<body>
  <div id="hint">拖拽选择截图区域，Esc 取消</div>
  <div id="box"></div>
  <script>
    const { ipcRenderer } = require('electron');
    const box = document.getElementById('box');
    let down = false, sx = 0, sy = 0;
    const draw = (x, y) => {
      const left = Math.min(sx, x);
      const top = Math.min(sy, y);
      const width = Math.abs(x - sx);
      const height = Math.abs(y - sy);
      box.style.display = 'block';
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';
    };
    window.addEventListener('mousedown', e => { down = true; sx = e.clientX; sy = e.clientY; draw(sx, sy); });
    window.addEventListener('mousemove', e => { if (down) draw(e.clientX, e.clientY); });
    window.addEventListener('mouseup', e => {
      if (!down) return;
      down = false;
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      const width = Math.abs(e.clientX - sx);
      const height = Math.abs(e.clientY - sy);
      ipcRenderer.send('screenshot-selection:done', width >= 8 && height >= 8 ? { x, y, width, height } : null);
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') ipcRenderer.send('screenshot-selection:done', null);
    });
  </script>
</body>
</html>`;
}

async function selectScreenshotRegion(): Promise<ScreenshotSelection | null> {
  if (screenshotSelectionWindow) return null;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { bounds } = display;

  mainWindow?.hide();
  await new Promise(resolve => setTimeout(resolve, 120));

  return await new Promise(resolve => {
    let settled = false;
    const finish = (rect: { x: number; y: number; width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners('screenshot-selection:done');
      const win = screenshotSelectionWindow;
      screenshotSelectionWindow = null;
      try { win?.close(); } catch {}
      if (!rect) {
        mainWindow?.show();
        resolve(null);
        return;
      }
      resolve({ rect, displayId: display.id });
    };

    ipcMain.once('screenshot-selection:done', (_event, rect) => finish(rect));
    screenshotSelectionWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    screenshotSelectionWindow.setAlwaysOnTop(true, 'screen-saver');
    screenshotSelectionWindow.on('closed', () => finish(null));
    screenshotSelectionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(selectionOverlayHtml())}`);
  });
}

async function captureSelectedRegion(selection: ScreenshotSelection): Promise<string | null> {
  const display = screen.getAllDisplays().find(d => d.id === selection.displayId) ?? screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale)
    }
  });
  const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const size = source.thumbnail.getSize();
  const sx = size.width / display.bounds.width;
  const sy = size.height / display.bounds.height;
  const cropped = source.thumbnail.crop({
    x: Math.max(0, Math.round(selection.rect.x * sx)),
    y: Math.max(0, Math.round(selection.rect.y * sy)),
    width: Math.max(1, Math.round(selection.rect.width * sx)),
    height: Math.max(1, Math.round(selection.rect.height * sy))
  });
  return cropped.toPNG().toString('base64');
}

function persistScreenshotAssist(assist: Partial<AssistJSON & { expanded_answer_en?: string }>, rawLabel: string): void {
  const q = assist.question_zh?.trim();
  const concise = assist.concise_answer_en;
  if (!q || isNoiseOrUnrecognizedQuestionZh(q)) return;
  if (!concise || typeof concise !== 'string' || !concise.trim()) return;
  const expanded = assist.expanded_answer_en;
  const keywords = assist.keywords_en;
  pushQuestionHistory(q);
  pushAnswerSummary({
    question_zh: q,
    concise_answer_en: concise.trim(),
    ...(typeof expanded === 'string' && expanded.trim() ? { expanded_answer_en: expanded.trim() } : {}),
    ...(Array.isArray(keywords) && keywords.length ? { keywords_en: keywords } : {}),
    createdAt: Date.now()
  });
  appendSessionInterviewEntry({
    interviewer_question_raw: rawLabel,
    question_zh: q,
    concise_answer_en: concise.trim(),
    ...(typeof expanded === 'string' && expanded.trim() ? { expanded_answer_en: expanded.trim() } : {}),
    ...(Array.isArray(keywords) && keywords.length ? { keywords_en: keywords } : {})
  });
}

/** Realtime 路径写入一键导出：合并 partial 与已预取进 summaries 的 expanded */
function appendRealtimeSessionExportRow(interviewer_question_raw: string, base: PendingRealtimeSessionExport) {
  const fromPartial = base.expanded_answer_en?.trim();
  const fromSummary = expandedAnswerEnForQuestionZh(base.question_zh);
  const exp = fromPartial || fromSummary;
  appendSessionInterviewEntry({
    interviewer_question_raw,
    question_zh: base.question_zh,
    concise_answer_en: base.concise_answer_en,
    ...(exp ? { expanded_answer_en: exp } : {}),
    ...(base.keywords_en?.length ? { keywords_en: base.keywords_en } : {})
  });
}

function flushPendingRealtimeSessionExport(reason: string) {
  const p = pendingRealtimeSessionExport;
  if (!p) return;
  appendRealtimeSessionExportRow('', p);
  pendingRealtimeSessionExport = null;
  console.log('[SessionExport] flushed pending without verbatim:', reason);
}

function scheduleRealtimeAllInOneRestartAfterTurn() {
  if (allInOnePostTurnCleanupScheduled) return;
  allInOnePostTurnCleanupScheduled = true;
  if (pendingAsrExportTimeout) {
    clearTimeout(pendingAsrExportTimeout);
    pendingAsrExportTimeout = null;
  }
  realtimeAllInOne?.stop();
  realtimeAllInOne = null;
  setTimeout(() => {
    allInOnePostTurnCleanupScheduled = false;
    const latest = getSettings();
    const provider = latest.apiProvider ?? 'openai';
    if (!latest.listening) return;
    if (!latest.useRealtimeAllInOne || provider !== 'openai') return;
    if (realtimeAllInOne) return;
    startAllInOneListener().catch((err) => {
      console.error('[AllInOne] auto-restart failed', err);
    });
  }, 120);
}

// ─────────────────────────────────────────────
// 滚动缓冲区：合并问题碎片
// 处理面试官中途停顿、问题分多段说完的情况
// ─────────────────────────────────────────────

interface PendingSegment {
  text: string;
  timestamp: number;
}

const BUFFER_EXPIRE_MS = 12000; // 12秒无新内容则认为话题结束，自动清空
const BUFFER_MAX_SEGMENTS = 6;  // 最多保留 6 段

let pendingSegments: PendingSegment[] = [];
let bufferExpireTimer: ReturnType<typeof setTimeout> | null = null;

function addSegmentToBuffer(text: string): void {
  const now = Date.now();
  // 清除过期片段
  pendingSegments = pendingSegments.filter(s => now - s.timestamp < BUFFER_EXPIRE_MS);
  pendingSegments.push({ text, timestamp: now });
  if (pendingSegments.length > BUFFER_MAX_SEGMENTS) {
    pendingSegments = pendingSegments.slice(-BUFFER_MAX_SEGMENTS);
  }
  // 重置自动清空计时器
  if (bufferExpireTimer) clearTimeout(bufferExpireTimer);
  bufferExpireTimer = setTimeout(() => {
    if (pendingSegments.length > 0) {
      console.log('[Buffer] 超时自动清空，丢弃片段:', pendingSegments.map(s => s.text).join(' | '));
    }
    pendingSegments = [];
    bufferExpireTimer = null;
  }, BUFFER_EXPIRE_MS);
}

function getCombinedText(): string {
  return pendingSegments.map(s => s.text).join(' ').trim();
}

function clearBuffer(): void {
  pendingSegments = [];
  if (bufferExpireTimer) {
    clearTimeout(bufferExpireTimer);
    bufferExpireTimer = null;
  }
}

// ─────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development';
  const settings = getSettings();

  mainWindow = new BrowserWindow({
    width: 640,
    height: 360,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    backgroundColor: '#020617',
    resizable: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 根据设置应用窗口透明度
  if (typeof settings.windowOpacity === 'number') {
    mainWindow.setOpacity(settings.windowOpacity);
  }

  mainWindow.setMenuBarVisibility(false);

  // 再次显式设置为最顶层窗口，使用更高优先级的 level，避免被普通窗口盖住
  //（某些 Windows 环境下仅在构造参数里设置 alwaysOnTop 可能会失效）
  try {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } catch {
    // 低版本 Electron 不支持 level 参数时，退化为简单调用
    mainWindow.setAlwaysOnTop(true);
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  centerFloating(mainWindow);

  // 关闭按钮直接退出程序
  mainWindow.on('closed', () => {
    mainWindow = null;
    tray?.destroy();
    tray = null;
    app.quit();
  });

  setupTrayAndShortcut();
}

const TRAY_ICON_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAvklEQVRYR+2WsQ3AIAwE+f9P5tGRpUixL' +
  'ewDd9JJsHc7g0MI4S9ewAN4gD0BNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBDQBNAFNAE1AE0AT0ATQBPAAPoAH8ABl0TfVnJd4gAAAABJRU5ErkJggg==';

function setupTrayAndShortcut() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  const trayIcon = icon.isEmpty() ? nativeImage.createFromDataURL(TRAY_ICON_DATA) : icon;
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('过了么AI');
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([{ label: '退出', click: () => { tray?.destroy(); tray = null; mainWindow?.destroy(); app.quit(); } }])
  );

  const TRAY_SHORTCUT = 'CommandOrControl+Shift+H';
  globalShortcut.register(TRAY_SHORTCUT, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function centerFloating(win: BrowserWindow) {
  const { width, height } = win.getBounds();
  const primary = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primary.workAreaSize;
  const x = Math.round(sw / 2 - width / 2);
  const y = Math.round(sh / 2 - height / 2);
  win.setPosition(x, y);
}

// ─────────────────────────────────────────────
// 预过滤：判断是否像一个真实的面试问题
// 不消耗任何 API，纯本地规则
// ─────────────────────────────────────────────

function looksLikeInterviewQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // 字数/词数太少直接丢弃
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 5) {
    console.log('[Filter] 丢弃：词数不足', words.length, '->', t);
    return false;
  }
  if (t.length < 20) {
    console.log('[Filter] 丢弃：字符数不足', t.length, '->', t);
    return false;
  }

  const lower = t.toLowerCase();

  // 常见无意义填充/反应短语黑名单
  const fillerPatterns = [
    /^(ok|okay|alright|all right|right|got it|i see|uh huh|yeah|yep|sure|thanks|thank you|bye|goodbye|hmm+|uh+|um+|oh+)[.,!?]*$/i,
    /^(that'?s?\s*(it|all|correct|right|good|fine|great|perfect|done))[.,!?]*$/i,
    /^(sounds?\s*(good|great|fine|right|ok|okay))[.,!?]*$/i,
    /^(nice|cool|good|great|wonderful|excellent|perfect|fantastic)[.,!?]*$/i,
  ];
  if (fillerPatterns.some(p => p.test(lower))) {
    console.log('[Filter] 丢弃：无意义填充词 ->', t);
    return false;
  }

  // 包含面试提问关键词（英文）
  const questionKeywords = [
    /\b(what|where|when|why|how|who|which|whose|whom)\b/,
    /\b(can|could|would|will|do|does|did|are|is|have|has|had)\s+you\b/,
    /\byou(r)?\b/,
    /\b(tell|describe|explain|walk|talk|share|give|discuss|elaborate|expand)\b/,
    /\b(experience|background|project|challenge|strength|weakness|team|role|skill|approach|handle|dealt|situation|example|time when)\b/,
    /\?/,
  ];
  const hasEnglishQuestion = questionKeywords.some(r => r.test(lower));

  // 中文问题关键词
  const chineseQuestionPattern = /[吗？呢啊]|请(介绍|描述|说明|谈谈|讲讲|举例)|你(的|有|曾|是|能|会)|如何|怎么|为什么|什么|哪些/;
  const hasChineseQuestion = chineseQuestionPattern.test(t);

  if (!hasEnglishQuestion && !hasChineseQuestion) {
    console.log('[Filter] 丢弃：无面试问题特征 ->', t);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────
// 公共：拿到一段完整问题文本 → 生成提词卡
// 两条路径（段式 + 流式）最终都走这里
// ─────────────────────────────────────────────

async function handleCompleteQuestion(questionRaw: string, speechStoppedAt = 0) {
  const settings = getSettings();
  const apiKey = await getApiKey();

  if (!apiKey && !settings.mockLlm) {
    console.warn('无 API Key 且未开启 mockLlm，跳过 LLM 调用');
    return;
  }

  const normalized = questionRaw.trim();
  if (!normalized) return;

  // 先入缓冲区，再检查合并后的全文是否构成完整问题
  addSegmentToBuffer(normalized);
  const combined = getCombinedText();

  if (!looksLikeInterviewQuestion(combined)) {
    console.log('[Buffer] 当前缓冲不像完整问题，继续等待更多片段:', combined);
    return;
  }

  // 合并文本通过过滤，清空缓冲并触发 LLM
  console.log('[Buffer] 识别到完整问题，触发 LLM:', combined);
  clearBuffer();

  await scheduleAssistFromCombined(combined, speechStoppedAt);
}

/** 多轮问题串行生成，避免上一题流式未完成时下一题插队导致卡片错乱 */
let assistPipelineBusy = false;
const assistPipelineQueue: { combined: string; speechStoppedAt: number }[] = [];

async function scheduleAssistFromCombined(combined: string, speechStoppedAt: number): Promise<void> {
  if (assistPipelineBusy) {
    assistPipelineQueue.push({ combined, speechStoppedAt });
    return;
  }
  assistPipelineBusy = true;
  try {
    let job = { combined, speechStoppedAt };
    for (;;) {
      await runAssistForCombinedQuestion(job.combined, job.speechStoppedAt);
      const next = assistPipelineQueue.shift();
      if (!next) break;
      job = next;
    }
  } finally {
    assistPipelineBusy = false;
  }
}

async function runAssistForCombinedQuestion(combined: string, speechStoppedAt: number) {
  const settings = getSettings();
  const apiKey = await getApiKey();

  pushQuestionHistory(combined);
  const questionsHistory = getQuestionHistory();
  const contextSummary = getContextSummary();
  const structured = getStructuredContext();

  const t3end = Date.now();
  const t4 = t3end;

  // 演示答案库：若当前问题与库中某条匹配，直接使用预置答案，不调 LLM
  const demoEntry = getMatchingDemoEntry(combined);
  if (demoEntry) {
    const assist = demoEntryToAssistJSON(demoEntry);
    if (isNoiseOrUnrecognizedQuestionZh(assist.question_zh)) return;
    if (mainWindow) {
      const t6 = Date.now();
      mainWindow.webContents.send('assist:streamChunk', {
        partial: {
          question_zh: assist.question_zh,
          concise_answer_en: assist.concise_answer_en,
          keywords_en: assist.keywords_en
        },
        done: true
      });
      pushAnswerSummary({
        question_zh: assist.question_zh,
        concise_answer_en: assist.concise_answer_en ?? '',
        createdAt: Date.now()
      });
      appendSessionInterviewEntry({
        interviewer_question_raw: combined.trim(),
        question_zh: assist.question_zh,
        concise_answer_en: assist.concise_answer_en ?? '',
        ...(Array.isArray(assist.keywords_en) && assist.keywords_en.length
          ? { keywords_en: assist.keywords_en }
          : {})
      });
      console.log(`[Demo] 使用演示库答案 +${Date.now() - t4}ms`);
    }
    return;
  }

  console.log('[⏱ T4] LLM 开始生成（流式）');

  const provider = settings.apiProvider ?? 'openai';
  const baseURL = getOpenAICompatibleBaseUrl(provider);
  const effectiveSystemPrompt = settings.answerLanguage === 'zh'
    ? settings.systemPrompt + '\n[LANGUAGE]\nAnswer in Chinese (Simplified).'
    : settings.systemPrompt;

  // ── 组会模式：全文注入，严格基于文档回答 ────────────────────────────
  if (settings.meetingMode) {
    // 全文注入：同步读取，无需等待向量化，上传后即可使用
    const meetCtx = buildMeetingAnswerContext();

    if (!meetCtx.hasDocuments) {
      // 没有文档时直接提示，不调 LLM
      mainWindow?.webContents.send('assist:streamChunk', {
        partial: {
          question_zh: '尚未上传项目文档',
          concise_answer_en: 'Please upload your project documents first. Go to the document panel and add your files.',
          expanded_answer_en: ''
        },
        done: true
      });
      return;
    }

    console.log(`[Meeting] 全文注入模式，文档总长 ${meetCtx.fullContent.length} 字符`);

    let accumulated: Partial<AssistJSON & { expanded_answer_en?: string }> = {};
    let cardShown = false;

    const emitMeetingChunk = (chunk: { partial: Partial<AssistJSON & { expanded_answer_en?: string }>; done: boolean }) => {
      const partial = chunk.partial;
      if (partial.question_zh !== undefined) accumulated.question_zh = partial.question_zh;
      if (partial.concise_answer_en !== undefined) accumulated.concise_answer_en = partial.concise_answer_en;
      if (partial.expanded_answer_en !== undefined) accumulated.expanded_answer_en = partial.expanded_answer_en;
      if (isNoiseOrUnrecognizedQuestionZh(accumulated.question_zh)) {
        if (chunk.done) accumulated = {};
        return;
      }
      if (!mainWindow) return;
      if (!cardShown && accumulated.question_zh) {
        cardShown = true;
        console.log(`[⏱ T5-meeting] 卡片首次弹出 +${Date.now() - t4}ms`);
      }
      mainWindow.webContents.send('assist:streamChunk', {
        partial: { ...accumulated },
        done: chunk.done
      });
      if (chunk.done) {
        persistAnswerSummary(accumulated as Partial<AssistJSON>);
        console.log(`[⏱ T6-meeting] 完成 +${Date.now() - t4}ms`);
      }
    };

    try {
      if (isOpenAICompatible(provider)) {
        await generateMeetingAssistStream(
          apiKey ?? '',
          settings.model,
          meetCtx.fullContent,
          combined,
          emitMeetingChunk,
          baseURL,
          meetCtx.hasDocuments
        );
      } else {
        // Gemini / Ollama 降级：走 readable 模式（暂不支持全文注入）
        const cs = getContextSummary();
        const qh = getQuestionHistory();
        let result: import('./types').ReadableAssistJSON | null = null;
        if (provider === 'google') {
          result = await generateAssistGemini(apiKey ?? '', settings.model, effectiveSystemPrompt, cs, qh, combined, 'readable') as import('./types').ReadableAssistJSON;
        } else if (provider === 'ollama') {
          const url = settings.ollamaBaseUrl?.trim() || 'http://localhost:11434';
          result = await generateAssistOllama(url, settings.model, effectiveSystemPrompt, cs, qh, combined, 'readable') as import('./types').ReadableAssistJSON;
        }
        if (result) emitMeetingChunk({ partial: result as Partial<AssistJSON & { expanded_answer_en?: string }>, done: true });
      }
    } catch (e) {
      console.error('[Meeting] generateMeetingAssistStream error', e);
    }
    return;
  }

  const persistAnswerSummary = (partial: Partial<AssistJSON>) => {
    const q = partial.question_zh?.trim();
    const concise = (partial as any).concise_answer_en;
    if (!q || isNoiseOrUnrecognizedQuestionZh(q)) return;
    if (!concise || typeof concise !== 'string' || !concise.trim()) return;
    const expanded = (partial as { expanded_answer_en?: string }).expanded_answer_en;
    const kw = (partial as { keywords_en?: string[] }).keywords_en;
    pushAnswerSummary({
      question_zh: q,
      concise_answer_en: concise.trim(),
      ...(typeof expanded === 'string' && expanded.trim()
        ? { expanded_answer_en: expanded.trim() }
        : {}),
      createdAt: Date.now()
    });
    appendSessionInterviewEntry({
      interviewer_question_raw: combined.trim(),
      question_zh: q,
      concise_answer_en: concise.trim(),
      ...(typeof expanded === 'string' && expanded.trim() ? { expanded_answer_en: expanded.trim() } : {}),
      ...(Array.isArray(kw) && kw.length ? { keywords_en: kw } : {})
    });
  };

  // ── 流式路径：OpenAI 兼容真流式；Ollama/Gemini 仍一次性结果但通过 streamChunk 发出（与 UI 一致）────────
  if (!settings.mockLlm) {
    let cardShown = false;
    let accumulated: Partial<AssistJSON> = {};

    const emitChunk = (partial: Partial<AssistJSON>, done: boolean) => {
      const merged: Partial<AssistJSON> = { ...accumulated, ...partial };
      if (isNoiseOrUnrecognizedQuestionZh(merged.question_zh)) {
        if (done) {
          accumulated = {};
          console.log('[Assist] skip noisy/non-question (流式一次性 chunk)');
        }
        return;
      }
      if (!mainWindow) return;
      if (!cardShown && merged.question_zh) {
        cardShown = true;
        console.log(`[⏱ T5-stream] 卡片首次弹出 +${Date.now() - t4}ms`);
      }
      mainWindow.webContents.send('assist:streamChunk', { partial: merged, done });
      accumulated = { ...merged };
      if (done) {
        persistAnswerSummary(accumulated);
        console.log(`[⏱ T6] 完成 +${Date.now() - t4}ms`);
      }
    };

    try {
      if (provider === 'ollama') {
        const url = settings.ollamaBaseUrl?.trim() || 'http://localhost:11434';
        const result = await generateAssistOllama(
          url,
          settings.model,
          effectiveSystemPrompt,
          contextSummary,
          questionsHistory,
          combined,
          settings.responseStyle ?? 'concise'
        ) as AssistJSON;
        emitChunk(result, true);
      } else if (provider === 'google') {
        const result = await generateAssistGemini(
          apiKey ?? '',
          settings.model,
          effectiveSystemPrompt,
          contextSummary,
          questionsHistory,
          combined,
          settings.responseStyle ?? 'concise'
        ) as AssistJSON;
        emitChunk(result, true);
      } else if (isOpenAICompatible(provider)) {
        await generateAssistStream(
          apiKey ?? '',
          settings.model,
          effectiveSystemPrompt,
          contextSummary,
          questionsHistory,
          combined,
          (chunk) => {
            const next: Partial<AssistJSON> = { ...accumulated };
            if (chunk.partial.question_zh !== undefined) next.question_zh = chunk.partial.question_zh;
            if (chunk.partial.thinking_zh !== undefined) (next as any).thinking_zh = chunk.partial.thinking_zh;
            if (chunk.partial.keywords_en !== undefined) (next as any).keywords_en = chunk.partial.keywords_en;
            if (chunk.partial.concise_answer_en !== undefined) (next as any).concise_answer_en = chunk.partial.concise_answer_en;
            if (chunk.partial.expanded_answer_en !== undefined) (next as any).expanded_answer_en = chunk.partial.expanded_answer_en;
            if (isNoiseOrUnrecognizedQuestionZh(next.question_zh)) {
              if (chunk.done) {
                accumulated = {};
                console.log('[Assist] skip noisy/non-question (真流式 done)');
              }
              return;
            }
            if (!mainWindow) return;
            accumulated = next;
            if (!cardShown && accumulated.question_zh) {
              cardShown = true;
              console.log(`[⏱ T5-stream] 卡片首次弹出 +${Date.now() - t4}ms`);
            }
            mainWindow.webContents.send('assist:streamChunk', { partial: { ...accumulated }, done: chunk.done });
            if (chunk.done) {
              persistAnswerSummary(accumulated);
              console.log(`[⏱ T6] 流式完成 +${Date.now() - t4}ms`);
            }
          },
          settings.responseStyle ?? 'concise',
          baseURL,
          structured,
          buildInterviewDocContent() || undefined
        );
      }
    } catch (e) {
      console.error('generateAssistStream error', e);
    }
    return;
  }

  // ── 非流式路径 ────────────────────────────────────
  let assist: AssistJSON;
  try {
    if (provider === 'ollama') {
      const url = settings.ollamaBaseUrl?.trim() || 'http://localhost:11434';
      assist = await generateAssistOllama(
        url,
        settings.model,
        effectiveSystemPrompt,
        contextSummary,
        questionsHistory,
        combined,
        settings.responseStyle ?? 'concise'
      ) as AssistJSON;
    } else if (provider === 'google') {
      assist = await generateAssistGemini(
        apiKey ?? '',
        settings.model,
        effectiveSystemPrompt,
        contextSummary,
        questionsHistory,
        combined,
        settings.responseStyle ?? 'concise'
      ) as AssistJSON;
    } else {
      assist = await generateAssist(
        apiKey ?? '',
        settings.model,
        effectiveSystemPrompt,
        contextSummary,
        questionsHistory,
        combined,
        settings.mockLlm,
        settings.responseStyle ?? 'concise',
        baseURL,
        structured
      ) as AssistJSON;
    }
  } catch (e) {
    console.error('generateAssist error', e);
    return;
  }

  const t5 = Date.now();
  console.log(`[⏱ T5] LLM 完成        +${t5 - t4}ms (LLM 耗时)`);

  if (assist.question_zh && isNoiseOrUnrecognizedQuestionZh(assist.question_zh)) {
    console.log('skip ambiguous / noisy question segment');
    return;
  }

  if (mainWindow) {
    const t6 = Date.now();
    const payload: AssistEventPayload = {
      assist,
      queueSize: 0,
      timestamp: t6
    };
    mainWindow.webContents.send('assist:newSuggestion', payload);
    persistAnswerSummary(assist);
    const t1t6 = speechStoppedAt ? `T1→T6 全程: +${t6 - speechStoppedAt}ms` : '';
    console.log(`[⏱ T6] 卡片发出        +${t6 - t5}ms (IPC) | T3→T6: +${t6 - t3end}ms | ${t1t6}`);
  }
}

// ─────────────────────────────────────────────
// 段式 ASR 路径（默认路径）
// ─────────────────────────────────────────────

async function handleSegment(buffer: Buffer) {
  const settings = getSettings();
  // 段式 ASR 使用 OpenAI Whisper，需 OpenAI Key
  const openaiKey = await getApiKey('openai');

  if (!openaiKey && !settings.mockAsr) {
    console.warn('无 OpenAI API Key 且未开启 mockAsr，跳过本段音频');
    return;
  }

  let questionRaw: string;
  try {
    questionRaw = await transcribeSegment(buffer, openaiKey ?? '', settings.mockAsr);
  } catch (e) {
    console.error('transcribeSegment error', e);
    return;
  }
  if (!questionRaw) return;

  await handleCompleteQuestion(questionRaw);
}

function getSegmentListener(): AudioListener {
  if (!audioListener) {
    const s = getSettings();
    audioListener = new AudioListener({
      sampleRate: 16000,
      silenceMs: 1000,
      silenceThreshold: 0.01,
      deviceId: resolveAudioDeviceId(s.audioDeviceId ?? -1)
    });
    audioListener.on('segment', handleSegment);
    attachLevelForwarder(audioListener);
  }
  return audioListener;
}

// ─────────────────────────────────────────────
// 流式 ASR 路径（Realtime WebSocket）
// ─────────────────────────────────────────────

async function startRealtimeListener(): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('Realtime ASR 需要 API Key');
    return;
  }

  if (!realtimeTranscriber) {
    const s = getSettings();
    realtimeTranscriber = new RealtimeTranscriber({ apiKey, deviceId: resolveAudioDeviceId(s.audioDeviceId ?? -1) });
    attachLevelForwarder(realtimeTranscriber);
  }

  await realtimeTranscriber.start((text, t1) => handleCompleteQuestion(text, t1));
}

function stopRealtimeListener() {
  realtimeTranscriber?.stop();
}

// ─────────────────────────────────────────────
// 全内属路径（gpt-4o-realtime：听音频直接出 JSON）
// ─────────────────────────────────────────────

async function startAllInOneListener(): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[AllInOne] 需要 API Key');
    return;
  }

  flushPendingRealtimeSessionExport('restart AllInOne before new instance');
  if (pendingAsrExportTimeout) {
    clearTimeout(pendingAsrExportTimeout);
    pendingAsrExportTimeout = null;
  }
  allInOnePostTurnCleanupScheduled = false;

  // 每次都创建新实例，携带最新 context 和 history
  realtimeAllInOne?.stop();
  realtimeAllInOne = null;

  const settings = getSettings();
  const contextSummary = getContextSummary();
  const questionsHistory = getQuestionHistory();
  const structured = getStructuredContext();

  const responseStyle = settings.responseStyle ?? 'concise';
  const basePrompt = settings.answerLanguage === 'zh'
    ? settings.systemPrompt + '\n[LANGUAGE]\nAnswer in Chinese (Simplified).'
    : settings.systemPrompt;
  // 与普通 LLM 调用保持一致：统一先用用户/个性化的 systemPrompt 作为 base，
  // 再根据模式附加不同的「强制输出格式」约束，避免极简模式指令过弱导致 JSON 不稳定。
  const effectivePrompt =
    responseStyle === 'readable'
      ? buildReadableSystemPrompt(basePrompt)
      : buildConciseSystemPrompt(basePrompt);

  // 根据模式构建文档内容注入
  const meetingMode = settings.meetingMode ?? false;
  const meetingDocContent = meetingMode ? buildMeetingAnswerContext().fullContent : undefined;
  const interviewDocContent = meetingMode ? undefined : buildInterviewDocContent();

  realtimeAllInOne = new RealtimeAllInOne({
    apiKey,
    systemPrompt: effectivePrompt,
    contextSummary,
    questionsHistory,
    structuredContext: structured,
    answerSummaries: getAnswerSummaries(),
    responseStyle,
    deviceId: resolveAudioDeviceId(settings.audioDeviceId ?? -1),
    meetingMode,
    meetingDocContent,
    interviewDocContent
  });
  attachLevelForwarder(realtimeAllInOne);

  await realtimeAllInOne.start((chunk) => {
    if (!mainWindow) return;

    const interviewerTranscript = (chunk.interviewerTranscript ?? '').trim();

    // 演示答案库：若模型返回的 question_zh 与库中某条匹配，用预置答案替换
    let payload = chunk;
    if (chunk.done && chunk.partial.question_zh && !isNoiseOrUnrecognizedQuestionZh(chunk.partial.question_zh)) {
      const demoEntry = getMatchingDemoEntry(chunk.partial.question_zh);
      if (demoEntry) {
        const responseStyle = settings.responseStyle ?? 'concise';
        const questionZhDisplay = (demoEntry as any).question_zh_display
          ? String((demoEntry as any).question_zh_display).trim()
          : demoEntry.question_zh;
        payload = {
          ...chunk,
          partial: {
            question_zh: questionZhDisplay,
            concise_answer_en: demoEntry.concise_answer,
            keywords_en: Array.isArray(demoEntry.keywords) ? demoEntry.keywords : [],
            ...(responseStyle === 'readable' ? { expanded_answer_en: demoEntry.readable_answer } : {})
          }
        };
        console.log('[Demo] Realtime 使用演示库答案');
      }
    }

    // done 时先写入摘要/导出，再发 chunk，避免渲染进程抢先预取 getReadableAnswer 时摘要尚未落盘
    if (payload.done) {
      let deferCleanupForAsrExport = false;

      if (payload.partial.question_zh && !isNoiseOrUnrecognizedQuestionZh(payload.partial.question_zh)) {
        pushQuestionHistory(payload.partial.question_zh.trim());
        const concise = (payload.partial as any).concise_answer_en;
        if (concise && typeof concise === 'string' && concise.trim()) {
          const exp = (payload.partial as { expanded_answer_en?: string }).expanded_answer_en;
          const kw = (payload.partial as { keywords_en?: string[] }).keywords_en;
          pushAnswerSummary({
            question_zh: payload.partial.question_zh.trim(),
            concise_answer_en: concise.trim(),
            ...(typeof exp === 'string' && exp.trim()
              ? { expanded_answer_en: exp.trim() }
              : {}),
            createdAt: Date.now()
          });
          const qzh = payload.partial.question_zh.trim();
          const baseExport = {
            question_zh: qzh,
            concise_answer_en: concise.trim(),
            ...(typeof exp === 'string' && exp.trim() ? { expanded_answer_en: exp.trim() } : {}),
            ...(Array.isArray(kw) && kw.length ? { keywords_en: kw } : {})
          };
          // 一键导出：无转写时暂缓 stop WS，等 transcription.completed 或超时后再写入并重建
          if (interviewerTranscript) {
            pendingRealtimeSessionExport = null;
            appendRealtimeSessionExportRow(interviewerTranscript, baseExport);
          } else {
            pendingRealtimeSessionExport = baseExport;
            deferCleanupForAsrExport = true;
          }
        }
      }

      if (deferCleanupForAsrExport) {
        pendingAsrExportTimeout = setTimeout(() => {
          pendingAsrExportTimeout = null;
          flushPendingRealtimeSessionExport('ASR wait timeout after Realtime done (3.5s)');
          scheduleRealtimeAllInOneRestartAfterTurn();
        }, 3500);
      } else {
        scheduleRealtimeAllInOneRestartAfterTurn();
      }
    }

    mainWindow.webContents.send('assist:streamChunk', payload);
  }, {
    onInterviewerTranscriptReady: (text) => {
      const p = pendingRealtimeSessionExport;
      if (p) {
        appendRealtimeSessionExportRow(text.trim(), p);
        pendingRealtimeSessionExport = null;
      }
      scheduleRealtimeAllInOneRestartAfterTurn();
    }
  });
}

function stopAllInOneListener(audioOnly = false): void {
  if (audioOnly) {
    realtimeAllInOne?.stopAudio();
  } else {
    if (pendingAsrExportTimeout) {
      clearTimeout(pendingAsrExportTimeout);
      pendingAsrExportTimeout = null;
    }
    flushPendingRealtimeSessionExport('stop AllInOne listener');
    realtimeAllInOne?.stop();
    realtimeAllInOne = null;
    allInOnePostTurnCleanupScheduled = false;
  }
}

// ─────────────────────────────────────────────

async function answerFromScreenshot(): Promise<{ ok: boolean; error?: string }> {
  try {
    const selection = await selectScreenshotRegion();
    if (!selection) return { ok: false, error: 'cancelled' };
    await new Promise(resolve => setTimeout(resolve, 120));
    const imageBase64 = await captureSelectedRegion(selection);
    mainWindow?.show();
    if (!imageBase64) return { ok: false, error: 'capture failed' };

    const settings = getSettings();
    const provider = settings.apiProvider ?? 'openai';
    const apiKey = await getApiKey(provider);
    if (!apiKey || settings.mockLlm) return { ok: false, error: 'API key required' };

    const meetingMode = settings.meetingMode ?? false;
    const meetCtx = meetingMode ? buildMeetingAnswerContext() : null;
    const imgSystemPrompt = settings.answerLanguage === 'zh'
      ? settings.systemPrompt + '\n[LANGUAGE]\nAnswer in Chinese (Simplified).'
      : settings.systemPrompt;
    const sharedArgs = [
      apiKey,
      settings.model,
      imgSystemPrompt,
      getContextSummary(),
      getQuestionHistory(),
      imageBase64,
      settings.responseStyle ?? 'concise'
    ] as const;
    const result = provider === 'google'
      ? await generateAssistGeminiFromImage(
          ...sharedArgs,
          getStructuredContext(),
          meetingMode ? undefined : buildInterviewDocContent() || undefined,
          meetCtx ? { fullContent: meetCtx.fullContent, hasDocuments: meetCtx.hasDocuments } : undefined
        )
      : isOpenAICompatible(provider)
        ? await generateAssistFromImage(
            ...sharedArgs,
            getOpenAICompatibleBaseUrl(provider),
            getStructuredContext(),
            meetingMode ? undefined : buildInterviewDocContent() || undefined,
            meetCtx ? { fullContent: meetCtx.fullContent, hasDocuments: meetCtx.hasDocuments } : undefined
          )
        : null;

    if (!result) return { ok: false, error: 'Screenshot QA currently requires an OpenAI-compatible or Gemini vision model.' };
    const assist = result as AssistJSON & { expanded_answer_en?: string };

    if (assist.question_zh && isNoiseOrUnrecognizedQuestionZh(assist.question_zh)) return { ok: true };
    persistScreenshotAssist(assist, '[screenshot selection]');
    mainWindow?.webContents.send('assist:newSuggestion', {
      assist,
      queueSize: 0,
      timestamp: Date.now()
    } satisfies AssistEventPayload);
    return { ok: true };
  } catch (e: any) {
    mainWindow?.show();
    console.error('[ScreenshotQA] failed', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// IPC 处理
// ─────────────────────────────────────────────

/**
 * 把「极简一句 + 展开」写入 answerSummaries 与会话实录（一键导出 / [CONVERSATION]）。
 * concise 应使用极简流式那句（图1），不要用可读接口里模型重写的 concise。
 */
function persistReadableExpandedToSummary(
  qFixed: string,
  contextFromConcise: { concise_answer_en: string; keywords_en?: string[] } | undefined,
  result: { concise_answer_en?: string; expanded_answer_en?: string }
): void {
  const exp = result.expanded_answer_en?.trim() ?? '';
  if (!exp) return;
  const qzh = qFixed.trim();
  if (!qzh || isNoiseOrUnrecognizedQuestionZh(qzh)) return;

  const merged = mergeExpandedIntoAnswerSummary(
    qzh,
    exp,
    contextFromConcise?.concise_answer_en?.trim()
  );
  const concFromCtx = contextFromConcise?.concise_answer_en?.trim();
  const concFromResult = result.concise_answer_en?.trim();
  if (!merged && concFromCtx && contextFromConcise) {
    const kw = contextFromConcise.keywords_en;
    pushAnswerSummary({
      question_zh: qzh,
      concise_answer_en: concFromCtx,
      expanded_answer_en: exp,
      ...(Array.isArray(kw) && kw.length ? { keywords_en: kw } : {}),
      createdAt: Date.now()
    });
    appendSessionInterviewEntry({
      interviewer_question_raw: '',
      question_zh: qzh,
      concise_answer_en: concFromCtx,
      expanded_answer_en: exp,
      ...(Array.isArray(kw) && kw.length ? { keywords_en: kw } : {})
    });
  } else if (!merged && concFromResult) {
    pushAnswerSummary({
      question_zh: qzh,
      concise_answer_en: concFromResult,
      expanded_answer_en: exp,
      createdAt: Date.now()
    });
    updateSessionInterviewExpanded(qzh, exp);
  } else {
    updateSessionInterviewExpanded(qzh, exp);
  }
}

function registerIpcHandlers() {
  // Settings
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_e, partial) => {
    const before = getSettings();
    const updated = updateSettings(partial);

    // meetingMode 切换时：重建 AllInOne，让新 session 带上/去掉文档 instructions
    if ('meetingMode' in partial && partial.meetingMode !== before.meetingMode) {
      if (updated.useRealtimeAllInOne && updated.listening) {
        realtimeAllInOne?.stop();
        realtimeAllInOne = null;
        startAllInOneListener().catch(console.error);
      }
    }

    // responseStyle 变更时，若 allInOne 正在运行需用新设置重建实例，
    // 否则旧实例仍持有旧的 systemPrompt 和 responseStyle，导致输出格式与 UI 显示不匹配。
    if ('responseStyle' in partial && partial.responseStyle !== before.responseStyle && updated.useRealtimeAllInOne) {
      realtimeAllInOne?.stop();
      realtimeAllInOne = null;
      if (updated.listening) {
        startAllInOneListener().catch(console.error);
      }
    }

    // 录音设备变更时，停掉所有当前监听实例，下次开始时用新设备重建。
    if ('audioDeviceId' in partial && partial.audioDeviceId !== before.audioDeviceId) {
      realtimeAllInOne?.stop();
      realtimeAllInOne = null;
      realtimeTranscriber?.stop();
      realtimeTranscriber = null;
      audioListener?.stop();
      audioListener = null;
      if (updated.listening) {
        const provider2 = updated.apiProvider ?? 'openai';
        if (updated.useRealtimeAllInOne && provider2 === 'openai') {
          startAllInOneListener().catch(console.error);
        } else if (updated.useRealtimeAsr && provider2 === 'openai') {
          startRealtimeListener().catch(console.error);
        } else {
          getSegmentListener().start();
        }
      }
    }

    // 窗口透明度变更：立即更新主窗口
    if ('windowOpacity' in partial && typeof updated.windowOpacity === 'number' && mainWindow) {
      mainWindow.setOpacity(updated.windowOpacity);
    }

    return updated;
  });
  ipcMain.handle('settings:hasApiKey', async (_e, provider?: ApiProvider) => {
    return hasApiKey(provider);
  });
  ipcMain.handle('settings:getApiKey', async (_e, provider?: ApiProvider) => {
    const k = await getApiKey(provider);
    return k ?? '';
  });
  ipcMain.handle('settings:setApiKey', async (_e, key: string) => {
    await saveApiKey(key);
  });
  ipcMain.handle('settings:saveApiKeyForProvider', async (_e, provider: ApiProvider, value: string) => {
    await saveApiKeyForProvider(provider, value);
  });
  ipcMain.handle('settings:clearApiKey', async (_e, provider?: ApiProvider) => {
    await clearApiKey(provider);
  });
  ipcMain.handle('settings:testConnection', async (_e, provider: ApiProvider, model?: string) => {
    const settings = getSettings();
    const keyOrUrl = await getApiKey(provider);
    const effectiveModel = model ?? settings.model;
    if (!keyOrUrl?.trim()) return { ok: false, error: '请先保存 Key 或 Ollama 地址' };
    if (provider === 'ollama') return testConnectionOllama(keyOrUrl);
    if (provider === 'google') return testConnectionGemini(keyOrUrl);
    return testConnectionOpenAICompatible(keyOrUrl, getOpenAICompatibleBaseUrl(provider) ?? undefined, effectiveModel);
  });
  ipcMain.handle('settings:getDefaultModel', (_e, provider: ApiProvider) => DEFAULT_MODEL_BY_PROVIDER[provider]);

  ipcMain.handle('settings:regenerateSystemPrompt', async () => {
    const settings = getSettings();
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');

    // 一键流程：
    // 1）并行分析当前所有已上传文件（Resume / JD / Notes），生成结构化 JSON + 摘要
    // 2）基于最新 Context 摘要生成个性化 System Prompt

    const files = getContextFiles();
    const tAll0 = Date.now();
    console.log(`[RAG-TIME] regenerateSystemPrompt: 开始分析 ${files.length} 个文件用于生成个性化 Prompt`);

    const docOrder = (dt: ContextDocType | undefined): number => {
      if (dt === 'job_description') return 0;
      if (dt === 'resume') return 1;
      return 2;
    };
    const sorted = [...files].sort(
      (a, b) => docOrder((a as { docType?: ContextDocType }).docType) - docOrder((b as { docType?: ContextDocType }).docType)
    );

    /** 先分析完的 JD 结构化 JSON，分析简历时传入以选 top4 相关经历 */
    const jdStructuredChunks: string[] = [];

    for (const f of sorted) {
      const { id, label, docType, rawText } = f as {
        id: string;
        label: string;
        docType: ContextDocType;
        rawText?: string;
      };
      const t0 = Date.now();
      console.log(`[RAG-TIME] [regen] 开始分析文件 ${f.fileName} (label=${label}, docType=${docType})`);
      try {
        const jdMerged =
          docType === 'resume' && jdStructuredChunks.length > 0
            ? jdStructuredChunks.join('\n\n')
            : undefined;
        const analysis = await analyzeDocumentForRag(docType, rawText ?? '', {
          ...(docType === 'resume' ? { jdStructuredJson: jdMerged } : {})
        });
        const t1 = Date.now();
        console.log(`[RAG-TIME] [regen] analyzeDocumentForRag 完成 (${f.fileName}) +${t1 - t0}ms`);

        updateContextFileSummary(id, analysis.summary);
        if (analysis.structured) {
          setStructuredContext(label as ContextLabel, analysis.structured);
        }
        if (docType === 'job_description' && analysis.structured?.trim()) {
          jdStructuredChunks.push(analysis.structured.trim());
        }
        markContextFileRagIndexed(id);
        mainWindow?.webContents.send('context:updated');
        const t2 = Date.now();
        console.log(`[RAG-TIME] [regen] 写入 summary/structured & 标记完成 (${f.fileName}) +${t2 - t1}ms, 文件总耗时 +${t2 - t0}ms`);
      } catch (err) {
        console.error('[RAG] [regen] analyze error for file', f.fileName, err);
      }
    }

    const tAll1 = Date.now();
    console.log(`[RAG-TIME] regenerateSystemPrompt: 所有文件分析完成，总耗时 +${tAll1 - tAll0}ms`);

    // 更新 settings.systemPrompt 中的个性化身份行（资料库内「根据资料优化」亦调用此接口）。
    const contextSummary = getContextSummary();
    const newPrompt = await generateCustomSystemPrompt(
      apiKey,
      settings.model,
      settings.systemPrompt,
      contextSummary,
      getOpenAICompatibleBaseUrl(settings.apiProvider ?? 'openai') ?? undefined
    );

    const updated = updateSettings({ systemPrompt: newPrompt });
    return updated.systemPrompt;
  });

  // ─────────────────────────────────────────────
  // 组会模式：文档分析 + 索引建立（全量 RAG 管线）
  // ─────────────────────────────────────────────
  ipcMain.handle('meeting:analyzeDocuments', async () => {
    const apiKey = await getApiKey('openai');
    if (!apiKey) throw new Error('NO_API_KEY');

    const files = getContextFiles().filter(f => (f as any).docType === 'meeting_doc');
    if (files.length === 0) throw new Error('NO_MEETING_DOCS');

    const tAll0 = Date.now();
    console.log(`[Meeting-RAG] 开始分析 ${files.length} 个组会文档`);

    let analyzedCount = 0;

    for (const f of files) {
      const t0 = Date.now();
      console.log(`[Meeting-RAG] 分析文件: ${f.fileName}`);
      try {
        // Step 1: LLM 深度分析文档，提取摘要 + Q&A + 章节结构
        const analysis = await analyzeDocumentForRag('meeting_doc', f.rawText ?? '');
        console.log(`[Meeting-RAG] LLM 分析完成 +${Date.now() - t0}ms`);

        updateContextFileSummary(f.id, analysis.summary);

        let structuredObj: any = null;
        if (analysis.structured) {
          try {
            structuredObj = JSON.parse(analysis.structured);
            addStructuredDoc(f.id, 'meeting_doc', structuredObj);
          } catch {}
        }

        // Step 2: 语义分块（markdown-aware）
        const rawChunks = generateSemanticChunks('meeting_doc', f.id, f.rawText ?? '', structuredObj);
        console.log(`[Meeting-RAG] 生成 ${rawChunks.length} 个语义块`);

        // Step 3: 为每个 chunk 生成 embedding 向量
        const chunkEmbeds: ChunkEmbedding[] = [];
        for (const chunk of rawChunks) {
          const chunkId = uuidv4();
          chunk.id = chunkId;
          const emb = await createEmbedding(chunk.text);
          if (emb) {
            chunkEmbeds.push({
              chunkId,
              docId: f.id,
              docType: 'meeting_doc',
              section: chunk.section,
              embedding: emb
            });
          }
        }
        console.log(`[Meeting-RAG] 向量化完成：${chunkEmbeds.length}/${rawChunks.length} 块`);

        // Step 4: 持久化
        addSemanticChunks(f.id, rawChunks);
        addChunkEmbeddings(chunkEmbeds);
        markContextFileRagIndexed(f.id);
        analyzedCount++;

        mainWindow?.webContents.send('context:updated');
        console.log(`[Meeting-RAG] 文件 ${f.fileName} 完成，总耗时 +${Date.now() - t0}ms`);
      } catch (err) {
        console.error('[Meeting-RAG] 分析失败:', f.fileName, err);
      }
    }

    console.log(`[Meeting-RAG] 全部完成，共 ${analyzedCount}/${files.length} 个文件，耗时 +${Date.now() - tAll0}ms`);
    return { analyzed: analyzedCount, total: files.length };
  });

  // 组会模式：清空文档与索引
  ipcMain.handle('meeting:clearDocuments', async () => {
    clearDocsByType('meeting_doc');
    clearChunkEmbeddingsByDocType('meeting_doc');
    mainWindow?.webContents.send('context:updated');
    return { ok: true };
  });

  // Audio devices
  ipcMain.handle('audio:getAutoDeviceName', () => {
    if (process.platform === 'win32') return 'System Audio (Automatic)';
    return autoDetectLoopbackDeviceId()?.name ?? null;
  });

  ipcMain.handle('audio:openSystemSoundSettings', () => {
    if (process.platform !== 'win32') return;
    const { exec } = require('node:child_process');
    exec('start ms-settings:sound', () => {});
  });

  ipcMain.handle('audio:getInputDevices', () => {
    try {
      if (process.platform === 'win32') {
        const all = portAudio.getDevices() as {
          id: number;
          name: string;
          maxInputChannels: number;
          hostAPIName: string;
        }[];
        const inputDevices = all.filter(d => d.maxInputChannels > 0);
        const mmeDevices = inputDevices.filter(d => d.hostAPIName === 'MME');
        const rest = mmeDevices.length > 0 ? mmeDevices : inputDevices;

        // 额外提供一个「系统默认话筒（测试用）」选项：选取当前列表里的第一个输入设备作为默认话筒。
        const defaultMic = rest[0] ?? inputDevices[0];

        const devices: { id: number; name: string }[] = [];
        // -1 始终表示系统播放（WASAPI 环回），保持原有行为不变
        devices.push({ id: -1, name: 'System Audio (Automatic)' });
        if (defaultMic) {
          devices.push({ id: defaultMic.id, name: 'Microphone (System Default)' });
        }
        // 其余设备照常枚举，去重已作为默认话筒的那一项
        devices.push(
          ...rest
            .filter(d => !defaultMic || d.id !== defaultMic.id)
            .map(d => ({ id: d.id, name: fixDeviceName(d.name) }))
        );
        return devices;
      }
      const all = portAudio.getDevices() as {
        id: number;
        name: string;
        maxInputChannels: number;
        hostAPIName: string;
      }[];
      const inputDevices = all.filter(d => d.maxInputChannels > 0);
      const loopbacks = inputDevices.filter(d => fixDeviceName(d.name).includes('[Loopback]'));
      const mmeDevices = inputDevices.filter(d => d.hostAPIName === 'MME' && !fixDeviceName(d.name).includes('[Loopback]'));
      const rest = mmeDevices.length > 0 ? mmeDevices : inputDevices.filter(d => !fixDeviceName(d.name).includes('[Loopback]'));
      const result = [...loopbacks, ...rest];
      return result.map(d => ({ id: d.id, name: fixDeviceName(d.name) }));
    } catch {
      return [];
    }
  });

  // 当前卡片「显示可读答案」：根据问题生成可读格式（一句+展开）
  // 若从极简切换可传 contextFromConcise，则 prompt 会要求展开回答基于该思路，且前端可只展示展开块
  // options.persistToLog === false：仅预取展示用，不写 answerSummaries / 会话实录；用户点击「可读答案」时再 persistExpandedFromCard
  ipcMain.handle(
    'assist:getReadableAnswer',
    async (
      _e,
      questionZh: string,
      contextFromConcise?: { concise_answer_en: string; keywords_en?: string[] },
      options?: { persistToLog?: boolean }
    ) => {
    const q = questionZh.trim();
    const persistToLog = options?.persistToLog !== false;
    console.log('[ReadableAnswer] question_raw =', q, 'persistToLog =', persistToLog);

    // 演示答案库：若问题与库中某条匹配，直接返回预置可读答案
    const demoEntry = getMatchingDemoEntry(q);
    if (demoEntry) {
      const readable = demoEntryToReadableJSON(demoEntry);
      const out = {
        question_zh: readable.question_zh,
        concise_answer_en: readable.concise_answer_en,
        expanded_answer_en: readable.expanded_answer_en
      };
      if (persistToLog) {
        persistReadableExpandedToSummary(q, contextFromConcise, {
          concise_answer_en: contextFromConcise?.concise_answer_en?.trim() || out.concise_answer_en,
          expanded_answer_en: out.expanded_answer_en
        });
      }
      return out;
    }

    const settings = getSettings();
    const provider = settings.apiProvider ?? 'openai';
    const apiKey = await getApiKey();
    if (!apiKey && provider !== 'ollama') return { question_zh: questionZh, concise_answer_en: '', expanded_answer_en: '' };
    if (provider === 'ollama' && !settings.ollamaBaseUrl?.trim()) return { question_zh: questionZh, concise_answer_en: '', expanded_answer_en: '' };
    const contextSummary = getContextSummary();
    const questionsHistory = getQuestionHistory();
    const structured = getStructuredContext();

    const appendConciseContext = (content: string): string => {
      if (!contextFromConcise?.concise_answer_en) return content;
      const kw = contextFromConcise.keywords_en?.length
        ? `\nKeywords (for reference): ${contextFromConcise.keywords_en.join(', ')}`
        : '';
      return content + `

[当前极简卡片已说出的一句回答（展开时请勿复述或改写这句）]
一句回答：${contextFromConcise.concise_answer_en}${kw}

展开规则（expanded_answer_en）：
- 假定上述一句已说完，不要重复或复述该句。
- 直接按该句中的逻辑视角顺序展开，使用自然过渡语：如 "To be specific,", "From the data perspective,", "From the model perspective,", "In practice,", "More concretely,"。
- 对句中提到的具体技术做简要解释，可补充实现细节、权衡或注意点；语气自然、适合现场面试。
- expanded_answer_en 只输出展开内容；concise_answer_en 照抄上面一句回答。`;
    };

    try {
      const useRealtime = (settings.useRealtimeAsr || settings.useRealtimeAllInOne) && provider === 'openai';
      let out: { question_zh: string; concise_answer_en: string; expanded_answer_en: string };

      if (useRealtime && !settings.mockLlm && apiKey) {
        let instructions = buildSystemContent(
          buildReadableSystemPrompt(settings.systemPrompt),
          contextSummary,
          questionsHistory,
          q,
          structured,
          getAnswerSummaries()
        );
        instructions = appendConciseContext(instructions);
        const result = await generateReadableAnswerViaRealtime(apiKey, 'gpt-4o-mini-realtime-preview', instructions, q);
        out = {
          question_zh: result.question_zh ?? questionZh,
          concise_answer_en: result.concise_answer_en ?? '',
          expanded_answer_en: result.expanded_answer_en ?? ''
        };
      } else if (provider === 'ollama') {
        const result = await generateAssistOllama(
          settings.ollamaBaseUrl!.trim(),
          settings.model,
          settings.systemPrompt,
          contextSummary,
          questionsHistory,
          q,
          'readable'
        ) as import('./types').ReadableAssistJSON;
        out = {
          question_zh: result.question_zh ?? questionZh,
          concise_answer_en: result.concise_answer_en ?? '',
          expanded_answer_en: result.expanded_answer_en ?? ''
        };
      } else if (provider === 'google') {
        const result = await generateAssistGemini(apiKey!, settings.model, settings.systemPrompt, contextSummary, questionsHistory, q, 'readable') as import('./types').ReadableAssistJSON;
        out = {
          question_zh: result.question_zh ?? questionZh,
          concise_answer_en: result.concise_answer_en ?? '',
          expanded_answer_en: result.expanded_answer_en ?? ''
        };
      } else {
        // OpenAI 兼容：可注入极简上下文，用预构建 content 调用
        let content = buildSystemContent(
          buildReadableSystemPrompt(settings.systemPrompt),
          contextSummary,
          questionsHistory,
          q,
          structured,
          getAnswerSummaries()
        );
        content = appendConciseContext(content);
        const result = await generateReadableAnswerWithContent(
          apiKey!,
          settings.model,
          content,
          getOpenAICompatibleBaseUrl(provider) ?? undefined
        );
        out = {
          question_zh: result.question_zh ?? questionZh,
          concise_answer_en: result.concise_answer_en ?? '',
          expanded_answer_en: result.expanded_answer_en ?? ''
        };
      }

      if (persistToLog) {
        persistReadableExpandedToSummary(q, contextFromConcise, {
          concise_answer_en: contextFromConcise?.concise_answer_en?.trim() || out.concise_answer_en,
          expanded_answer_en: out.expanded_answer_en
        });
      }
      return out;
    } catch (err) {
      console.error('getReadableAnswer error', err);
      return { question_zh: questionZh, concise_answer_en: '', expanded_answer_en: '' };
    }
  }
  );

  /** 用户点击「可读答案」时：把当前卡片上的极简一句 + 展开写入导出与会话摘要（与界面图1+图2一致） */
  ipcMain.handle(
    'assist:persistExpandedFromCard',
    (
      _e,
      payload: {
        question_zh: string;
        concise_answer_en: string;
        expanded_answer_en: string;
        keywords_en?: string[];
      }
    ) => {
      const q = (payload.question_zh ?? '').trim();
      const conc = (payload.concise_answer_en ?? '').trim();
      const exp = (payload.expanded_answer_en ?? '').trim();
      if (!q || !conc || !exp || isNoiseOrUnrecognizedQuestionZh(q)) return;
      const ctx = {
        concise_answer_en: conc,
        ...(Array.isArray(payload.keywords_en) && payload.keywords_en.length
          ? { keywords_en: payload.keywords_en }
          : {})
      };
      persistReadableExpandedToSummary(q, ctx, {
        concise_answer_en: conc,
        expanded_answer_en: exp
      });
    }
  );

  // Context
  ipcMain.handle('context:getFiles', () => getContextFiles());
  ipcMain.handle('context:clear', () => {
    clearContextFiles();
  });
  ipcMain.handle('context:clearHistory', () => { clearQuestionHistory(); });

  ipcMain.handle('dialog:pickContextFile', async () => {
    if (!mainWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择上下文文件（TXT / PDF / DOCX）',
      properties: ['openFile'],
      filters: [
        { name: '文本和文档', extensions: ['txt', 'pdf', 'docx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths[0]) return null;
    return filePaths[0];
  });

  ipcMain.handle(
    'context:addFile',
    async (_e, payload: { filePath: string; label: 'JD' | 'Resume' | 'Notes' | 'Doc' }) => {
      const { filePath, label } = payload;
      const ext = path.extname(filePath).toLowerCase();
      let text = '';

      if (ext === '.txt' || ext === '.md') {
        text = fs.readFileSync(filePath, 'utf-8');
      } else if (ext === '.pdf') {
        const data = await pdfParse(fs.readFileSync(filePath));
        text = data.text || '';
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value || '';
      } else {
        throw new Error('不支持的文件类型：' + ext);
      }

      const fileName = path.basename(filePath);
      // 'Doc' 标签直接映射为 meeting_doc，跳过启发式分类器
      const docType = label === 'Doc' ? 'meeting_doc' : classifyDocumentType(label, text);
      const ctxFile = addContextFile(fileName, label, text, docType);
      // 上传阶段只做本地解析与轻量分类，不再立刻调用 LLM。
      // 是否进行结构化分析，改由「根据资料自动优化 System Prompt」按钮统一触发。
      mainWindow?.webContents.send('context:updated');
      return ctxFile;
    }
  );

  // Listener
  ipcMain.handle('listener:start', async () => {
    const settings = getSettings();
    const provider = settings.apiProvider ?? 'openai';
    // Realtime 仅 OpenAI 支持；其它服务商走段式 Whisper + 当前 LLM
    if (settings.useRealtimeAllInOne && provider === 'openai') {
      await startAllInOneListener();
    } else if (settings.useRealtimeAsr && provider === 'openai') {
      await startRealtimeListener();
    } else {
      getSegmentListener().start();
    }

    const s = updateSettings({ listening: true });
    return { listening: s.listening } satisfies ListenerStatus;
  });

  ipcMain.handle('listener:stop', async () => {
    const settings = getSettings();

    if (settings.useRealtimeAllInOne) {
      // 卡片弹出时只停音频，不关 WebSocket（让模型把当前回复输完）
      stopAllInOneListener(true);
    } else if (settings.useRealtimeAsr) {
      stopRealtimeListener();
    } else if (audioListener) {
      audioListener.stop();
    }

    clearBuffer();
    const s = updateSettings({ listening: false });
    return { listening: s.listening } satisfies ListenerStatus;
  });

  ipcMain.handle('listener:toggle', async () => {
    const settings = getSettings();
    const current = settings.listening;

    if (current) {
      if (settings.useRealtimeAllInOne) {
        stopAllInOneListener(false);
      } else if (settings.useRealtimeAsr) {
        stopRealtimeListener();
      } else if (audioListener) {
        audioListener.stop();
      }
      clearBuffer();
      const s = updateSettings({ listening: false });
      return { listening: s.listening } satisfies ListenerStatus;
    } else {
      const provider = settings.apiProvider ?? 'openai';
      if (settings.useRealtimeAllInOne && provider === 'openai') {
        await startAllInOneListener();
      } else if (settings.useRealtimeAsr && provider === 'openai') {
        await startRealtimeListener();
      } else {
        getSegmentListener().start();
      }
      const s = updateSettings({ listening: true });
      return { listening: s.listening } satisfies ListenerStatus;
    }
  });

  ipcMain.handle('listener:status', async () => {
    return { listening: getSettings().listening } satisfies ListenerStatus;
  });

  ipcMain.handle('screenshot:answer', async () => answerFromScreenshot());

  // Window show / hide
  ipcMain.handle('window:hide', () => {
    mainWindow?.hide();
  });
  ipcMain.handle('window:show', () => {
    mainWindow?.show();
  });

  ipcMain.handle('interview:exportSessionPdf', async () => {
    try {
      return await exportSessionInterviewToPdf(mainWindow);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[interview:exportSessionPdf]', e);
      return { ok: false, error: msg || '导出失败' };
    }
  });

  /** 仅生成临时 PDF（不弹窗），供渲染进程显示「导出中」后再 finalize */
  ipcMain.handle('interview:prepareSessionExportPdf', async () => {
    try {
      return await prepareSessionInterviewExportPdf();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[interview:prepareSessionExportPdf]', e);
      return { ok: false, error: msg || '导出失败' } as const;
    }
  });

  ipcMain.handle('interview:finalizeSessionExportPdf', async (_evt, tempPdfPath: unknown) => {
    try {
      if (typeof tempPdfPath !== 'string' || !tempPdfPath.trim()) {
        return { ok: false, error: '无效的临时路径' };
      }
      return await finalizeSessionInterviewExportPdf(mainWindow, tempPdfPath.trim());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[interview:finalizeSessionExportPdf]', e);
      return { ok: false, error: msg || '保存失败' };
    }
  });

  // Quit app completely（用于右上角关闭按钮）
  ipcMain.handle('app:quit', () => {
    audioListener?.stop();
    realtimeTranscriber?.stop();
    realtimeAllInOne?.stop();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    mainWindow?.destroy();
    app.quit();
  });
}

// ─────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';

  // 每次启动都视为「未在监听」，需用户主动点击开始监听；同时清空上一轮的提问历史，避免旧问题残留干扰上下文。
  updateSettings({ listening: false });
  clearQuestionHistory();
  clearAnswerSummaries();
  clearSessionInterviewLog();

  registerIpcHandlers();
  if (process.platform === 'darwin') registerMacIpcHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    audioListener?.stop();
    realtimeTranscriber?.stop();
    realtimeAllInOne?.stop();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    app.quit();
  }
});

app.on('before-quit', () => {
  clearSessionInterviewLog();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});
