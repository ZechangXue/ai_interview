/**
 * Demo answer library for product demonstrations.
 * When the user's question matches one of the library entries, the app returns
 * the pre-defined answer so demo recordings show consistent, polished content.
 * No UI logic is changed; only the data source is swapped for matched questions.
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { AssistJSON } from './types';
import type { ReadableAssistJSON } from './types';

export interface DemoLibraryEntry {
  id: string;
  question: string;
  question_zh: string;
  concise_answer: string;
  keywords: string[];
  readable_answer: string;
  /** 问题变式规则库：可能问的中英文表述，与用户输入重合率高于阈值即命中 */
  question_variants?: string[];
  /** 可选：卡片上展示的短问题（若存在则替代 question_zh 显示，避免长句占满） */
  question_zh_display?: string;
  /** 锚点短语：重合率匹配时，输入必须包含其中至少一个，避免无关问题被误命中 */
  anchor_phrases?: string[];
}

let cachedEntries: DemoLibraryEntry[] | null = null;

const LIBRARY_FILENAME = 'demoAnswerLibrary.json';

/** 按优先级尝试多个路径，开发/打包都能找到 JSON */
function getLibraryPath(): string {
  const candidates = [
    path.join(app.getAppPath(), LIBRARY_FILENAME),
    path.join(process.cwd(), LIBRARY_FILENAME),
    path.join(__dirname, '..', LIBRARY_FILENAME)
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return candidates[0];
}

/** 归一化：只保留字母、数字、CJK，去掉标点与空白 */
function normalizeForMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\w\u4e00-\u9fff]/g, '');
}

/** 重合率阈值：与任一变式的 token 重合率 >= 此值且通过锚点校验才视为命中 */
const OVERLAP_THRESHOLD = 0.6;

/**
 * 将字符串切为 token 集合（英文按词、中文按字），用于计算重合率
 */
function tokenize(normalized: string): Set<string> {
  const tokens = new Set<string>();
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (/[a-z0-9]/.test(c)) {
      let word = '';
      while (i < normalized.length && /[a-z0-9]/.test(normalized[i])) {
        word += normalized[i];
        i++;
      }
      if (word) tokens.add(word);
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(c)) {
      tokens.add(c);
      i++;
      continue;
    }
    i++;
  }
  return tokens;
}

/** 重合率 = |A ∩ B| / min(|A|, |B|)，取值 0～1 */
function overlapRatio(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  const smaller = tokensA.size <= tokensB.size ? tokensA : tokensB;
  const larger = tokensA.size > tokensB.size ? tokensA : tokensB;
  for (const t of smaller) {
    if (larger.has(t)) intersection++;
  }
  return intersection / smaller.size;
}

/** Load and cache the demo library. Returns empty array if file missing or invalid. */
export function loadDemoLibrary(): DemoLibraryEntry[] {
  if (cachedEntries !== null) return cachedEntries;
  const p = getLibraryPath();
  try {
    if (!fs.existsSync(p)) {
      console.log('[Demo] 演示库文件不存在:', p);
      cachedEntries = [];
      return cachedEntries;
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.log('[Demo] 演示库格式错误：非数组');
      cachedEntries = [];
      return cachedEntries;
    }
    cachedEntries = parsed.filter(
      (e): e is DemoLibraryEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof (e as DemoLibraryEntry).question_zh === 'string' &&
        typeof (e as DemoLibraryEntry).concise_answer === 'string'
    );
    console.log('[Demo] 演示库已加载:', p, '条目数:', cachedEntries.length);
    return cachedEntries;
  } catch (e) {
    console.warn('[Demo] 演示库加载失败:', p, e);
    cachedEntries = [];
    return cachedEntries;
  }
}

/**
 * 在规则库中查找与 input 匹配的条目。
 * 规则：对每条目的 question_variants（及 question / question_zh）做归一化后，
 * 与 input 的 token 重合率 >= OVERLAP_THRESHOLD 即命中；无 question_variants 时仍用子串包含判断。
 */
export function getMatchingDemoEntry(input: string): DemoLibraryEntry | null {
  const entries = loadDemoLibrary();
  if (entries.length === 0) return null;
  const rawInput = (input ?? '').trim();
  const normalizedInput = normalizeForMatch(rawInput);
  if (!normalizedInput) {
    console.log('[Demo] 匹配跳过：归一化后为空, input=', JSON.stringify(rawInput.slice(0, 80)));
    return null;
  }
  const inputTokens = tokenize(normalizedInput);
  if (inputTokens.size === 0) return null;

  for (const entry of entries) {
    const anchors = Array.isArray(entry.anchor_phrases) ? entry.anchor_phrases : [];
    const hasAnchor = anchors.length === 0 || anchors.some((a) => {
      const n = normalizeForMatch(a);
      return n && normalizedInput.includes(n);
    });

    const candidates: string[] = [
      entry.question_zh,
      entry.question,
      ...(Array.isArray(entry.question_variants) ? entry.question_variants : [])
    ];
    for (const variant of candidates) {
      if (!variant || typeof variant !== 'string') continue;
      const nVariant = normalizeForMatch(variant);
      if (!nVariant) continue;
      // 子串包含：直接命中（仍要求有锚点，否则长句可能误包无关短问）
      if (hasAnchor && (normalizedInput.includes(nVariant) || nVariant.includes(normalizedInput))) {
        console.log('[Demo] 命中(子串) entry=', entry.id, 'input=', JSON.stringify(rawInput.slice(0, 50)));
        return entry;
      }
      const variantTokens = tokenize(nVariant);
      if (variantTokens.size === 0) continue;
      const ratio = overlapRatio(inputTokens, variantTokens);
      if (hasAnchor && ratio >= OVERLAP_THRESHOLD) {
        console.log('[Demo] 命中(重合率)', entry.id, 'ratio=', ratio.toFixed(2), 'input=', JSON.stringify(rawInput.slice(0, 50)));
        return entry;
      }
    }
  }
  console.log('[Demo] 未命中 input=', JSON.stringify(rawInput.slice(0, 80)));
  return null;
}

/** Convert a demo entry to AssistJSON (concise card). 使用 question_zh_display 时卡片显示短问题。 */
export function demoEntryToAssistJSON(entry: DemoLibraryEntry): AssistJSON {
  return {
    question_zh: (entry.question_zh_display ?? entry.question_zh).trim(),
    concise_answer_en: entry.concise_answer,
    keywords_en: entry.keywords ?? [],
    thinking_zh: ''
  };
}

/** Convert a demo entry to ReadableAssistJSON (readable card). */
export function demoEntryToReadableJSON(entry: DemoLibraryEntry): ReadableAssistJSON {
  return {
    question_zh: (entry.question_zh_display ?? entry.question_zh).trim(),
    concise_answer_en: entry.concise_answer,
    expanded_answer_en: entry.readable_answer
  };
}
