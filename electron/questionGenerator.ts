import type { ContextDocType, SemanticChunk, GeneratedQuestion } from './types';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { getApiKey } from './settingsStore';
import { createEmbedding } from './embeddings';

interface RawGeneratedQuestion {
  question: string;
  sourceSection: string;
  suggested_answer_points?: string[];
}

export async function generateInterviewQuestionsForDoc(
  docType: ContextDocType,
  docId: string,
  structured: any,
  chunks: SemanticChunk[]
): Promise<GeneratedQuestion[]> {
  const questions = await generateRawQuestions(docType, structured, chunks);
  const result: GeneratedQuestion[] = [];

  for (const q of questions) {
    const emb = await createEmbedding(q.question);
    if (!emb) continue;
    result.push({
      id: uuidv4(),
      sourceDocId: docId,
      sourceSection: q.sourceSection,
      docType,
      question: q.question,
      embedding: emb,
      createdAt: Date.now()
    });
  }

  return result;
}

async function generateRawQuestions(
  docType: ContextDocType,
  structured: any,
  chunks: SemanticChunk[]
): Promise<RawGeneratedQuestion[]> {
  const apiKey = await getApiKey();
  if (!apiKey) return [];

  const client = new OpenAI({ apiKey });
  const maxQuestions = 12;

  const system = buildQuestionSystemPrompt(docType);
  const contextText = buildContextSnippet(docType, structured, chunks);

  const res = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: contextText
      }
    ]
  });

  try {
    const obj = JSON.parse(res.choices[0]?.message?.content ?? '{}');
    const list = Array.isArray(obj.questions) ? obj.questions : [];
    const trimmed: RawGeneratedQuestion[] = [];
    for (const q of list) {
      if (!q || typeof q.question !== 'string') continue;
      trimmed.push({
        question: q.question.trim(),
        sourceSection: typeof q.source_section === 'string' ? q.source_section : 'unknown',
        suggested_answer_points: Array.isArray(q.suggested_answer_points)
          ? q.suggested_answer_points.map((x: any) => String(x))
          : undefined
      });
      if (trimmed.length >= maxQuestions) break;
    }
    return trimmed;
  } catch {
    return [];
  }
}

function buildQuestionSystemPrompt(docType: ContextDocType): string {
  if (docType === 'resume') {
    return `
你是一名面试官，根据候选人的简历生成潜在面试问题。
只输出 JSON：
{
  "questions": [
    {
      "question": "英文问题",
      "source_section": "profile | work_experience | project | skills | education",
      "suggested_answer_points": ["要点1", "要点2"]
    }
  ]
}
问题需要：
- 贴近日常行为面试/技术面常见问法
- 适合围绕候选人经历展开`.trim();
  }
  if (docType === 'project_notes') {
    return `
你是一名技术面试官，根据项目说明文档生成围绕该项目的面试问题。
只输出 JSON：
{
  "questions": [
    {
      "question": "英文问题",
      "source_section": "overview | problem_statement | methods | workflow | deployment | maintenance | advantages | challenges | results | future_improvements",
      "suggested_answer_points": ["要点1", "要点2"]
    }
  ]
}
多问“为什么这么设计 / 如何权衡 / 如何维护 / 如何改进”等问题。`.trim();
  }
  if (docType === 'job_description') {
    return `
你是一名招聘面试官，根据 JD 文档生成用于考察候选人的问题。
只输出 JSON：
{
  "questions": [
    {
      "question": "英文问题",
      "source_section": "required_skills | responsibilities | focus_areas | keywords",
      "suggested_answer_points": ["要点1", "要点2"]
    }
  ]
}
问题应帮助你判断候选人与该岗位的匹配度。`.trim();
  }
  // qa_notes：可以衍生少量 follow-up 问题
  return `
你是一名面试教练，根据现有 QA 笔记为候选人生成少量 follow-up 问题。
只输出 JSON：
{
  "questions": [
    {
      "question": "英文问题",
      "source_section": "qa",
      "suggested_answer_points": ["要点1", "要点2"]
    }
  ]
}
重点提出追问、澄清、深挖问题。`.trim();
}

function buildContextSnippet(docType: ContextDocType, structured: any, chunks: SemanticChunk[]): string {
  const head = `Below is the structured summary and several semantic sections of the document.\nUse them to design ${docType} related interview questions.\n`;
  const structPart = structured ? JSON.stringify(structured).slice(0, 4000) : '';

  const chunkPart = chunks
    .slice(0, 8)
    .map(c => `[${c.section}]\n${c.text}`)
    .join('\n\n');

  return `${head}\n[STRUCTURED]\n${structPart}\n\n[SECTIONS]\n${chunkPart}`;
}

