import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import OpenAI from 'openai';
import type { ContextDocType } from './types';
import { getApiKey } from './settingsStore';

function splitIntoChunks(text: string, maxChars = 600): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    const candidate = current ? current + '\n' + p : p;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export type AnalyzeDocumentForRagOptions = {
  /** 已分析好的 JD 结构化 JSON；分析简历时传入，用于优选与岗位最相关的 4 条经历 */
  jdStructuredJson?: string;
};

function buildResumeAnalysisSystemPrompt(hasJdHint: boolean): string {
  const jdRule = hasJdHint
    ? `用户消息中会附带「目标岗位 JD」的结构化 JSON（已由前一步分析完成）。请根据其中的技能、职责、业务领域，优先选取与 JD **最相关**的工作经历与项目，**合计 4 条**（可混合）；与 JD 明显无关的可不选。若相关条目不足 4 条，用简历里**时间最近**的其它经历补足（end_date 越靠近 Present 越优先，或按文档中时间线判断）。`
    : `当前未提供 JD。请从简历中按**时间最近**原则选取工作经历与项目**合计 4 条**（根据 start_date、end_date、Present 等判断，最近的优先；工作与项目可混合）。`;

  return `
你是一名简历结构化助手。请从用户消息中的简历正文提取信息，**只**输出 JSON，且**仅包含**以下键：type、work_experience、projects。禁止输出 summary、profile、skills、education 或任何其它键。

{
  "type": "resume",
  "work_experience": [
    {
      "company": "公司或部门名称",
      "title": "职位名称",
      "location": "城市/地区",
      "start_date": "起始时间（原文）",
      "end_date": "结束时间或 Present",
      "responsibilities": ["职责或成就1", "职责或成就2"]
    }
  ],
  "projects": [
    {
      "name": "项目名称",
      "role": "角色",
      "tech_stack": ["技术1"],
      "description": "简介",
      "achievements": ["成果1"]
    }
  ]
}

规则：
- work_experience 与 projects **合计最多 4 条**（每条列表项算一条）；超出则删去相关性最低或时间最旧的。
- 每一段 work 的 responsibilities、每一段 project 的 achievements **各最多 4 句**，须为完整句子，便于朗读。
${jdRule}
`.trim();
}

function resumeStructuredToSummary(obj: { work_experience?: unknown[]; projects?: unknown[] }): string {
  const w = Array.isArray(obj.work_experience) ? obj.work_experience : [];
  const p = Array.isArray(obj.projects) ? obj.projects : [];
  const labels: string[] = [];
  for (const e of w as { company?: string; title?: string }[]) {
    const c = e?.company ?? '';
    const t = e?.title ?? '';
    if (c || t) labels.push([c, t].filter(Boolean).join(' · '));
  }
  for (const x of p as { name?: string }[]) {
    const n = x?.name ?? '';
    if (n) labels.push(`项目：${n}`);
  }
  const head = `已结构化 ${w.length} 段工作 + ${p.length} 个项目（合计≤4，JD 相关优先或按时间近）`;
  const tail = labels.length ? `：${labels.join('；')}`.slice(0, 400) : '';
  return (head + tail).slice(0, 2000);
}

// 使用 LLM 辅助结构化：按文档类型输出 summary + 结构化 JSON 字符串
export async function analyzeDocumentForRag(
  docType: ContextDocType,
  fullText: string,
  options?: AnalyzeDocumentForRagOptions
): Promise<{ summary: string; structured: string }> {
  const t0 = Date.now();
  const apiKey = await getApiKey('openai');
  if (!apiKey) {
    // 无 Key 时退化为简单截断
    const cleaned = fullText.replace(/\s+/g, ' ').trim();
    return {
      summary: cleaned.slice(0, 2000),
      structured: ''
    };
  }

  const client = new OpenAI({ apiKey });

  const resumeSys = buildResumeAnalysisSystemPrompt(!!options?.jdStructuredJson?.trim());

  const instructionByType: Record<ContextDocType, string> = {
    resume: resumeSys,
    job_description: `
你是一名 JD 结构化助手。请从下面的 JD 文本中提取与岗位相关的结构化信息。
严格输出 JSON：
{
  "type": "job_description",
  "summary": "用中文或英文概括 JD 的核心职责与要求，2-4句",
  "role_title": "岗位名称（英文或原文）",
  "required_skills": ["必需技能1", "必需技能2"],
  "preferred_skills": ["加分项技能1", "加分项技能2"],
  "responsibilities": ["职责1", "职责2"],
  "keywords": ["关键词1", "关键词2"],
  "focus_areas": ["面试/考察重点1", "面试/考察重点2"]
}
每条 responsibilities / skills / focus_areas 都要尽量短、聚焦一个要点。`.trim(),
    qa_notes: `
你是一名面试 QA 笔记整理助手。下面是候选人准备的问答笔记或零散要点。
请尽量识别 Q&A 结构，严格输出 JSON：
{
  "type": "qa_notes",
  "summary": "用中文概括 QA 笔记中的主要话题，2-3句",
  "qa_bank": [
    {
      "question": "问题（若能识别）",
      "answer": "对应的回答或要点",
      "tags": ["标签1", "标签2"]
    }
  ]
}
无法可靠拆分为问答的内容可以合并成若干较长的 answer。`.trim(),
    project_notes: `
你是一名项目说明文档结构化助手。下面是候选人写的项目笔记 / 方案说明 / 复盘。
请按以下 schema 严格输出 JSON：
{
  "type": "project_notes",
  "summary": "用中文或英文概括该项目的目的与结果，2-4句",
  "project_name": "",
  "overview": "",
  "problem_statement": "",
  "methods": [],
  "workflow": [],
  "deployment": "",
  "maintenance": "",
  "advantages": [],
  "challenges": [],
  "results": [],
  "future_improvements": []
}
各字段含义：
- overview：概括项目背景与目标，2-3 句
- problem_statement：要解决的核心问题
- methods：用到的重要方法/技术/算法列表，每项一句话
- workflow：按步骤描述 pipeline / 流程，每步一句话
- deployment：上线/部署方式
- maintenance：监控、报警、运维相关
- advantages：方案/项目的优势亮点列表
- challenges：遇到的困难（可包含解决思路）
- results：最终指标或业务结果
- future_improvements：后续可改进方向`.trim(),
    meeting_doc: `
你是一名智能文档理解助手，专门服务于组会/项目答疑场景。请深度分析以下文档，提取结构化信息以支持后续的实时问答。

严格输出 JSON（所有字段必须有值，无内容填空字符串或空数组）：
{
  "type": "meeting_doc",
  "title": "文档标题（从文档第一行或标题提取）",
  "summary": "文档整体摘要（4-6句，完整覆盖：文档目的、核心系统/产品/项目是什么、主要技术方案/架构、核心结论或亮点）",
  "domain": "文档所属领域（如：AI/医疗/工程/产品/研究/其他）",
  "key_topics": ["核心话题1", "核心话题2", "核心话题3"],
  "technical_concepts": [
    "概念名称: 一句话定义或说明"
  ],
  "qa_bank": [
    {
      "question": "问题原文（尽量保留原文措辞）",
      "answer": "完整答案要点（保留所有关键信息，不要过度压缩）",
      "tags": ["相关标签1", "相关标签2"]
    }
  ],
  "sections": [
    {
      "title": "章节/模块名称",
      "summary": "该章节核心内容摘要（2-3句）"
    }
  ]
}

提取规则：
- summary 是回答问题时最重要的全局上下文，必须完整准确
- 若文档包含明确 Q&A/FAQ 结构（如 "### Why..." 或 "Q:" 开头），完整提取每一对，答案不要截断
- technical_concepts 提取文档中出现的所有专有名词、技术术语、架构组件，并给出简短解释
- sections 按文档的自然结构（标题/章节）来划分，每个章节的摘要要抓住该节的核心信息
- 对于表格型内容，在 summary 中概括表格整体含义，在 sections 中列出表格所在章节
- 保留技术细节（如具体的技术栈、参数、指标），不要过度抽象`.trim()
  };

  const sys = instructionByType[docType];
  const t1 = Date.now();
  console.log(`[RAG-TIME] analyzeDocumentForRag: 构造指令完成 (docType=${docType}) +${t1 - t0}ms`);

  // 简历/JD 分析目前只用于生成摘要和结构化 JSON，
  // 不在实时问答主链路里，但如果耗时过长会影响上传体验。
  // 这里使用延迟更低的 gpt-4o-mini，同时仅做非常宽松的截断，
  // 尽量覆盖整份简历（包括尾部的 RESEARCH EXPERIENCE 等重要段落），并打印 Prompt 便于排查。
  const userText = fullText.slice(0, 24000);
  const jdPart = options?.jdStructuredJson?.trim()
    ? `=== 目标岗位 JD（结构化，已预分析）===\n${options.jdStructuredJson.trim().slice(0, 14000)}`
    : '';
  const userContent =
    docType === 'resume' && jdPart
      ? `${jdPart}\n\n=== 简历全文 ===\n${userText}`
      : userText;

  console.log('[RAG-PROMPT] analyzeDocumentForRag');
  console.log('  model = gpt-4o-mini, docType =', docType);
  if (docType === 'resume') {
    console.log('  jdHint =', jdPart ? `yes (${jdPart.length} chars)` : 'no');
  }
  console.log('  [system]');
  console.log(sys);
  console.log('  [user text snippet]');
  console.log(userContent.slice(0, 4000));

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userContent }
    ]
  });
  const t2 = Date.now();
  console.log(`[RAG-TIME] analyzeDocumentForRag: LLM 调用完成 (docType=${docType}) +${t2 - t1}ms, 自函数起总计 +${t2 - t0}ms`);

  let summary = '';
  let structured: any = null;

  try {
    const obj = JSON.parse(res.choices[0]?.message?.content ?? '{}');
    if (docType === 'resume') {
      structured = {
        type: 'resume',
        work_experience: Array.isArray(obj.work_experience) ? obj.work_experience : [],
        projects: Array.isArray(obj.projects) ? obj.projects : []
      };
      summary = resumeStructuredToSummary(structured);
    } else if (docType === 'meeting_doc') {
      summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      if (obj.title && summary) summary = `【${obj.title}】${summary}`;
      structured = obj;
    } else {
      summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      structured = obj;
    }
  } catch (e) {
    console.error('[RAG] analyzeDocumentForRag parse error', e);
  }

  if (!summary) {
    const cleaned = fullText.replace(/\s+/g, ' ').trim();
    summary = cleaned.slice(0, 2000);
  }
  const t3 = Date.now();
  console.log(
    `[RAG-TIME] analyzeDocumentForRag: 结果整理完成 (docType=${docType}) +${t3 - t2}ms, 自函数起总计 +${t3 - t0}ms`
  );
  const structuredJson = structured ? JSON.stringify(structured) : '';
  const maxStructured = docType === 'resume' ? 20000 : 4000;
  return { summary, structured: structuredJson ? structuredJson.slice(0, maxStructured) : '' };
}


