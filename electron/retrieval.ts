import type { ContextSummary, ContextDocType } from './types';
import {
  getStructuredDocsByType,
  getGeneratedQuestionsByDocType,
  getChunksByDocType,
  getContextFiles
} from './contextStore';
import { createEmbedding } from './embeddings';
import { searchSimilarChunks } from './vectorStore';

export interface MeetingAnswerContext {
  /** 所有文档全文（直接注入 context，不做 RAG 检索） */
  fullContent: string;
  /** 是否有文档 */
  hasDocuments: boolean;
}

/**
 * 组会/项目答疑模式的上下文构建。
 *
 * 策略：全文注入（与 ChatGPT 上传文件的做法一致）。
 * 对于组会文档（通常几十页以内），直接把全文放进 context window，
 * 模型能看到全部内容，效果远好于 RAG 检索。
 * RAG 只在文档总量超出 context 时才有必要。
 *
 * 安全上限：约 500K 字符（对应约 125K token），足够覆盖百页文档。
 */
export function buildMeetingAnswerContext(): MeetingAnswerContext {
  const files = getContextFiles().filter(
    (f) => (f as any).docType === 'meeting_doc' && f.rawText
  );

  if (files.length === 0) {
    return { fullContent: '', hasDocuments: false };
  }

  const MAX_CHARS = 500_000;
  const parts: string[] = [];
  let total = 0;

  for (const f of files) {
    const text = (f.rawText ?? '').trim();
    if (!text) continue;
    const block = `=== 文档: ${f.fileName} ===\n${text}`;
    if (total + block.length > MAX_CHARS) {
      parts.push(`=== 文档: ${f.fileName} ===\n[文档过大，已截断至安全上限]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }

  return {
    fullContent: parts.join('\n\n'),
    hasDocuments: parts.length > 0
  };
}

/**
 * 面试模式的文档全文构建。
 * 获取 resume + job_description + qa_notes + project_notes 的原始文本，
 * 直接注入 context window，替代结构化摘要（全文理解效果更好）。
 */
export function buildInterviewDocContent(): string {
  const INTERVIEW_DOC_TYPES = new Set(['resume', 'job_description', 'qa_notes', 'project_notes']);
  const MAX_CHARS = 200_000;
  const files = getContextFiles().filter(
    (f) => INTERVIEW_DOC_TYPES.has((f as any).docType ?? '') && f.rawText
  );

  if (files.length === 0) return '';

  const parts: string[] = [];
  let total = 0;

  const labelMap: Record<string, string> = {
    resume: 'CV / Resume',
    job_description: 'Job Description',
    qa_notes: 'Notes',
    project_notes: 'Project Notes'
  };

  for (const f of files) {
    const text = (f.rawText ?? '').trim();
    if (!text) continue;
    const label = labelMap[(f as any).docType ?? ''] ?? (f as any).docType ?? 'Document';
    const block = `=== ${label}: ${f.fileName} ===\n${text}`;
    if (total + block.length > MAX_CHARS) {
      parts.push(`=== ${label}: ${f.fileName} ===\n[Content truncated — file too large]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }

  return parts.join('\n\n');
}

interface QuestionAnalysis {
  targetDocTypes: ContextDocType[];
}

interface RetrievedContext {
  systemPrompt: string;
  contextSummary: ContextSummary;
  structured: { jd: string; resume: string; notes: string };
}

export async function planAnswerContext(
  questionRaw: string,
  baseSystemPrompt: string
): Promise<RetrievedContext> {
  console.log('[Retrieval] === 新问题进入检索流水线 ===');
  console.log('[Retrieval] 问题原文:', questionRaw);

  const analysis = analyzeQuestion(questionRaw);
  console.log('[Retrieval] 目标文档类型 targetDocTypes:', analysis.targetDocTypes);

  // JD / Resume / Project structured docs
  const jdDocs = getStructuredDocsByType('job_description');
  const resumeDocs = getStructuredDocsByType('resume');
  const projectDocs = getStructuredDocsByType('project_notes');

  console.log('[Retrieval] structuredDocs 统计:', {
    jd: jdDocs.length,
    resume: resumeDocs.length,
    project: projectDocs.length
  });

  const dynamicSystemPrompt = buildDynamicSystemPrompt(baseSystemPrompt, jdDocs);

  const [generatedCtx, structuredCtx, chunkCtx] = await Promise.all([
    retrieveFromGeneratedQuestions(questionRaw, analysis),
    retrieveFromStructuredJson(questionRaw, analysis, { jdDocs, resumeDocs, projectDocs }),
    retrieveFromChunks(questionRaw, analysis)
  ]);

  const jdTextParts: string[] = [];
  const resumeTextParts: string[] = [];
  const notesTextParts: string[] = [];

  if (structuredCtx.jd) jdTextParts.push(structuredCtx.jd);
  if (generatedCtx.jd) jdTextParts.push(generatedCtx.jd);
  if (chunkCtx.jd) jdTextParts.push(chunkCtx.jd);

  if (structuredCtx.resume) resumeTextParts.push(structuredCtx.resume);
  if (generatedCtx.resume) resumeTextParts.push(generatedCtx.resume);
  if (chunkCtx.resume) resumeTextParts.push(chunkCtx.resume);

  if (structuredCtx.notes) notesTextParts.push(structuredCtx.notes);
  if (generatedCtx.notes) notesTextParts.push(generatedCtx.notes);
  if (chunkCtx.notes) notesTextParts.push(chunkCtx.notes);

  const contextSummary: ContextSummary = {
    jd: jdTextParts.join('\n\n'),
    resume: resumeTextParts.join('\n\n'),
    notes: notesTextParts.join('\n\n')
  };

  console.log('[Retrieval] 汇总后的 contextSummary 预览:', {
    jdSnippet: contextSummary.jd.slice(0, 200),
    resumeSnippet: contextSummary.resume.slice(0, 200),
    notesSnippet: contextSummary.notes.slice(0, 200)
  });

  // 将少量结构化 JSON 以字符串形式提供，继续复用现有 buildSystemContent 逻辑
  const structured = {
    jd: jdDocs.length ? JSON.stringify(jdDocs[0].json).slice(0, 3000) : '',
    resume: resumeDocs.length ? JSON.stringify(resumeDocs[0].json).slice(0, 3000) : '',
    notes: projectDocs.length ? JSON.stringify(projectDocs[0].json).slice(0, 3000) : ''
  };

  return {
    systemPrompt: dynamicSystemPrompt,
    contextSummary,
    structured
  };
}

function analyzeQuestion(question: string): QuestionAnalysis {
  const q = question.toLowerCase();
  const targets = new Set<ContextDocType>();

  if (/\b(job|role|position|fit|suitable)\b/.test(q)) {
    targets.add('job_description');
  }
  if (/\b(project|system|pipeline|architecture|workflow)\b/.test(q) || /项目|系统|架构|流程/.test(q)) {
    targets.add('project_notes');
  }
  if (/\b(resume|background|experience|cv)\b/.test(q) || /简历|背景|经历/.test(q)) {
    targets.add('resume');
  }
  if (/previous question|earlier you said/.test(q) || /上一个问题|刚才你说/.test(q)) {
    targets.add('qa_notes');
  }

  if (!targets.size) {
    // 默认关注 JD + 项目，足够覆盖多数面试问题
    targets.add('job_description');
    targets.add('project_notes');
    targets.add('resume');
  }

  return { targetDocTypes: Array.from(targets) };
}

function buildDynamicSystemPrompt(
  baseSystemPrompt: string,
  jdDocs: ReturnType<typeof getStructuredDocsByType>
): string {
  if (!jdDocs.length) return baseSystemPrompt;
  const jd = jdDocs[0].json ?? {};
  const role = jd.role_title || 'the target role';
  const reqSkills = Array.isArray(jd.required_skills) ? jd.required_skills.join(', ') : '';
  const focus = Array.isArray(jd.focus_areas) ? jd.focus_areas.join(', ') : '';
  const answerStyle = jd.answer_style ?? {};
  const depth = answerStyle.technical_depth ?? 'medium';
  const businessFocus = answerStyle.business_focus === false ? 'low' : 'high';

  const jdBlock = `
You are answering as the candidate for role: ${role}.
Focus on required skills: ${reqSkills || '(see JD)'}.
Key focus areas: ${focus || '(see JD)'}.
Answer style:
- technical depth: ${depth}
- business impact focus: ${businessFocus}
Always respond in first-person as the candidate, structured and concise, suitable to be spoken aloud in an interview.`;

  return `${baseSystemPrompt}\n\n${jdBlock}`.trim();
}

async function retrieveFromGeneratedQuestions(
  question: string,
  analysis: QuestionAnalysis
): Promise<{ jd: string; resume: string; notes: string }> {
  const emb = await createEmbedding(question);
  if (!emb) return { jd: '', resume: '', notes: '' };

  console.log('[Retrieval][QGen] 开始在预生成问题库中检索相似问题...');

  const parts: { jd: string[]; resume: string[]; notes: string[] } = {
    jd: [],
    resume: [],
    notes: []
  };

  for (const t of analysis.targetDocTypes) {
    const list = getGeneratedQuestionsByDocType(t);
    if (!list.length) continue;

    const scored = list
      .map(q => ({
        q,
        score: cosineSimilarity(emb, q.embedding)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    console.log('[Retrieval][QGen] docType =', t, '候选问题数 =', list.length, '命中 topN =', scored.length);

    for (const { q } of scored) {
      const line = `Q: ${q.question}`;
      if (t === 'job_description') parts.jd.push(line);
      else if (t === 'resume') parts.resume.push(line);
      else parts.notes.push(line);
    }
  }

  return {
    jd: parts.jd.join('\n'),
    resume: parts.resume.join('\n'),
    notes: parts.notes.join('\n')
  };
}

async function retrieveFromStructuredJson(
  _question: string,
  analysis: QuestionAnalysis,
  opts: {
    jdDocs: ReturnType<typeof getStructuredDocsByType>;
    resumeDocs: ReturnType<typeof getStructuredDocsByType>;
    projectDocs: ReturnType<typeof getStructuredDocsByType>;
  }
): Promise<{ jd: string; resume: string; notes: string }> {
  const pick = (docs: ReturnType<typeof getStructuredDocsByType>): any | null =>
    docs.length ? docs[0].json : null;

  const jd = pick(opts.jdDocs);
  const resume = pick(opts.resumeDocs);
  const project = pick(opts.projectDocs);

  let jdText = '';
  let resumeText = '';
  let notesText = '';

  if (jd && analysis.targetDocTypes.includes('job_description')) {
    jdText = [
      `Role: ${jd.role_title ?? ''}`,
      `Required skills: ${(jd.required_skills ?? []).join(', ')}`,
      `Responsibilities: ${(jd.responsibilities ?? []).join('; ')}`,
      `Focus areas: ${(jd.focus_areas ?? []).join(', ')}`
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (resume && analysis.targetDocTypes.includes('resume')) {
    resumeText = [
      `Profile: ${resume.profile?.summary ?? ''}`,
      `Core skills: ${(resume.skills ?? []).join(', ')}`
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (project && analysis.targetDocTypes.includes('project_notes')) {
    notesText = [
      `Project: ${project.project_name ?? ''}`,
      `Overview: ${project.overview ?? ''}`,
      `Methods: ${(project.methods ?? []).join(', ')}`,
      `Workflow: ${(project.workflow ?? []).join(' -> ')}`
    ]
      .filter(Boolean)
      .join('\n');
  }

  console.log('[Retrieval][Structured] 选取的结构化摘要:', {
    hasJd: !!jdText,
    hasResume: !!resumeText,
    hasProject: !!notesText
  });

  return { jd: jdText, resume: resumeText, notes: notesText };
}

async function retrieveFromChunks(
  question: string,
  analysis: QuestionAnalysis
): Promise<{ jd: string; resume: string; notes: string }> {
  const emb = await createEmbedding(question);
  if (!emb) return { jd: '', resume: '', notes: '' };

  const top = searchSimilarChunks(emb, { docTypes: analysis.targetDocTypes, topK: 4 });
  if (!top.length) return { jd: '', resume: '', notes: '' };

  console.log('[Retrieval][Chunks] 命中相似 chunk 数量:', top.length);

  const jdParts: string[] = [];
  const resumeParts: string[] = [];
  const notesParts: string[] = [];

  // 需要根据 chunkId 找回具体文本
  for (const t of analysis.targetDocTypes) {
    const chunks = getChunksByDocType(t);
    console.log('[Retrieval][Chunks] docType =', t, '可用 chunk 数 =', chunks.length);
    for (const embRec of top.filter(e => e.docType === t)) {
      const match = chunks.find(c => c.id === embRec.chunkId);
      if (!match) continue;
      const block = `[${match.section}]\n${match.text}`;
      if (t === 'job_description') jdParts.push(block);
      else if (t === 'resume') resumeParts.push(block);
      else notesParts.push(block);
    }
  }

  console.log('[Retrieval][Chunks] 最终选取 chunk 段落统计:', {
    jdCount: jdParts.length,
    resumeCount: resumeParts.length,
    notesCount: notesParts.length
  });

  return {
    jd: jdParts.join('\n\n'),
    resume: resumeParts.join('\n\n'),
    notes: notesParts.join('\n\n')
  };
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

