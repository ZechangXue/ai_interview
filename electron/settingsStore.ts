import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import keytar from 'keytar';
import { SKIP_TURN_QUESTION_ZH, type Settings, type ResponseStyle, type ApiProvider } from './types';

const SERVICE_NAME = 'InterviewTeleprompterAI';
const ACCOUNT_API_KEY = 'openai_api_key'; // 兼容旧版；新 key 存 openai_api_key

function keytarAccount(provider: ApiProvider): string {
  if (provider === 'ollama') return '';
  return `${provider}_api_key`;
}

const DEFAULT_SYSTEM_PROMPT = `
你是“面试实时提词器助手”。你必须扮演一名非常专业、非常匹配目标岗位的候选者。你只会接收到：岗位JD摘要、候选人简历摘要、以及对方刚刚提出的面试问题（来自系统音频转写）。你不会得到候选人真实回答内容，因此你必须仅基于：JD/简历/历史提问 来给出“回答思路与英文关键词”。
强制输出格式：你必须只输出 JSON，且严格符合以下字段：
{
  "question_zh": string,
  "thinking_zh": string,
  "keywords_en": string[]
}
规则：
- question_zh：用中文提炼问题核心，1句，不能冗长
- thinking_zh：用中文写 2-3 条要点，每条尽量短（不写长段落），让候选人按这些要点展开就能完整回答
- keywords_en：与 thinking_zh 严格一一对应且顺序一致：第 1 个关键词对应第 1 条思路、第 2 个对应第 2 条，以此类推；每条思路只提炼 1 个英文关键词/短语作为「采分点」；必须是面试官想听到的核心答题词（如 data drift、model fine-tuning），不要写泛泛话题词（如 LLM、RAG）；先写 thinking_zh，再按同一顺序写出 keywords_en，数量=思路条数，便于候选人按点作答、思绪不乱
- 不要输出任何多余解释、前后缀、markdown、代码块；必须是纯 JSON
- 不要让候选人去“澄清/重复/确认问题”，不要把回答思路写成让对方补充信息的提示。
- 仅当 question_raw 明显是纯噪声、乱码、与自然语言无关、听不出任何面试意图时：question_zh 必须恰好为「${SKIP_TURN_QUESTION_ZH}」（应用会静默丢弃该轮，不弹卡、继续听）。只要有可辨认的面试问题或片段，就必须正常提炼并作答，不得使用上述占位。
`.trim();

const DEFAULT_SETTINGS: Settings = {
  apiProvider: 'openai',
  model: 'gpt-4.1-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  mockAsr: false,
  mockLlm: false,
  listening: false,
  useRealtimeAsr: false,
  useStreamingLlm: true,
  /** 默认：GPT-4o Realtime 一体（音频直进模型）；与 useRealtimeAsr 互斥 */
  useRealtimeAllInOne: true,
  responseStyle: 'concise' as ResponseStyle,
  audioDeviceId: -1,
  windowOpacity: 0.95,
  ollamaBaseUrl: 'http://localhost:11434',
  /** 默认开启：下一题自动关旧卡并继续听 */
  autoDismissCardOnNewQuestion: true,
  meetingMode: false,
  answerLanguage: 'en' as const
};

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function readSettingsFile(): Partial<Settings> {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettingsFile(settings: Settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (!cachedSettings) {
    const fileSettings = readSettingsFile();
    cachedSettings = { ...DEFAULT_SETTINGS, ...fileSettings };
    if ((cachedSettings as any).apiProvider == null) (cachedSettings as any).apiProvider = 'openai';
    if ((cachedSettings as any).windowOpacity == null) (cachedSettings as any).windowOpacity = DEFAULT_SETTINGS.windowOpacity;
    if ((cachedSettings as any).ollamaBaseUrl == null) (cachedSettings as any).ollamaBaseUrl = DEFAULT_SETTINGS.ollamaBaseUrl;
    if ((cachedSettings as any).autoDismissCardOnNewQuestion == null) {
      (cachedSettings as any).autoDismissCardOnNewQuestion = DEFAULT_SETTINGS.autoDismissCardOnNewQuestion;
    }
    if (cachedSettings.model === 'instant') {
      cachedSettings.model = 'gpt-4.1-mini';
      writeSettingsFile(cachedSettings);
    }
    // 流式输出已固定开启，设置页不再提供开关
    cachedSettings.useStreamingLlm = true;
  }
  return cachedSettings;
}

export function updateSettings(partial: Partial<Settings>): Settings {
  const merged = { ...getSettings(), ...partial, useStreamingLlm: true };
  cachedSettings = merged;
  writeSettingsFile(merged);
  return merged;
}

/** 按服务商保存 Key（Ollama 为 base URL，写入 settings） */
export async function saveApiKeyForProvider(provider: ApiProvider, value: string): Promise<void> {
  if (provider === 'ollama') {
    updateSettings({ ollamaBaseUrl: value.trim() });
    return;
  }
  const account = keytarAccount(provider);
  if (account) await keytar.setPassword(SERVICE_NAME, account, value);
}

/** 当前选中服务商的 Key 或 Ollama URL；兼容旧版（仅 openai 时读 openai_api_key 或旧 key） */
export async function getApiKey(provider?: ApiProvider): Promise<string | null> {
  const p = provider ?? getSettings().apiProvider;
  if (p === 'ollama') return getSettings().ollamaBaseUrl?.trim() || null;
  const account = keytarAccount(p);
  if (!account) return null;
  let key = await keytar.getPassword(SERVICE_NAME, account);
  if (p === 'openai' && !key) key = await keytar.getPassword(SERVICE_NAME, ACCOUNT_API_KEY);
  return key || null;
}

/** 是否有当前（或指定）服务商的 Key / Ollama 地址 */
export async function hasApiKey(provider?: ApiProvider): Promise<boolean> {
  const k = await getApiKey(provider);
  return !!k?.trim();
}

/** 兼容旧 API：保存到当前选中服务商 */
export async function saveApiKey(apiKey: string): Promise<void> {
  await saveApiKeyForProvider(getSettings().apiProvider, apiKey);
}

export async function clearApiKey(provider?: ApiProvider): Promise<void> {
  const p = provider ?? getSettings().apiProvider;
  if (p === 'ollama') {
    updateSettings({ ollamaBaseUrl: '' });
    return;
  }
  const account = keytarAccount(p);
  if (account) await keytar.deletePassword(SERVICE_NAME, account);
  if (p === 'openai') await keytar.deletePassword(SERVICE_NAME, ACCOUNT_API_KEY);
}

