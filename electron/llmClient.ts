import OpenAI from 'openai';
import type {
  AnswerSummary,
  AssistJSON,
  ReadableAssistJSON,
  AssistStreamChunk,
  ContextSummary,
  ResponseStyle,
  ApiProvider
} from './types';
import { SKIP_TURN_QUESTION_ZH } from './types';
import { getAnswerSummaries } from './contextStore';
import { prepareResumeJsonForPrompt } from './resumeJdRelevance';
import { isOpenAICompatible, getOpenAICompatibleBaseUrl } from './providerConfig';

/** 结构化上下文单段最大字符数（防超长简历撑爆上下文；截断处仍保留 JSON 前缀便于模型理解） */
const PROMPT_MAX_STRUCTURED: Record<'resume' | 'jd' | 'notes', number> = {
  resume: 14000,
  jd: 10000,
  notes: 8000
};

function capStructuredSection(raw: string | undefined, max: number): string {
  const s = (raw ?? '').trim();
  if (!s) return '(none)';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Realtime / 外部组装 prompt 时复用同一截断预算 */
export function capStructuredJsonForPrompt(
  raw: string | undefined,
  kind: keyof typeof PROMPT_MAX_STRUCTURED
): string {
  return capStructuredSection(raw, PROMPT_MAX_STRUCTURED[kind]);
}

// ─────────────────────────────────────────────
// Readable Answer Mode 系统提示（与 concise 一致：结构标签 + 单次 [OUTPUT]）
// ─────────────────────────────────────────────

export const READABLE_SYSTEM_PROMPT = `[ROLE]
Interview realtime prompter — answer as the candidate, interview-ready spoken English.

[TASK]
From the interviewer's question, answer using JD + resume context when relevant.

[STYLE]
Senior engineer; concrete; non-generic; ground claims in provided materials.

[OUTPUT]
JSON only (no markdown, no prose outside the object):
{
  "question_zh": string,
  "concise_answer_en": string,
  "expanded_answer_en": string
}
question_zh: 1 short Chinese line (core of the question).
concise_answer_en: 1 English sentence, direct, natural to read aloud.
expanded_answer_en: 3–4 English sentences with supporting detail, conversational. On elaborate follow-ups, add new substance vs the prior answer—avoid only paraphrasing the same bullets.
If input is clearly pure noise / gibberish / no interview question (not merely unclear audio), set question_zh exactly to "无法确定问题" and keep other fields minimal—the client will skip this turn silently. For any plausible interview question (including fragmented or accented audio), never use that string; give substantive answers.`.trim();

// ─────────────────────────────────────────────
// System prompt：去掉用户自带的重复「强制输出格式」块，再由本文件统一追加 [OUTPUT]。
// ─────────────────────────────────────────────

function stripLegacyFormatBlocks(userSystemPrompt: string): string {
  // 反复剥离，直到没有「━━━【强制输出格式…」块（用户可能粘贴了多段）
  const block =
    /━━━【强制输出格式[^】]*】━━━[\s\S]*?(?=\n━━━【|\s*━━━【|$)/gu;
  let s = userSystemPrompt;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(block, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return s;
}

function buildBaseInterviewPrompt(userSystemPrompt: string): string {
  const cleaned = stripLegacyFormatBlocks(userSystemPrompt).trim();
  return cleaned || userSystemPrompt.trim();
}

/** 曾写入 settings 的「展开式」稿首行标记；运行时只取身份行，实际发给 LLM 的拼接逻辑不变 */
const LEGACY_EXPANDED_PROMPT_MAGIC = '<<<EXPANDED_PROMPT_V1>>>';

/** 若用户 settings 里误存了旧版展开稿，只提取身份行参与 buildConcise/readable，避免改变之外的 prompt 逻辑 */
function normalizeUserSystemPromptForLlm(userSystemPrompt: string): string {
  if (!userSystemPrompt.includes(LEGACY_EXPANDED_PROMPT_MAGIC)) return userSystemPrompt;
  const lines = userSystemPrompt.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(LEGACY_EXPANDED_PROMPT_MAGIC));
  const afterFirst = lines.slice(idx + 1).find((l) => l.trim())?.trim() ?? '';
  return afterFirst || userSystemPrompt.trim();
}

/** 面试模式 [OUTPUT] 段（concise + expanded，两者一次性生成） */
export const CONCISE_JSON_OUTPUT_INNER = `JSON only (no markdown, no prose outside the object).
Fields (streaming client reads in generation order — follow exactly):
1) "question_zh" 2) "concise_answer_en" 3) "expanded_answer_en"
Example shape: {"question_zh":"…","concise_answer_en":"…","expanded_answer_en":"…"}
question_zh: 1 short Chinese line.
concise_answer_en: 1 English sentence; direct, senior engineer tone; do not restate the question.
expanded_answer_en: 3–4 English sentences; concrete detail, trade-offs, real examples. If a follow-up asks to elaborate, add new substance—do not only restate the prior answer's bullets.
Pure noise only → question_zh exactly "无法确定问题" (client skips silently). Otherwise substantive answer; never use that string for real questions.`.trim();

/** 可读模式 [OUTPUT] 段（含 [OUTPUT] 标题行） */
export const READABLE_JSON_OUTPUT_BLOCK = `[OUTPUT]
JSON only (no markdown, no prose outside the object):
{
  "question_zh": string,
  "concise_answer_en": string,
  "expanded_answer_en": string
}
question_zh: 1 short Chinese line.
concise_answer_en: 1 English sentence, natural to read aloud.
expanded_answer_en: 3–4 English sentences, conversational detail. If the user asks to elaborate on the same topic as the last turn, include **new** angles (metrics, trade-offs, steps)—do not only restate the prior answer’s bullets.
Pure noise only → question_zh exactly "无法确定问题" (client skips silently). Otherwise substantive; never use that string for real questions.`.trim();

export function buildConciseSystemPrompt(userSystemPrompt: string): string {
  const base = buildBaseInterviewPrompt(normalizeUserSystemPromptForLlm(userSystemPrompt));
  return `${base}

[OUTPUT]
${CONCISE_JSON_OUTPUT_INNER}`.trim();
}

export function buildReadableSystemPrompt(userSystemPrompt: string): string {
  const base = buildBaseInterviewPrompt(normalizeUserSystemPromptForLlm(userSystemPrompt));
  return `${base}

${READABLE_JSON_OUTPUT_BLOCK}`.trim();
}

function normalizeQuestionLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 用户要求「展开/深入/更多细节」（含「详细说明一下xxx」等）；保留供扩展或调试。 */
export function isElaborationOrDetailRequest(q: string): boolean {
  const t = normalizeQuestionLine(q);
  if (!t) return false;
  return /详细|展开|深入|具体(点|讲|说说|说明)|elaborate|more detail|tell me more|go deeper|进一步|多说|再讲讲|展开讲讲/.test(
    t
  );
}

/** 短句泛追问（详细吗/展开）；保留供其它逻辑或调试使用。 */
export function isGenericFollowUpQuestion(q: string): boolean {
  const t = normalizeQuestionLine(q);
  if (t.length > 72) return false;
  if (/^(能|请)?详细/.test(t)) return true;
  if (/^(能否|可不可以)(更)?详细/.test(t)) return true;
  if (/^可以再(详细|具体)/.test(t)) return true;
  if (/^展开(一下|说说)?$/.test(t)) return true;
  if (/^具体(点|说说|讲一下|说明一下)?$/.test(t)) return true;
  if (/^多说(一点|些)/.test(t)) return true;
  if (/^(tell me more|elaborate|more detail)\b/i.test(t)) return true;
  if (/^can you explain (more|further)\b/i.test(t)) return true;
  return false;
}

/**
 * 当前尾句为泛追问时，返回应承接的「上一轮非泛追问」的面试官原题（来自摘要）。
 * 无 tail（如 Realtime 建连时尚无转写）时不注入，以免把旧题当锚点误伤全新问题。
 */
export function resolveThreadAnchorQuestion(
  answerSummaries: AnswerSummary[] | undefined,
  tailUserQuestion: string | undefined
): string | undefined {
  const tail = tailUserQuestion?.trim() ?? '';
  if (!tail || !isGenericFollowUpQuestion(tail)) return undefined;
  const turns = answerSummaries ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const q = typeof turns[i]?.question_zh === 'string' ? turns[i].question_zh.trim() : '';
    if (q && !isGenericFollowUpQuestion(q)) return q;
  }
  return undefined;
}

export function formatThreadAnchorBlock(anchor: string): string {
  const a = anchor.trim();
  if (!a) return '';
  return `
[THREAD_ANCHOR]
The follow-up stays on the same topic as this earlier substantive question:
${a}
`.trim();
}

/** 追问要「加深」而非重答一遍时注入（chat：已知当前 User 为展开类；realtime：下一句话可能是展开） */
export function formatElaborationDepthBlock(variant: 'chat' | 'realtime' = 'chat'): string {
  const lead =
    variant === 'chat'
      ? 'The latest User asks for more depth on the **ongoing** topic (e.g. 详细说明 / elaborate). You already gave a first-pass answer in the **last Assistant** line in [CONVERSATION].'
      : "If the interviewer's next utterance asks for more detail (详细说明 / elaborate / go deeper), treat it as a second layer on the same topic as the **last Assistant** line in [CONVERSATION].";
  return `
[ELABORATION]
${lead}
- **Add** new substance: extra steps, metrics (e.g. PR-AUC, calibration, threshold tuning), trade-offs, failure modes, evaluation protocol, monitoring, or production practices that were **not** already stated there.
- Do **not** paraphrase the same 2–3 bullets (e.g. only repeating “SMOTE / resampling / class weights”) as a full answer—push the explanation forward.
`.trim();
}

/** 上下文行为约束（替代原 FOLLOW_UP / THREAD_ANCHOR / ELABORATION 多段） */
export function formatContextInstructionBlock(mode: 'chat' | 'realtime'): string {
  const audioLine =
    mode === 'realtime'
      ? '\n- In this mode, **CURRENT_QUESTION** is always what the interviewer says in the **live audio** for the turn you are answering (there is no duplicate text line for it).'
      : '';
  return `
[INSTRUCTION]
- Always answer **CURRENT_QUESTION**.${audioLine}
- Use **[CONVERSATION]** for continuity only (prior interviewer questions and your prior guidance).
- If **CURRENT_QUESTION** is a follow-up or asks for more detail, continue the previous answer naturally; add new substance—do not only paraphrase the same bullets.
- Do **not** switch to a different topic unless the interviewer clearly changed subject.
- Use **[RESUME]**, **[JD]**, and **[NOTES]** only when they help answer **CURRENT_QUESTION**; do not redirect to unrelated background.
`.trim();
}

function looksLikeResumeStructuredJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') && /"work_experience"\s*:/.test(t);
}

/**
 * 合并 structured.resume 与 contextSummary.resume（资料库里 summary 常塞整份 JSON）；
 * 识别为简历结构化 JSON 时一律走 prepareResumeJsonForPrompt。
 */
export function buildResumeForLlmPrompt(
  structuredResume: string | undefined,
  contextResumeFallback: string | undefined,
  jdStr: string | undefined,
  questionHint: string | undefined
): string {
  let raw = structuredResume?.trim() || contextResumeFallback?.trim() || '';
  if (!raw) return '(none)';
  if (looksLikeResumeStructuredJson(raw)) {
    raw = prepareResumeJsonForPrompt(raw, jdStr?.trim() ?? '', { questionHint: questionHint ?? '' });
  }
  return capStructuredJsonForPrompt(raw, 'resume');
}

/** 单轮摘要 → Assistant 行：有一句+展开时拼接（先一句后展开），否则沿用旧逻辑 */
function assistantTextFromAnswerSummary(turn: AnswerSummary): string {
  const concise =
    typeof turn.concise_answer_en === 'string' ? turn.concise_answer_en.trim() : '';
  const exp =
    typeof turn.expanded_answer_en === 'string' ? turn.expanded_answer_en.trim() : '';
  const think =
    typeof turn.thinking_zh === 'string' && turn.thinking_zh.trim()
      ? turn.thinking_zh.trim()
      : '';
  if (concise && exp) return `${concise}\n\n${exp}`;
  if (exp) return exp;
  if (concise) return concise;
  if (think) return think;
  return '';
}

/**
 * 仅历史问答（已完成的摘要轮次），不包含本轮问题。
 * 本轮问题单独放在 [CURRENT_QUESTION]，避免与 FOLLOW_UP/尾行重复逻辑混杂。
 */
export function buildRecentConversationBlock(answerSummaries: AnswerSummary[] | undefined): string {
  const recentTurns = (answerSummaries ?? []).slice(-3);
  const lines: string[] = [];
  for (const turn of recentTurns) {
    const q = typeof turn.question_zh === 'string' ? turn.question_zh : '';
    const a = assistantTextFromAnswerSummary(turn);
    lines.push(`User: ${q}`);
    lines.push(`Assistant: ${a}`);
    lines.push('');
  }
  const out = lines.join('\n').trim();
  return out || '(none)';
}

export async function generateAssist(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  questionRaw: string,
  mock: boolean,
  responseStyle: ResponseStyle = 'concise',
  baseURL?: string,
  structured?: { jd: string; resume: string; notes: string }
): Promise<AssistJSON | ReadableAssistJSON> {
  if (mock) {
    if (responseStyle === 'readable') {
      return {
        question_zh: '请你简单介绍一下最近负责的一个项目？',
        concise_answer_en: 'I recently built a real-time AI interview assistant that listens to questions and provides structured guidance using a language model.',
        expanded_answer_en: 'The system captures audio in real time and transcribes it using streaming speech recognition. Once a question is detected, it is sent to a language model that generates tailored interview responses. I focused heavily on latency optimisation so that guidance appears within seconds. The result helps users structure their answers quickly during live interviews.'
      } as ReadableAssistJSON;
    }
    return {
      question_zh: '请你简单介绍一下最近负责的一个项目？',
      concise_answer_en: 'I recently led an end-to-end project that combined real-time AI and production deployment, focusing on clear ownership and measurable impact.',
      thinking_zh: '',
      keywords_en: ['recent project', 'responsibilities', 'tech stack', 'impact', 'metrics']
    } as AssistJSON;
  }

  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  // 统一：所有模式共享同一「候选人&JD 个性化」base prompt，仅在尾部附加不同输出格式约束。
  const effectivePrompt =
    responseStyle === 'readable'
      ? buildReadableSystemPrompt(systemPrompt)
      : buildConciseSystemPrompt(systemPrompt);

  const systemMessage = {
    role: 'system' as const,
    content: buildSystemContent(
      effectivePrompt,
      contextSummary,
      questionsHistory,
      questionRaw,
      structured,
      getAnswerSummaries(),
      responseStyle === 'concise' ? { logPrompt: true } : undefined
    )
  };

  if (responseStyle === 'readable') {
    return await callModelReadable(client, model, systemMessage);
  }
  return await callModelWithRetry(client, model, systemMessage);
}

// ─────────────────────────────────────────────
// 根据资料自动优化 System Prompt
// 两步：先结构化提取，再填模板
// ─────────────────────────────────────────────

export async function generateCustomSystemPrompt(
  apiKey: string,
  model: string,
  _baseSystemPrompt: string,
  contextSummary: ContextSummary,
  baseURL?: string
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  // Step 1：结构化提取 JD / 简历 / Notes 中的关键信息
  const extractRes = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是一名资深职业顾问，从招聘JD和候选人简历中提取关键信息，输出严格JSON，无额外文字。'
      },
      {
        role: 'user',
        content: buildExtractPrompt(contextSummary)
      }
    ]
  });

  let extracted: any = {};
  try {
    extracted = JSON.parse(extractRes.choices[0]?.message?.content ?? '{}');
  } catch {}

  // Step 2：仅写入个性化身份行；完整结构见设置页「结构预览」（不影响实际 LLM 拼接）
  return buildPersonalizedPrompt(extracted);
}

function buildExtractPrompt(ctx: ContextSummary): string {
  return `请从以下材料提取信息，输出JSON（所有字段都必须有值，无内容填空字符串或空数组）：
{
  "target_role": "目标岗位名称（1句）",
  "jd_core_skills": ["技术要求1", "技术要求2"],
  "jd_business_context": "JD中的业务场景/行业背景（1-2句）",
  "jd_key_responsibilities": ["核心职责1", "核心职责2", "核心职责3"],
  "candidate_name": "候选人姓名（若有，否则填候选人）",
  "candidate_core_skills": ["技能1", "技能2", "技能3"],
  "candidate_projects": [
    {
      "name": "项目名（尽量保留简历里的真实项目/业务名称，例如 Department of Trust fraud detection chatbot，避免发明笼统名字如“创新AI解决方案开发”）",
      "tech": "技术栈（只保留和当前JD最相关的关键技术）",
      "result": "量化结果或核心业务指标（数字/规模/收益等）",
      "relevance_to_jd": "1句话说明该项目与当前JD的匹配点（领域/技术/职责）"
    }
  ],
  "candidate_strengths": ["亮点1", "亮点2", "亮点3"],
  "key_interview_topics": ["话题1", "话题2", "话题3"],
  "notes_highlights": "Notes中的特殊补充要点（若无则空字符串）"
}

[JD内容]
${ctx.jd || '(无)'}

[简历内容]
${ctx.resume || '(无)'}

[Notes]
${ctx.notes || '(无)'}`.trim();
}

/** 个性化身份行 */
function buildPersonalizedPrompt(e: any): string {
  const role = e.target_role || '目标岗位';
  const name = e.candidate_name || '候选人';
  return `你是「面试实时提词器助手」，代表${name}参加【${role}】岗位面试。`.trim();
}

// ─────────────────────────────────────────────
// 流式 LLM：逐字输出，每有新字段就回调一次
// ─────────────────────────────────────────────

export async function generateAssistStream(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  questionRaw: string,
  onChunk: (chunk: AssistStreamChunk) => void,
  responseStyle: ResponseStyle = 'concise',
  baseURL?: string,
  structured?: { jd: string; resume: string; notes: string },
  documentContent?: string
): Promise<void> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const effectivePrompt = buildConciseSystemPrompt(systemPrompt);
  const content = buildSystemContent(
    effectivePrompt,
    contextSummary,
    questionsHistory,
    questionRaw,
    structured,
    getAnswerSummaries(),
    { logPrompt: true },
    documentContent
  );

  const stream = await client.chat.completions.create({
    model,
    stream: true,
    temperature: 0.2,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content }]
  });

  let accumulated = '';
  let emittedQuestion = false;
  let lastConciseLen = 0;
  let lastExpandedLen = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (!delta) continue;
    accumulated += delta;

    const update: AssistStreamChunk['partial'] = {};
    let hasUpdate = false;

    if (!emittedQuestion) {
      const m = accumulated.match(/"question_zh"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        update.question_zh = unescapeStr(m[1]);
        emittedQuestion = true;
        hasUpdate = true;
      }
    }

    // concise_answer_en（流式打字）
    const conciseMatch = accumulated.match(/"concise_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (conciseMatch) {
      const val = unescapeStr(conciseMatch[1]);
      if (val.length > lastConciseLen) {
        update.concise_answer_en = val;
        lastConciseLen = val.length;
        hasUpdate = true;
      }
    }
    // expanded_answer_en（流式打字）
    const expandedMatch = accumulated.match(/"expanded_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (expandedMatch) {
      const val = unescapeStr(expandedMatch[1]);
      if (val.length > lastExpandedLen) {
        update.expanded_answer_en = val;
        lastExpandedLen = val.length;
        hasUpdate = true;
      }
    }

    if (hasUpdate) {
      onChunk({ partial: update, done: false });
    }
  }

  // done 时用完整 JSON 做最终校准
  let finalPartial: AssistStreamChunk['partial'] = {};
  try {
    const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as any;
      finalPartial = {
        question_zh: typeof obj.question_zh === 'string' ? obj.question_zh.trim() : undefined,
        concise_answer_en: typeof obj.concise_answer_en === 'string' ? obj.concise_answer_en.trim() : undefined,
        expanded_answer_en: typeof obj.expanded_answer_en === 'string' ? obj.expanded_answer_en.trim() : undefined
      };
    }
  } catch {}

  onChunk({ partial: finalPartial, done: true });
}

function unescapeStr(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** 仅 `logPrompt: true` 时打印 buildSystemContent 全文（仅极简 Chat 路径应开启） */
export interface BuildSystemContentOptions {
  logPrompt?: boolean;
}

export function buildSystemContent(
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  questionRaw: string,
  structured?: { jd: string; resume: string; notes: string },
  answerSummaries?: AnswerSummary[],
  options?: BuildSystemContentOptions,
  documentContent?: string
): string {
  const historyJoined = questionsHistory.map((q, idx) => `${idx + 1}. ${q}`).join('\n');
  const recentTurns = (answerSummaries ?? []).slice(-3);
  const recentConversation = buildRecentConversationBlock(answerSummaries);
  const currentQuestion = (questionRaw ?? '').trim() || '(none)';
  const instructionBlock = formatContextInstructionBlock('chat');

  const historyBlock =
    recentTurns.length > 0
      ? ''
      : `
[HISTORY]
${historyJoined || '(none)'}
`;

  let ctx: string;

  if (documentContent?.trim()) {
    // 全文注入模式：CV+JD 作为完整文档，不走结构化摘要
    ctx = `
[DOCUMENT CONTENT]
${documentContent.trim()}
${historyBlock}
${instructionBlock}

[CONVERSATION]
${recentConversation}

[CURRENT_QUESTION]
${currentQuestion}
`.trim();
  } else {
    const resumeJson = buildResumeForLlmPrompt(
      structured?.resume,
      contextSummary.resume,
      structured?.jd,
      questionRaw
    );
    const jdJson = structured?.jd?.trim()
      ? capStructuredJsonForPrompt(structured.jd, 'jd')
      : contextSummary.jd?.trim() || '(none)';
    const notesJson = structured?.notes?.trim()
      ? capStructuredJsonForPrompt(structured.notes, 'notes')
      : contextSummary.notes?.trim() || '(none)';

    ctx = `
[RESUME]
${resumeJson}

[JD]
${jdJson}

[NOTES]
${notesJson}${historyBlock}

${instructionBlock}

[CONVERSATION]
${recentConversation}

[CURRENT_QUESTION]
${currentQuestion}
`.trim();
  }

  const finalPrompt = `${systemPrompt}

====================
[CONTEXT]
${ctx}
`;

  if (options?.logPrompt) {
    console.log('[Prompt][面试Chat] length =', finalPrompt.length);
    console.log('[Prompt][面试Chat] content =\n', finalPrompt);
  }

  return finalPrompt;
}

// ─────────────────────────────────────────────
// Readable 模式解析
// ─────────────────────────────────────────────

async function callModelReadable(
  client: OpenAI,
  model: string,
  systemMessage: { role: 'system'; content: string }
): Promise<ReadableAssistJSON> {
  const response = await client.chat.completions.create({
    model,
    messages: [systemMessage],
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: 'json_object' }
  });

  const raw = response.choices[0]?.message?.content ?? '';
  let obj: any = {};
  try { obj = JSON.parse(raw); } catch {}

  return {
    question_zh: typeof obj.question_zh === 'string' && obj.question_zh.trim()
      ? obj.question_zh.trim()
      : SKIP_TURN_QUESTION_ZH,
    concise_answer_en: typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim()
      ? obj.concise_answer_en.trim() : 'Please refer to your experience and answer the question directly.',
    expanded_answer_en: typeof obj.expanded_answer_en === 'string' && obj.expanded_answer_en.trim()
      ? obj.expanded_answer_en.trim() : 'Elaborate on your experience, highlight relevant skills, and close with measurable results.'
  };
}

/** 使用已构建好的 system content 直接请求可读答案（用于从极简切换时注入极简卡片上下文） */
export async function generateReadableAnswerWithContent(
  apiKey: string,
  model: string,
  systemContent: string,
  baseURL?: string
): Promise<ReadableAssistJSON> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return callModelReadable(client, model, { role: 'system', content: systemContent });
}

async function callModelWithRetry(
  client: OpenAI,
  model: string,
  systemMessage: { role: 'system'; content: string }
): Promise<AssistJSON> {
  try {
    return await callOnce(client, model, systemMessage);
  } catch {
    const patched = {
      ...systemMessage,
      content:
        systemMessage.content +
        '\n\n[OUTPUT] Retry: emit one JSON object only; no markdown, no explanation.'
    };
    return await callOnce(client, model, patched);
  }
}

async function callOnce(
  client: OpenAI,
  model: string,
  systemMessage: { role: 'system'; content: string }
): Promise<AssistJSON> {
  const response = await client.chat.completions.create({
    model,
    messages: [systemMessage],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  const raw = response.choices[0]?.message?.content ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('LLM 输出非 JSON：' + String(e));
  }

  const obj = parsed as any;

  const question =
    obj && typeof obj.question_zh === 'string' && obj.question_zh.trim()
      ? obj.question_zh.trim()
      : SKIP_TURN_QUESTION_ZH;

  const conciseAnswer =
    obj && typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim()
      ? obj.concise_answer_en.trim()
      : undefined;

  let keywords: string[] =
    obj && Array.isArray(obj.keywords_en) ? obj.keywords_en.map((k: unknown) => String(k)) : [];

  if (keywords.length === 0) {
    keywords = [
      'key strengths',
      'relevant experience',
      'impact & metrics',
      'areas to improve',
      'role alignment'
    ];
  }

  return {
    question_zh: question,
    ...(conciseAnswer ? { concise_answer_en: conciseAnswer } : {}),
    thinking_zh: '',
    keywords_en: keywords.slice(0, 10)
  };
}

// ─────────────────────────────────────────────
// 测试连接（各服务商）
// ─────────────────────────────────────────────

function parseAssistJson(raw: string, responseStyle: ResponseStyle): AssistJSON | ReadableAssistJSON {
  let obj: any = {};
  try { obj = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch {}
    }
  }

  if (responseStyle === 'readable') {
    return {
      question_zh: typeof obj.question_zh === 'string' && obj.question_zh.trim()
        ? obj.question_zh.trim()
        : SKIP_TURN_QUESTION_ZH,
      concise_answer_en: typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim()
        ? obj.concise_answer_en.trim()
        : 'Please answer based on the screenshot content.',
      expanded_answer_en: typeof obj.expanded_answer_en === 'string' && obj.expanded_answer_en.trim()
        ? obj.expanded_answer_en.trim()
        : ''
    } as ReadableAssistJSON;
  }

  const keywords = Array.isArray(obj.keywords_en) ? obj.keywords_en.map((k: unknown) => String(k)).slice(0, 10) : [];
  return {
    question_zh: typeof obj.question_zh === 'string' && obj.question_zh.trim()
      ? obj.question_zh.trim()
      : SKIP_TURN_QUESTION_ZH,
    ...(typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim()
      ? { concise_answer_en: obj.concise_answer_en.trim() }
      : {}),
    ...(typeof obj.expanded_answer_en === 'string' && obj.expanded_answer_en.trim()
      ? { expanded_answer_en: obj.expanded_answer_en.trim() }
      : {}),
    thinking_zh: '',
    keywords_en: keywords
  } as AssistJSON;
}

export async function generateAssistFromImage(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  imagePngBase64: string,
  responseStyle: ResponseStyle = 'concise',
  baseURL?: string,
  structured?: { jd: string; resume: string; notes: string },
  documentContent?: string,
  meetingContent?: { fullContent: string; hasDocuments: boolean }
): Promise<AssistJSON | ReadableAssistJSON> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemContent = meetingContent
    ? buildMeetingSystemContent(
        meetingContent.fullContent,
        '[SCREENSHOT INPUT]\nUse the screenshot image as the current question/input.',
        getAnswerSummaries(),
        meetingContent.hasDocuments
      )
    : buildSystemContent(
        responseStyle === 'readable'
          ? buildReadableSystemPrompt(systemPrompt)
          : buildConciseSystemPrompt(systemPrompt),
        contextSummary,
        questionsHistory,
        '[SCREENSHOT INPUT]\nUse the screenshot image as the current question/input.',
        structured,
        getAnswerSummaries(),
        responseStyle === 'concise' ? { logPrompt: true } : undefined,
        documentContent
      );

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: responseStyle === 'readable' || meetingContent ? 800 : 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemContent },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Read the selected screenshot as the current question/input. If it is captions or text, answer it normally. If it contains code, solve or explain the code issue and include concrete code/fixes where useful. Return JSON only.'
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imagePngBase64}` }
          }
        ]
      }
    ]
  });

  return parseAssistJson(response.choices[0]?.message?.content ?? '', meetingContent ? 'readable' : responseStyle);
}

export async function generateAssistGeminiFromImage(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  imagePngBase64: string,
  responseStyle: ResponseStyle = 'concise',
  structured?: { jd: string; resume: string; notes: string },
  documentContent?: string,
  meetingContent?: { fullContent: string; hasDocuments: boolean }
): Promise<AssistJSON | ReadableAssistJSON> {
  const systemContent = meetingContent
    ? buildMeetingSystemContent(
        meetingContent.fullContent,
        '[SCREENSHOT INPUT]\nUse the screenshot image as the current question/input.',
        getAnswerSummaries(),
        meetingContent.hasDocuments
      )
    : buildSystemContent(
        responseStyle === 'readable'
          ? buildReadableSystemPrompt(systemPrompt)
          : buildConciseSystemPrompt(systemPrompt),
        contextSummary,
        questionsHistory,
        '[SCREENSHOT INPUT]\nUse the screenshot image as the current question/input.',
        structured,
        getAnswerSummaries(),
        responseStyle === 'concise' ? { logPrompt: true } : undefined,
        documentContent
      );

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemContent }] },
      contents: [{
        parts: [
          {
            text: 'Read the selected screenshot as the current question/input. If it is captions or text, answer it normally. If it contains code, solve or explain the code issue and include concrete code/fixes where useful. Return JSON only.'
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: imagePngBase64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: responseStyle === 'readable' || meetingContent ? 800 : 500,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return parseAssistJson(text, meetingContent ? 'readable' : responseStyle);
}

export async function testConnectionOpenAICompatible(
  apiKey: string,
  baseURL: string | undefined,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    await client.chat.completions.create({
      model,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Hi' }]
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function testConnectionOllama(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = baseUrl.replace(/\/$/, '') + '/api/tags';
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(await r.text());
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function testConnectionGemini(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!r.ok) throw new Error(await r.text());
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ─────────────────────────────────────────────
// Ollama 本地：Chat 兼容
// ─────────────────────────────────────────────

export async function generateAssistOllama(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  questionRaw: string,
  responseStyle: ResponseStyle = 'concise'
): Promise<AssistJSON | ReadableAssistJSON> {
  const content = buildSystemContent(
    responseStyle === 'readable' ? buildReadableSystemPrompt(systemPrompt) : buildConciseSystemPrompt(systemPrompt),
    contextSummary,
    questionsHistory,
    questionRaw,
    undefined,
    getAnswerSummaries(),
    responseStyle === 'concise' ? { logPrompt: true } : undefined
  );
  const url = baseUrl.replace(/\/$/, '') + '/api/chat';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content }],
      stream: false
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const raw = data.message?.content ?? '';
  let obj: any = {};
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  if (responseStyle === 'readable') {
    return {
      question_zh: obj.question_zh ?? SKIP_TURN_QUESTION_ZH,
      concise_answer_en: obj.concise_answer_en ?? '',
      expanded_answer_en: obj.expanded_answer_en ?? ''
    } as ReadableAssistJSON;
  }
  const conciseAnswer = typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim() ? obj.concise_answer_en.trim() : undefined;
  return {
    question_zh: obj.question_zh ?? SKIP_TURN_QUESTION_ZH,
    ...(conciseAnswer ? { concise_answer_en: conciseAnswer } : {}),
    thinking_zh: obj.thinking_zh ?? '',
    keywords_en: Array.isArray(obj.keywords_en) ? obj.keywords_en : []
  } as AssistJSON;
}

// ─────────────────────────────────────────────
// Google Gemini：Chat 兼容
// ─────────────────────────────────────────────

export async function generateAssistGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contextSummary: ContextSummary,
  questionsHistory: string[],
  questionRaw: string,
  responseStyle: ResponseStyle = 'concise'
): Promise<AssistJSON | ReadableAssistJSON> {
  const content = buildSystemContent(
    responseStyle === 'readable'
      ? buildReadableSystemPrompt(systemPrompt)
      : buildConciseSystemPrompt(systemPrompt),
    contextSummary,
    questionsHistory,
    questionRaw,
    undefined,
    getAnswerSummaries(),
    responseStyle === 'concise' ? { logPrompt: true } : undefined
  );
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: content }] },
      contents: [{ parts: [{ text: 'Generate the JSON only.' }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: responseStyle === 'readable' ? 600 : 400,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  let obj: any = {};
  try { obj = JSON.parse(text); } catch {}
  if (responseStyle === 'readable') {
    return {
      question_zh: obj.question_zh ?? SKIP_TURN_QUESTION_ZH,
      concise_answer_en: obj.concise_answer_en ?? '',
      expanded_answer_en: obj.expanded_answer_en ?? ''
    } as ReadableAssistJSON;
  }
  const conciseAnswer = typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim() ? obj.concise_answer_en.trim() : undefined;
  return {
    question_zh: obj.question_zh ?? SKIP_TURN_QUESTION_ZH,
    ...(conciseAnswer ? { concise_answer_en: conciseAnswer } : {}),
    thinking_zh: obj.thinking_zh ?? '',
    keywords_en: Array.isArray(obj.keywords_en) ? obj.keywords_en : []
  } as AssistJSON;
}

// ─────────────────────────────────────────────
// 组会 / 项目介绍模式
// ─────────────────────────────────────────────

/**
 * 组会模式系统指令。
 * 核心原则：以文档为主要信息源，结合通用知识理解背后逻辑，像真正懂这个项目的人一样回答。
 */
export const MEETING_SYSTEM_PROMPT = `You are a knowledgeable assistant helping present and explain a project during a meeting or technical review.

You have carefully read and internalized the document(s) in [DOCUMENT CONTENT]. Think of yourself as a team member who deeply understands this material — not just what it says, but WHY the decisions were made and how the pieces connect.

HOW TO ANSWER:
1. Primary source: ground your answer in the document. If something is explicitly stated, use it.
2. You may use your broader knowledge to explain, contextualize, and enrich — but always connect back to the document's actual content and decisions.
3. Understand the reasoning behind design choices, not just what they are. Connect related information across the document (e.g. link FAQ rationale to pipeline architecture decisions).
4. Respond in the same language as the question.
5. Think like someone who has internalized this project, not someone doing a database lookup.
6. If something is genuinely not covered by the document, say so briefly, then offer your best inference based on the document's overall context and approach.`.trim();

/**
 * 构建组会模式的完整 system content。
 * 策略：全文注入（与 ChatGPT 上传文件行为一致）。
 */
export function buildMeetingSystemContent(
  fullContent: string,
  questionRaw: string,
  answerSummaries?: AnswerSummary[],
  hasDocuments?: boolean
): string {
  const currentQuestion = (questionRaw ?? '').trim() || '(none)';
  const recentConversation = buildRecentConversationBlock(answerSummaries);

  const docBlock = hasDocuments && fullContent.trim()
    ? `[DOCUMENT CONTENT]\n${fullContent.trim()}`
    : `[DOCUMENT CONTENT]\n(No documents uploaded yet. Please upload your project documents first.)`;

  const outputFormat = `[OUTPUT FORMAT]
JSON only, no extra text outside the object:
{
  "question_zh": "one-line summary of what was asked (match the language of the question)",
  "concise_answer_en": "direct answer in 2-3 sentences — give the core conclusion and the key reason behind it",
  "expanded_answer_en": "deeper explanation in 4-6 sentences — cover the design reasoning, trade-offs, how it connects to other parts of the system, and any relevant context"
}
Only set question_zh to exactly "无法确定问题" when there is genuinely no recognizable question at all (pure noise). For any real question, always give a substantive answer.`;

  return `${MEETING_SYSTEM_PROMPT}

====================
${docBlock}

[CONVERSATION HISTORY]
Use this to understand the ongoing discussion context. If the current question is a follow-up, build on what was already said.
${recentConversation}

[CURRENT QUESTION]
${currentQuestion}

====================
${outputFormat}`;
}

/**
 * 组会模式流式生成。全文注入文档，严格基于文档内容回答。
 */
export async function generateMeetingAssistStream(
  apiKey: string,
  model: string,
  fullContent: string,
  questionRaw: string,
  onChunk: (chunk: AssistStreamChunk) => void,
  baseURL?: string,
  hasDocuments?: boolean
): Promise<void> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const content = buildMeetingSystemContent(
    fullContent,
    questionRaw,
    getAnswerSummaries(),
    hasDocuments
  );

  const stream = await client.chat.completions.create({
    model,
    stream: true,
    temperature: 0.2,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content }]
  });

  let accumulated = '';
  let emittedQuestion = false;
  let lastConciseLen = 0;
  let lastExpandedLen = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (!delta) continue;
    accumulated += delta;

    const update: AssistStreamChunk['partial'] = {};
    let hasUpdate = false;

    if (!emittedQuestion) {
      const m = accumulated.match(/"question_zh"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        update.question_zh = unescapeStr(m[1]);
        emittedQuestion = true;
        hasUpdate = true;
      }
    }

    const conciseMatch = accumulated.match(/"concise_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (conciseMatch) {
      const val = unescapeStr(conciseMatch[1]);
      if (val.length > lastConciseLen) {
        update.concise_answer_en = val;
        lastConciseLen = val.length;
        hasUpdate = true;
      }
    }

    const expandedMatch = accumulated.match(/"expanded_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (expandedMatch) {
      const val = unescapeStr(expandedMatch[1]);
      if (val.length > lastExpandedLen) {
        update.expanded_answer_en = val;
        lastExpandedLen = val.length;
        hasUpdate = true;
      }
    }

    if (hasUpdate) onChunk({ partial: update, done: false });
  }

  // 最终校准：用完整 JSON 修正流式截断
  let finalPartial: AssistStreamChunk['partial'] = {};
  try {
    const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as any;
      finalPartial = {
        question_zh: typeof obj.question_zh === 'string' ? obj.question_zh.trim() : undefined,
        concise_answer_en: typeof obj.concise_answer_en === 'string' ? obj.concise_answer_en.trim() : undefined,
        expanded_answer_en: typeof obj.expanded_answer_en === 'string' ? obj.expanded_answer_en.trim() : undefined
      };
    }
  } catch {}

  onChunk({ partial: finalPartial, done: true });
}

// ─────────────────────────────────────────────
// 一键导出：本次会话实录 → 中文面试总结（不进入答题 prompt）
// ─────────────────────────────────────────────

const INTERVIEW_SESSION_SUMMARY_SYSTEM = `你是面试复盘助手。根据用户提供的「本次面试全部问答记录」，用中文输出简洁总结（约 300–500 字），包含：
1）面试官主要考察方向或题型；
2）反复出现或深挖的主题；
3）候选人可重点巩固的建议。
不要重复照抄原文，不要编造记录中未出现的问题。`.trim();

export async function generateInterviewSessionSummary(
  transcriptText: string,
  opts: {
    apiProvider: ApiProvider;
    model: string;
    ollamaBaseUrl?: string;
    mockLlm?: boolean;
  },
  apiKey: string | null | undefined
): Promise<string> {
  const text = (transcriptText ?? '').trim().slice(0, 120_000);
  if (!text) return '（无实录内容）';

  if (opts.mockLlm) {
    return '（当前为演示模式，未调用大模型生成总结。请直接阅读上方问答实录。）';
  }

  const provider = opts.apiProvider ?? 'openai';
  const user = `以下为本次面试多轮实录。每轮中「面试官原话」来自语音转写（可能为中英混说或口误），「卡片题摘要」为模型提炼的中文要点；「英文回答」为提词卡上的极简一句与展开。请仅根据这些内容输出中文复盘总结：\n\n${text}`;

  if (provider === 'ollama') {
    const base = (opts.ollamaBaseUrl?.trim() || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/api/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: INTERVIEW_SESSION_SUMMARY_SYSTEM },
          { role: 'user', content: user }
        ],
        stream: false
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const out = String(data.message?.content ?? '').trim();
    return out || '（模型未返回总结）';
  }

  if (provider === 'google') {
    const key = apiKey ?? '';
    if (!key) throw new Error('缺少 Google API Key');
    const sumUrl = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(sumUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INTERVIEW_SESSION_SUMMARY_SYSTEM }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 1200 }
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const t = String(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return t || '（模型未返回总结）';
  }

  if (isOpenAICompatible(provider)) {
    const k = apiKey ?? '';
    if (!k) throw new Error('缺少 API Key');
    const baseURL = getOpenAICompatibleBaseUrl(provider);
    const client = new OpenAI({
      apiKey: k,
      ...(baseURL ? { baseURL } : {})
    });
    const response = await client.chat.completions.create({
      model: opts.model,
      messages: [
        { role: 'system', content: INTERVIEW_SESSION_SUMMARY_SYSTEM },
        { role: 'user', content: user }
      ],
      temperature: 0.35,
      max_tokens: 1200
    });
    const out = String(response.choices[0]?.message?.content ?? '').trim();
    return out || '（模型未返回总结）';
  }

  return '（当前服务商暂不支持自动生成总结，请阅读上方问答实录。）';
}
