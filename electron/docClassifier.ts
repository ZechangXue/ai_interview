import type { ContextDocType, ContextLabel } from './types';

// 轻量级启发式分类器：不依赖 LLM，避免增加延迟和成本。
// 仅根据初始 label + 关键词/结构特征，粗分为四类文档类型。

function containsAny(text: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some(p =>
    typeof p === 'string' ? text.includes(p.toLowerCase()) : p.test(text)
  );
}

export function classifyDocumentType(initialLabel: ContextLabel, rawText: string): ContextDocType {
  const text = (rawText || '').toLowerCase();

  // 若文本极短，直接根据 label 兜底，避免误判。
  if (text.length < 200) {
    if (initialLabel === 'Resume') return 'resume';
    if (initialLabel === 'JD') return 'job_description';
    return 'project_notes';
  }

  // 明确 JD 特征
  if (
    initialLabel === 'JD' ||
    containsAny(text, [
      'job description',
      'responsibilities',
      'requirements',
      'what you will do',
      'role summary',
      'key qualifications',
      /we are looking for/i
    ])
  ) {
    return 'job_description';
  }

  // 明确简历特征
  if (
    initialLabel === 'Resume' ||
    containsAny(text, [
      'education',
      'experience',
      'work experience',
      'skills',
      'projects',
      'bachelor',
      'master',
      'curriculum vitae',
      'cv',
      /professional summary/i
    ])
  ) {
    return 'resume';
  }

  // Q&A / QA notes 特征
  if (
    containsAny(text, [
      'q:',
      'q：',
      'a:',
      'a：',
      'qa',
      'question:',
      'answer:',
      /常见问题/,
      /面试题/,
      /问：/,
      /答：/
    ])
  ) {
    return 'qa_notes';
  }

  // 项目笔记特征：架构/流程/挑战/评估等
  if (
    containsAny(text, [
      'architecture',
      'pipeline',
      'workflow',
      'design',
      'implementation',
      'deployment',
      'metrics',
      'evaluation',
      'experiment',
      'results',
      'challenges',
      'future work',
      /系统架构/,
      /方案设计/,
      /实现细节/,
      /上线部署/,
      /实验结果/,
      /效果评估/,
      /后续改进/
    ])
  ) {
    return 'project_notes';
  }

  // 兜底：默认按项目笔记处理，后续可在 QA 管线中细化
  return 'project_notes';
}

