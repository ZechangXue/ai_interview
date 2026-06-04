import type { ContextDocType, SemanticChunk, StructuredDocRecord } from './types';

// 基于结构化 JSON 优先做 section 级分块，退化时再对原文做启发式切段。

export function generateSemanticChunks(
  docType: ContextDocType,
  docId: string,
  fullText: string,
  structuredJson?: any
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  const now = Date.now();

  const push = (section: string, text: string | string[] | undefined | null) => {
    if (!text) return;
    const value = Array.isArray(text) ? text.join('\n') : text;
    const trimmed = String(value).trim();
    if (!trimmed) return;
    chunks.push({
      id: '',
      docId,
      docType,
      section,
      text: limitLength(trimmed),
      createdAt: now
    });
  };

  if (structuredJson && typeof structuredJson === 'object') {
    if (docType === 'meeting_doc') {
      // 优先从结构化 JSON 提取摘要块，再追加对原文的 markdown 分块
      const title = typeof structuredJson.title === 'string' ? structuredJson.title : '';
      const summary = typeof structuredJson.summary === 'string' ? structuredJson.summary : '';
      if (summary) push('overview', title ? `${title}\n${summary}` : summary);

      // 技术概念表
      const concepts = Array.isArray(structuredJson.technical_concepts) ? structuredJson.technical_concepts : [];
      if (concepts.length > 0) push('technical_concepts', concepts.join('\n'));

      // 各章节摘要
      const sections = Array.isArray(structuredJson.sections) ? structuredJson.sections : [];
      for (const sec of sections as { title?: string; summary?: string }[]) {
        const t = sec?.title ?? '';
        const s = sec?.summary ?? '';
        if (t && s) push(`section:${t}`, `${t}\n${s}`);
      }

      // Q&A 对：每对单独成 chunk，保留完整问答（检索命中率最高）
      const qaBank = Array.isArray(structuredJson.qa_bank) ? structuredJson.qa_bank : [];
      for (const qa of qaBank as { question?: string; answer?: string }[]) {
        const q = qa?.question?.trim() ?? '';
        const a = qa?.answer?.trim() ?? '';
        if (q && a) push('faq', `Q: ${q}\nA: ${a}`);
        else if (q) push('faq', `Q: ${q}`);
      }

      // 追加原文 markdown 分块（确保原文中细节不丢失）
      const rawChunks = chunkMeetingDocMarkdown(docId, fullText);
      for (const rc of rawChunks) {
        // 去重：跳过和已有 chunk 内容高度重叠的段（简单长度+前缀检查）
        const isDup = chunks.some(
          c => c.section === rc.section && c.text.slice(0, 80) === rc.text.slice(0, 80)
        );
        if (!isDup) chunks.push(rc);
      }

      return chunks;
    } else if (docType === 'project_notes') {
      push('overview', structuredJson.overview);
      push('problem_statement', structuredJson.problem_statement);
      push('methods', structuredJson.methods);
      push('workflow', structuredJson.workflow);
      push('deployment', structuredJson.deployment);
      push('maintenance', structuredJson.maintenance);
      push('advantages', structuredJson.advantages);
      push('challenges', structuredJson.challenges);
      push('results', structuredJson.results);
      push('future_improvements', structuredJson.future_improvements);
    } else if (docType === 'qa_notes') {
      const qaBank = Array.isArray(structuredJson.qa_bank) ? structuredJson.qa_bank : [];
      for (const qa of qaBank) {
        const q = qa?.question ?? '';
        const a = qa?.answer ?? '';
        const combined = [q, a].filter(Boolean).join('\n');
        push('qa', combined);
      }
    } else if (docType === 'resume') {
      push('profile', structuredJson.profile?.summary || structuredJson.summary);
      const exps = Array.isArray(structuredJson.work_experience) ? structuredJson.work_experience : [];
      for (const e of exps) {
        const lines: string[] = [];
        if (e.company || e.title) {
          lines.push(`${e.company ?? ''} ${e.title ?? ''}`.trim());
        }
        if (e.responsibilities) {
          lines.push(...toArray(e.responsibilities));
        }
        if (e.achievements) {
          lines.push(...toArray(e.achievements));
        }
        if (!lines.length) continue;
        push('work_experience', lines.join('\n'));
      }
      const projects = Array.isArray(structuredJson.projects) ? structuredJson.projects : [];
      for (const p of projects) {
        const lines: string[] = [];
        if (p.project_name || p.name) lines.push(p.project_name ?? p.name);
        if (p.summary || p.description) lines.push(p.summary ?? p.description);
        if (p.methods) lines.push(...toArray(p.methods));
        if (p.results) lines.push(...toArray(p.results));
        push('project', lines.join('\n'));
      }
      if (structuredJson.skills) push('skills', toArray(structuredJson.skills));
      if (structuredJson.education) push('education', JSON.stringify(structuredJson.education));
    } else if (docType === 'job_description') {
      push('role_title', structuredJson.role_title);
      push('required_skills', structuredJson.required_skills);
      push('preferred_skills', structuredJson.preferred_skills);
      push('responsibilities', structuredJson.responsibilities);
      push('focus_areas', structuredJson.focus_areas);
      push('keywords', structuredJson.keywords);
      push('summary', structuredJson.summary);
    }
  }

  // 若结构化分块不充分，补充一个基于原文的启发式切段
  if (chunks.length === 0) {
    if (docType === 'meeting_doc') {
      // meeting_doc 直接用 markdown 感知分块
      return chunkMeetingDocMarkdown(docId, fullText);
    }
    const heuristic = splitByHeadings(fullText);
    for (const h of heuristic) {
      chunks.push({
        id: '',
        docId,
        docType,
        section: h.section,
        text: limitLength(h.text),
        createdAt: now
      });
    }
  }

  return chunks;
}

function toArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x));
  return [String(v)];
}

function limitLength(text: string, maxChars: number = 1200): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + ' ...';
}

/**
 * Markdown 感知分块：专门处理项目/产品文档中常见的表格、FAQ、章节结构。
 * - ## 标题 → 新章节边界
 * - ### FAQ 项 → Q&A 对整体作为一个 chunk
 * - | 表格行 → 每条数据行 + 表头 → 一个 chunk（列名: 值 格式）
 * - 普通段落 → 按 ~800 字符切块，携带当前章节标题作为上下文
 */
function chunkMeetingDocMarkdown(docId: string, fullText: string): SemanticChunk[] {
  const lines = fullText.split('\n');
  const chunks: SemanticChunk[] = [];
  const now = Date.now();

  let currentSection = 'body';
  let tableHeader: string[] = [];
  let faqQuestion = '';
  let faqLines: string[] = [];
  let sectionBuffer: string[] = [];

  const pushChunk = (section: string, text: string) => {
    const t = text.trim();
    if (t.length < 20) return;
    chunks.push({ id: '', docId, docType: 'meeting_doc', section, text: limitLength(t), createdAt: now });
  };

  const flushBuffer = () => {
    if (sectionBuffer.length === 0) return;
    const text = sectionBuffer.join('\n').trim();
    if (text) pushChunk(currentSection, text);
    sectionBuffer = [];
  };

  const flushFaq = () => {
    if (!faqQuestion) return;
    const answer = faqLines.join('\n').trim().replace(/^\*\*A:\*\*\s*/i, '').replace(/^A:\s*/i, '');
    const text = answer ? `Q: ${faqQuestion}\nA: ${answer}` : `Q: ${faqQuestion}`;
    pushChunk('faq', text);
    faqQuestion = '';
    faqLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // H1 — 文档标题，不单独成 chunk，仅记录
    if (/^#\s+[^#]/.test(rawLine)) {
      flushBuffer();
      flushFaq();
      tableHeader = [];
      continue;
    }

    // H2 — 章节边界
    if (/^##\s+[^#]/.test(rawLine)) {
      flushBuffer();
      flushFaq();
      currentSection = line.replace(/^#+\s*/, '');
      tableHeader = [];
      continue;
    }

    // H3 — FAQ 项 或 子章节
    if (/^###\s+/.test(rawLine)) {
      flushBuffer();
      flushFaq();
      const title = line.replace(/^#+\s*/, '');
      // 判断是否是 FAQ 式（数字序号 / 疑问词开头）
      const isFaqItem =
        /^\d+[).]/.test(title) ||
        /^(why|what|how|when|where|which|can|should|is |are |do |does )\b/i.test(title);
      if (isFaqItem) {
        faqQuestion = title;
        faqLines = [];
      } else {
        currentSection = title;
      }
      tableHeader = [];
      continue;
    }

    // 表格分隔行 |---|---|
    if (/^\|[\s\-|]+\|$/.test(line)) continue;

    // 表格数据行
    if (line.startsWith('|') && line.endsWith('|')) {
      flushBuffer();
      flushFaq();
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (tableHeader.length === 0) {
        tableHeader = cells;
      } else {
        const parts: string[] = [`[${currentSection}]`];
        for (let i = 0; i < Math.min(tableHeader.length, cells.length); i++) {
          if (cells[i] && cells[i] !== '---') {
            parts.push(`${tableHeader[i]}: ${cells[i]}`);
          }
        }
        if (parts.length > 1) pushChunk(currentSection, parts.join('\n'));
      }
      continue;
    }

    // 空行：在普通段落中触发缓冲区刷新
    if (!line) {
      if (faqQuestion) {
        // FAQ 内部空行继续积累
      } else {
        const bufText = sectionBuffer.join('\n').trim();
        if (bufText.length > 300) flushBuffer();
        else if (sectionBuffer.length > 0) sectionBuffer.push('');
      }
      continue;
    }

    // 非表格区域重置表头
    if (!line.startsWith('|')) tableHeader = [];

    // FAQ 内容行
    if (faqQuestion) {
      faqLines.push(line);
      continue;
    }

    // 普通段落内容
    sectionBuffer.push(rawLine);
    if (sectionBuffer.join('\n').length > 800) flushBuffer();
  }

  flushBuffer();
  flushFaq();

  return chunks;
}

function splitByHeadings(text: string): { section: string; text: string }[] {
  const lines = (text || '').split('\n');
  const sections: { section: string; text: string }[] = [];
  let currentSection = 'body';
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) {
      sections.push({ section: currentSection, text: joined });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      buffer.push(rawLine);
      continue;
    }

    const lower = line.toLowerCase();

    if (/^(overview|summary)[:：]/i.test(line)) {
      flush();
      currentSection = 'overview';
      continue;
    }
    if (/^(problem|problem statement)[:：]/i.test(line) || /问题陈述/.test(line)) {
      flush();
      currentSection = 'problem_statement';
      continue;
    }
    if (/^(method|approach)[:：]/i.test(line) || /方法/.test(line)) {
      flush();
      currentSection = 'methods';
      continue;
    }
    if (/^(workflow|pipeline|architecture)[:：]/i.test(line) || /流程|架构/.test(line)) {
      flush();
      currentSection = 'workflow';
      continue;
    }
    if (/^(deployment)[:：]/i.test(line) || /部署/.test(line)) {
      flush();
      currentSection = 'deployment';
      continue;
    }
    if (/^(maintenance|monitoring)[:：]/i.test(line) || /维护|监控/.test(line)) {
      flush();
      currentSection = 'maintenance';
      continue;
    }
    if (/^(advantages|benefits|pros)[:：]/i.test(line) || /优势|优点/.test(line)) {
      flush();
      currentSection = 'advantages';
      continue;
    }
    if (/^(challenges|limitations|cons)[:：]/i.test(line) || /挑战|难点|缺点/.test(line)) {
      flush();
      currentSection = 'challenges';
      continue;
    }
    if (/^(results|evaluation|metrics)[:：]/i.test(line) || /结果|效果|指标/.test(line)) {
      flush();
      currentSection = 'results';
      continue;
    }
    if (/^(future work|future improvements)[:：]/i.test(line) || /改进方向|后续工作/.test(line)) {
      flush();
      currentSection = 'future_improvements';
      continue;
    }

    buffer.push(rawLine);
  }

  flush();
  return sections;
}

