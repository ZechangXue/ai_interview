/**
 * 仅在注入 LLM prompt 前裁剪简历 JSON：不修改资料库存储。
 * - 工作经历 + 项目经历合计最多 topK 条（默认 4）
 * - 有 JD / 当前问题时按词袋相关性打分；否则按简历数组顺序取前 K（通常即最近几段）
 * - Prompt 内只保留 work_experience / projects（+ type 标记），不含根 summary、profile、skills、education
 */

export const RESUME_JD_TOP_EXPERIENCES = 4;
/** 每条 work / project 最多保留的职责或要点条数 */
export const RESUME_MAX_BULLETS_PER_BLOCK = 4;

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function buildJdScoringText(jd: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v);
    else if (Array.isArray(v)) parts.push(v.map(x => String(x)).join(' '));
  };
  add(jd.summary);
  add(jd.role_title);
  add(jd.responsibilities);
  add(jd.required_skills);
  add(jd.preferred_skills);
  add(jd.keywords);
  add(jd.focus_areas);
  return parts.join('\n');
}

function tokenizeWeighted(text: string, weight: number): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (tok: string, w: number) => {
    const t = tok.trim();
    if (t.length < 2) return;
    m.set(t, (m.get(t) ?? 0) + w);
  };

  for (const x of text.toLowerCase().match(/[a-z][a-z0-9+.#-]{2,}|\d+[a-z%]*/gi) ?? []) {
    bump(x.toLowerCase(), weight);
  }
  for (const x of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    bump(x, weight * 1.5);
  }
  return m;
}

function mergeWeights(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

function scoreAgainstWeights(text: string, weights: Map<string, number>): number {
  if (!text || weights.size === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const [tok, w] of weights) {
    if (tok.length < 2) continue;
    if (/[\u4e00-\u9fff]/.test(tok)) {
      if (text.includes(tok)) score += w * 2;
    } else if (lower.includes(tok)) {
      score += w;
    }
  }
  return score;
}

type Scored = {
  kind: 'work' | 'project';
  idx: number;
  score: number;
  order: number;
};

/** 无 JD、无可用问题时：按文档顺序取前 topK 个「槽位」（先工作经历，再项目） */
function pickTopKByDocumentOrder(
  workLen: number,
  projectLen: number,
  topK: number
): { workIdx: Set<number>; projIdx: Set<number> } {
  const workIdx = new Set<number>();
  const projIdx = new Set<number>();
  let taken = 0;
  for (let i = 0; i < workLen && taken < topK; i++) {
    workIdx.add(i);
    taken++;
  }
  for (let i = 0; i < projectLen && taken < topK; i++) {
    projIdx.add(i);
    taken++;
  }
  return { workIdx, projIdx };
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 3)}...`;
}

/** 压缩单条 project */
function slimProjectRow(
  p: Record<string, unknown>,
  maxBullets: number
): Record<string, unknown> {
  const tech = Array.isArray(p.tech_stack) ? p.tech_stack.slice(0, 8).map(String) : [];
  const ach = Array.isArray(p.achievements) ? p.achievements.slice(0, maxBullets).map(String) : [];
  const desc =
    typeof p.description === 'string'
      ? truncate(p.description, 280)
      : '';
  return {
    name: p.name ?? '',
    role: p.role ?? '',
    ...(desc ? { description: desc } : {}),
    ...(tech.length ? { tech_stack: tech } : {}),
    ...(ach.length ? { achievements: ach } : {})
  };
}

/** 压缩单条 work */
function slimWorkRow(w: Record<string, unknown>, maxBullets: number): Record<string, unknown> {
  const raw = Array.isArray(w.responsibilities) ? w.responsibilities.map(String) : [];
  return {
    company: w.company ?? '',
    title: w.title ?? '',
    location: w.location ?? '',
    start_date: w.start_date ?? '',
    end_date: w.end_date ?? '',
    responsibilities: raw.slice(0, maxBullets)
  };
}

/**
 * 将简历 JSON 压成适合 prompt 的体量：最多 topK 段经历 + 精简字段。
 * 始终会处理（只要解析成功）；不再在「无 JD」时退回全文。
 */
export function prepareResumeJsonForPrompt(
  resumeJsonStr: string,
  jdJsonStr: string,
  opts?: {
    questionHint?: string;
    topK?: number;
    maxBulletsPerBlock?: number;
  }
): string {
  const topK = opts?.topK ?? RESUME_JD_TOP_EXPERIENCES;
  const maxBullets = opts?.maxBulletsPerBlock ?? RESUME_MAX_BULLETS_PER_BLOCK;

  const trimmedResume = resumeJsonStr.trim();
  if (!trimmedResume) return resumeJsonStr;

  const resume = safeParseJson(trimmedResume);
  if (!resume) return resumeJsonStr;

  const work = Array.isArray(resume.work_experience)
    ? (resume.work_experience as Record<string, unknown>[])
    : [];
  const projects = Array.isArray(resume.projects) ? (resume.projects as Record<string, unknown>[]) : [];

  let workIdx: Set<number>;
  let projIdx: Set<number>;

  const trimmedJd = jdJsonStr.trim();
  let weights = new Map<string, number>();
  if (trimmedJd) {
    const jdObj = safeParseJson(trimmedJd);
    if (jdObj) {
      const jdText = buildJdScoringText(jdObj);
      weights = mergeWeights(weights, tokenizeWeighted(jdText + '\n' + trimmedJd.slice(0, 12000), 1));
    } else {
      weights = mergeWeights(weights, tokenizeWeighted(trimmedJd.slice(0, 12000), 1));
    }
  }
  const hint = opts?.questionHint?.trim();
  if (hint) {
    weights = mergeWeights(weights, tokenizeWeighted(hint, 2));
  }

  const totalSlots = work.length + projects.length;
  if (totalSlots <= topK) {
    workIdx = new Set(work.map((_, i) => i));
    projIdx = new Set(projects.map((_, i) => i));
  } else if (weights.size > 0) {
    const scored: Scored[] = [];
    let order = 0;
    work.forEach((w, idx) => {
      const text = [
        w.company,
        w.title,
        w.location,
        ...(Array.isArray(w.responsibilities) ? w.responsibilities : [])
      ]
        .filter(Boolean)
        .map(String)
        .join(' ');
      scored.push({ kind: 'work', idx, score: scoreAgainstWeights(text, weights), order: order++ });
    });
    projects.forEach((p, idx) => {
      const text = [
        p.name,
        p.role,
        p.description,
        ...(Array.isArray(p.tech_stack) ? p.tech_stack : []),
        ...(Array.isArray(p.achievements) ? p.achievements : [])
      ]
        .filter(Boolean)
        .map(String)
        .join(' ');
      scored.push({ kind: 'project', idx, score: scoreAgainstWeights(text, weights), order: order++ });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    const picked = scored.slice(0, topK);
    workIdx = new Set(picked.filter(p => p.kind === 'work').map(p => p.idx));
    projIdx = new Set(picked.filter(p => p.kind === 'project').map(p => p.idx));
  } else {
    const pick = pickTopKByDocumentOrder(work.length, projects.length, topK);
    workIdx = pick.workIdx;
    projIdx = pick.projIdx;
  }

  const slimWork = work.filter((_, i) => workIdx.has(i)).map(w => slimWorkRow(w, maxBullets));
  const slimProj = projects.filter((_, i) => projIdx.has(i)).map(p => slimProjectRow(p, maxBullets));

  // 岗位语境来自 [JD]；个人叙事已在各段经历里，避免 summary/profile 重复占 token
  const out: Record<string, unknown> = {
    type: resume.type ?? 'resume',
    work_experience: slimWork,
    projects: slimProj
  };

  try {
    return JSON.stringify(out);
  } catch {
    return resumeJsonStr;
  }
}

/** @deprecated 使用 prepareResumeJsonForPrompt（行为已包含无 JD 时的裁剪） */
export function narrowResumeJsonForJd(
  resumeJsonStr: string,
  jdJsonStr: string,
  opts?: { questionHint?: string; topK?: number }
): string {
  return prepareResumeJsonForPrompt(resumeJsonStr, jdJsonStr, opts);
}
