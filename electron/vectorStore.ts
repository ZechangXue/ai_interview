import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextDocType } from './types';

export interface ChunkEmbedding {
  chunkId: string;
  docId: string;
  docType: ContextDocType;
  section: string;
  embedding: number[];
}

interface EmbeddingStoreData {
  chunkEmbeddings: ChunkEmbedding[];
}

const EMBEDDING_FILE = path.join(app.getPath('userData'), 'embeddings.json');

let cache: EmbeddingStoreData | null = null;

function readFile(): EmbeddingStoreData {
  try {
    const raw = fs.readFileSync(EMBEDDING_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as EmbeddingStoreData;
    if (!parsed.chunkEmbeddings) {
      return { chunkEmbeddings: [] };
    }
    return parsed;
  } catch {
    return { chunkEmbeddings: [] };
  }
}

function writeFile(data: EmbeddingStoreData) {
  fs.mkdirSync(path.dirname(EMBEDDING_FILE), { recursive: true });
  fs.writeFileSync(EMBEDDING_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureCache(): EmbeddingStoreData {
  if (!cache) cache = readFile();
  if (!cache.chunkEmbeddings) cache.chunkEmbeddings = [];
  return cache;
}

export function addChunkEmbeddings(embs: ChunkEmbedding[]): void {
  if (!embs.length) return;
  const data = ensureCache();
  data.chunkEmbeddings.push(...embs);
  writeFile(data);
}

export function clearChunkEmbeddingsByDocType(docType: ContextDocType): void {
  const data = ensureCache();
  data.chunkEmbeddings = data.chunkEmbeddings.filter(e => e.docType !== docType);
  writeFile(data);
}

export function searchSimilarChunks(
  queryEmbedding: number[],
  options: { docTypes?: ContextDocType[]; topK?: number } = {}
): ChunkEmbedding[] {
  const data = ensureCache();
  const { docTypes, topK = 5 } = options;

  const target = docTypes && docTypes.length
    ? data.chunkEmbeddings.filter(e => docTypes.includes(e.docType))
    : data.chunkEmbeddings;

  if (!queryEmbedding.length || !target.length) return [];

  const scored = target
    .map(e => ({
      embedding: e,
      score: cosineSimilarity(queryEmbedding, e.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => x.embedding);

  return scored;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

