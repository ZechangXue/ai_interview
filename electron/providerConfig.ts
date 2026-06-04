/**
 * 多 API 服务商配置：默认模型、OpenAI 兼容 baseURL、Realtime 模型名
 */
import type { ApiProvider } from './types';

/** 各服务商「instant」档默认模型（对应 gpt-4.1-mini 的快速模型） */
export const DEFAULT_MODEL_BY_PROVIDER: Record<ApiProvider, string> = {
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
  qwen: 'qwen-turbo',
  ollama: 'llama3.2'
};

/** OpenAI 兼容 API 的 baseURL（OpenAI 用默认即可） */
export function getOpenAICompatibleBaseUrl(provider: ApiProvider): string | undefined {
  switch (provider) {
    case 'openai':
      return undefined;
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    default:
      return undefined;
  }
}

/** 是否使用 OpenAI SDK（同一套 chat completions） */
export function isOpenAICompatible(provider: ApiProvider): boolean {
  return provider === 'openai' || provider === 'deepseek' || provider === 'qwen';
}

/** 当前仅 OpenAI 支持 Realtime 语音；其它服务商勾选 Realtime 时用流式 Chat 等效 */
export function getRealtimeModelOrNull(provider: ApiProvider): string | null {
  if (provider === 'openai') return 'gpt-realtime-mini';
  return null;
}
