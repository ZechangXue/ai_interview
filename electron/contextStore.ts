import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  ContextFile,
  ContextLabel,
  ContextSummary,
  ContextDocType,
  SemanticChunk,
  StructuredDocRecord,
  GeneratedQuestion,
  AnswerSummary
} from './types';

const CONTEXT_FILE = path.join(app.getPath('userData'), 'context.json');

interface ContextData {
  files: ContextFile[];
  questionsHistory: string[];
  /**
   * 旧版结构化数据：按 JD / Resume / Notes 聚合的一大段 JSON 字符串。
   * 为兼容旧版本逻辑仍然保留，但新增更细粒度的 structuredDocs / chunks / embeddings / generatedQuestions。
   */
  structured?: {
    jd: string;
    resume: string;
    notes: string;
  };
  /**
   * 新版结构化 JSON 文档记录（按 docId + docType 存储）。
   */
  structuredDocs?: StructuredDocRecord[];
  /**
   * 语义分块（section 级别），用于向量检索。
   */
  chunks?: SemanticChunk[];
  /**
   * 预生成的面试问题（及其向量），简单起见与 chunks 一样一起存到同一个 JSON 文件中。
   */
  generatedQuestions?: GeneratedQuestion[];
  /**
   * 最近极简回答摘要（只保留少量轮次，用于追问时提示）。
   */
  answerSummaries?: AnswerSummary[];
}

function readContextFile(): ContextData {
  try {
    const raw = fs.readFileSync(CONTEXT_FILE, 'utf-8');
    return JSON.parse(raw) as ContextData;
  } catch {
    return { files: [], questionsHistory: [], structured: { jd: '', resume: '', notes: '' } };
  }
}

function writeContextFile(data: ContextData) {
  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

let cache: ContextData | null = null;

function ensureCache(): ContextData {
  if (!cache) cache = readContextFile();
  if (!cache.structured) {
    cache.structured = { jd: '', resume: '', notes: '' };
  }
  if (!cache.structuredDocs) {
    cache.structuredDocs = [];
  }
  if (!cache.chunks) {
    cache.chunks = [];
  }
  if (!cache.generatedQuestions) {
    cache.generatedQuestions = [];
  }
  if (!cache.answerSummaries) {
    cache.answerSummaries = [];
  }
  return cache;
}

function mapLabelToDocType(label: ContextLabel): ContextDocType {
  if (label === 'Resume') return 'resume';
  if (label === 'JD') return 'job_description';
  if (label === 'Doc') return 'meeting_doc';
  // 旧的 Notes 可能包含 QA 或项目笔记，这里默认映射为 project_notes，后续由分类器细分。
  return 'project_notes';
}

export function addContextFile(
  fileName: string,
  label: ContextLabel,
  fullText: string,
  docType?: ContextDocType
): ContextFile {
  const data = ensureCache();
  const summary = summarize(fullText);
  const effectiveDocType = docType ?? mapLabelToDocType(label);
  const item: ContextFile = {
    id: uuidv4(),
    fileName,
    label,
    summary,
    createdAt: Date.now(),
    ragIndexed: false,
    rawText: fullText,
    docType: effectiveDocType,
    chunksIndexed: false
  };
  data.files.push(item);
  writeContextFile(data);
  return item;
}

export function getContextFiles(): ContextFile[] {
  return ensureCache().files;
}

export function clearContextFiles() {
  const data = ensureCache();
  data.files = [];
  // 同时清空聚合结构化 JSON，避免旧的 JD/Resume/Notes JSON 残留在 Prompt 中
  data.structured = { jd: '', resume: '', notes: '' };
  // 如后续重新启用 RAG，可视情况一并清理结构化文档/分块/预生成问题
  // data.structuredDocs = [];
  // data.chunks = [];
  // data.generatedQuestions = [];
  writeContextFile(data);
}

export function setContextFiles(files: ContextFile[]) {
  const data = ensureCache();
  data.files = files;
  writeContextFile(data);
}

export function getContextSummary(): ContextSummary {
  const files = getContextFiles();
  const jd = files
    .filter(f => f.label === 'JD')
    .map(f => f.summary)
    .join('\n\n');
  const resume = files
    .filter(f => f.label === 'Resume')
    .map(f => f.summary)
    .join('\n\n');
  const notes = files
    .filter(f => f.label === 'Notes')
    .map(f => f.summary)
    .join('\n\n');
  return { jd, resume, notes };
}

export function pushQuestionHistory(question: string) {
  const data = ensureCache();
  data.questionsHistory.push(question);
  // 只保留最近 3 个问题，符合典型面试追问场景
  if (data.questionsHistory.length > 3) {
    data.questionsHistory = data.questionsHistory.slice(-3);
  }
  writeContextFile(data);
}

export function getQuestionHistory(): string[] {
  return ensureCache().questionsHistory;
}

export function clearQuestionHistory() {
  const data = ensureCache();
  data.questionsHistory = [];
  writeContextFile(data);
}

export function clearAnswerSummaries() {
  const data = ensureCache();
  data.answerSummaries = [];
  writeContextFile(data);
}

// 追加一条极简回答摘要，最多保留最近 5 条
export function pushAnswerSummary(summary: AnswerSummary) {
  const data = ensureCache();
  // 若同一「问题+一句回答」已存在，先移除旧的，只保留最新的一条
  data.answerSummaries = (data.answerSummaries ?? []).filter(
    (s) =>
      !(
        (s.question_zh ?? '').trim() === summary.question_zh.trim() &&
        (s.concise_answer_en ?? '').trim() === summary.concise_answer_en.trim()
      )
  );
  data.answerSummaries!.push(summary);
  // 只保留最近 3 条极简回答摘要
  if (data.answerSummaries!.length > 3) {
    data.answerSummaries = data.answerSummaries!.slice(-3);
  }
  writeContextFile(data);
}

/**
 * 极简模式后用户拉了「可读/展开」时，把 expanded 写回同一条摘要（按问题中文匹配最近一条），
 * 便于 [CONVERSATION] 里同时有一句+展开。
 */
export function mergeExpandedIntoAnswerSummary(
  questionZh: string,
  expandedAnswerEn: string,
  conciseFallback?: string
): boolean {
  const exp = expandedAnswerEn.trim();
  if (!exp) return false;
  const data = ensureCache();
  const summaries = data.answerSummaries ?? [];
  const qNorm = questionZh.trim();
  let idx = -1;
  for (let i = summaries.length - 1; i >= 0; i--) {
    if ((summaries[i].question_zh ?? '').trim() === qNorm) {
      idx = i;
      break;
    }
  }
  const cNorm = conciseFallback?.trim() ?? '';
  if (idx < 0 && cNorm) {
    for (let i = summaries.length - 1; i >= 0; i--) {
      if ((summaries[i].concise_answer_en ?? '').trim() === cNorm) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return false;
  summaries[idx] = { ...summaries[idx], expanded_answer_en: exp };
  data.answerSummaries = summaries;
  writeContextFile(data);
  return true;
}

export function getAnswerSummaries(): AnswerSummary[] {
  return ensureCache().answerSummaries ?? [];
}

export function markContextFileRagIndexed(id: string) {
  const data = ensureCache();
  const target = data.files.find(f => f.id === id);
  if (target) {
    target.ragIndexed = true;
    writeContextFile(data);
  }
}

export function updateContextFileSummary(id: string, summary: string) {
  const data = ensureCache();
  const target = data.files.find(f => f.id === id);
  if (target) {
    target.summary = summary;
    writeContextFile(data);
  }
}

export function setStructuredContext(label: ContextLabel, structuredJson: string) {
  const data = ensureCache();
  if (!data.structured) data.structured = { jd: '', resume: '', notes: '' };
  if (label === 'JD') data.structured.jd = structuredJson;
  if (label === 'Resume') data.structured.resume = structuredJson;
  if (label === 'Notes') data.structured.notes = structuredJson;
  writeContextFile(data);
}

export function getStructuredContext(): { jd: string; resume: string; notes: string } {
  const data = ensureCache();
  if (!data.structured) return { jd: '', resume: '', notes: '' };
  return data.structured;
}

// ─────────────────────────────────────────────
// 新版结构化 JSON / Chunk / 预生成问题 存取
// ─────────────────────────────────────────────

export function addStructuredDoc(docId: string, docType: ContextDocType, json: any): StructuredDocRecord {
  const data = ensureCache();
  const record: StructuredDocRecord = {
    id: uuidv4(),
    docId,
    docType,
    json,
    createdAt: Date.now()
  };
  data.structuredDocs!.push(record);
  writeContextFile(data);
  return record;
}

export function getStructuredDocsByType(docType: ContextDocType): StructuredDocRecord[] {
  const data = ensureCache();
  return data.structuredDocs!.filter(d => d.docType === docType);
}

export function getStructuredDocForContextLabel(label: ContextLabel): StructuredDocRecord | undefined {
  const data = ensureCache();
  const docType = mapLabelToDocType(label);
  const files = data.files.filter(f => f.label === label);
  if (files.length === 0) return undefined;
  const docIds = new Set(files.map(f => f.id));
  return data.structuredDocs!.find(d => d.docType === docType && docIds.has(d.docId));
}

export function addSemanticChunks(docId: string, chunks: SemanticChunk[]): void {
  if (!chunks.length) return;
  const data = ensureCache();
  const now = Date.now();
  const withIds = chunks.map(chunk => ({
    ...chunk,
    id: chunk.id || uuidv4(),
    docId,
    createdAt: chunk.createdAt ?? now
  }));
  data.chunks!.push(...withIds);
  // 标记对应文件已完成分块
  const target = data.files.find(f => f.id === docId);
  if (target) {
    target.chunksIndexed = true;
  }
  writeContextFile(data);
}

export function getChunksByDocType(docType: ContextDocType): SemanticChunk[] {
  const data = ensureCache();
  return data.chunks!.filter(c => c.docType === docType);
}

export function addGeneratedQuestions(records: GeneratedQuestion[]): void {
  if (!records.length) return;
  const data = ensureCache();
  data.generatedQuestions!.push(...records);
  writeContextFile(data);
}

export function getGeneratedQuestionsByDocType(docType: ContextDocType): GeneratedQuestion[] {
  const data = ensureCache();
  return data.generatedQuestions!.filter(q => q.docType === docType);
}

/** 清理组会模式下指定 docType 的结构化数据（文件记录 / 分块 / 预生成问题） */
export function clearDocsByType(docType: ContextDocType): void {
  const data = ensureCache();
  data.files = data.files.filter(f => f.docType !== docType);
  data.structuredDocs = (data.structuredDocs ?? []).filter(d => d.docType !== docType);
  data.chunks = (data.chunks ?? []).filter(c => c.docType !== docType);
  data.generatedQuestions = (data.generatedQuestions ?? []).filter(q => q.docType !== docType);
  writeContextFile(data);
}

function summarize(text: string, maxChars: number = 2000): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars) + ' ...';
}

