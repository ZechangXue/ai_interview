import OpenAI from 'openai';
import { getApiKey } from './settingsStore';

// 统一的 embedding 生成函数，当前使用 OpenAI text-embedding-3-small。

let client: OpenAI | null = null;

async function getClient(): Promise<OpenAI | null> {
  const apiKey = await getApiKey('openai');
  if (!apiKey) return null;
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function createEmbedding(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const c = await getClient();
  if (!c) return null;

  const res = await c.embeddings.create({
    model: 'text-embedding-3-small',
    input: trimmed.slice(0, 2000)
  });

  const vec = res.data[0]?.embedding;
  return Array.isArray(vec) ? vec : null;
}

