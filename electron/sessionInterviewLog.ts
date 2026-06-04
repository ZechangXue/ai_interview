/**
 * 本次运行会话内的全部问答实录（不送入 LLM、不限条数）。
 * 启动与退出时清空；仅用于「一键导出」复盘。
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { isNoiseOrUnrecognizedQuestionZh } from './types';

export interface SessionInterviewEntry {
  ts: number;
  /** 面试官语音转写原文（Whisper 段式合并文本 / Realtime 输入转写） */
  interviewer_question_raw: string;
  /** 卡片上的中文题摘要（模型提炼，导出中可选对照） */
  question_zh: string;
  concise_answer_en: string;
  expanded_answer_en?: string;
  keywords_en?: string[];
}

const FILE_NAME = 'session_interview_log.json';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function readRaw(): { version: number; entries: SessionInterviewEntry[] } {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8');
    const data = JSON.parse(raw) as { version?: number; entries?: SessionInterviewEntry[] };
    if (!Array.isArray(data.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: data.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeRaw(data: { version: number; entries: SessionInterviewEntry[] }) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function clearSessionInterviewLog(): void {
  try {
    writeRaw({ version: 1, entries: [] });
  } catch (e) {
    console.warn('[SessionLog] clear failed', e);
  }
}

export function readSessionInterviewLog(): SessionInterviewEntry[] {
  const entries = readRaw().entries;
  return entries.map((e: any) => ({
    ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    interviewer_question_raw: typeof e.interviewer_question_raw === 'string' ? e.interviewer_question_raw : '',
    question_zh: typeof e.question_zh === 'string' ? e.question_zh : '',
    concise_answer_en: typeof e.concise_answer_en === 'string' ? e.concise_answer_en : '',
    ...(typeof e.expanded_answer_en === 'string' && e.expanded_answer_en.trim()
      ? { expanded_answer_en: e.expanded_answer_en.trim() }
      : {}),
    ...(Array.isArray(e.keywords_en) && e.keywords_en.length ? { keywords_en: e.keywords_en } : {})
  }));
}

export function appendSessionInterviewEntry(entry: Omit<SessionInterviewEntry, 'ts'> & { ts?: number }): void {
  const q = (entry.question_zh ?? '').trim();
  const raw = (entry.interviewer_question_raw ?? '').trim();
  const c = (entry.concise_answer_en ?? '').trim();
  if (!q || isNoiseOrUnrecognizedQuestionZh(q) || !c) return;

  const data = readRaw();
  const row: SessionInterviewEntry = {
    ts: entry.ts ?? Date.now(),
    interviewer_question_raw: raw,
    question_zh: q,
    concise_answer_en: c,
    ...(entry.expanded_answer_en?.trim() ? { expanded_answer_en: entry.expanded_answer_en.trim() } : {}),
    ...(Array.isArray(entry.keywords_en) && entry.keywords_en.length ? { keywords_en: entry.keywords_en } : {})
  };
  data.entries.push(row);
  writeRaw(data);
}

/** 为最近一次匹配 question 的记录补充展开（可读答案生成后） */
export function updateSessionInterviewExpanded(questionZh: string, expanded_answer_en: string): boolean {
  const exp = expanded_answer_en.trim();
  if (!exp) return false;
  const qn = questionZh.trim();
  if (!qn) return false;

  const data = readRaw();
  for (let i = data.entries.length - 1; i >= 0; i--) {
    if (data.entries[i].question_zh.trim() === qn) {
      data.entries[i] = { ...data.entries[i], expanded_answer_en: exp };
      writeRaw(data);
      return true;
    }
  }
  return false;
}
