export interface AssistJSON {
  question_zh: string;
  /** 极简模式下一句英文回答，可直接朗读，独立成句 */
  concise_answer_en?: string;
  /** 已废弃：极简模式不再输出中文思路，保留字段仅为兼容 */
  thinking_zh?: string;
  keywords_en: string[];
}

export interface ReadableAssistJSON {
  question_zh: string;
  concise_answer_en: string;
  expanded_answer_en: string;
}

export type ResponseStyle = 'concise' | 'readable';

/** API 服务商：OpenAI、Google Gemini、DeepSeek、千问、Ollama 本地 */
export type ApiProvider = 'openai' | 'google' | 'deepseek' | 'qwen' | 'ollama';

export type ContextLabel = 'JD' | 'Resume' | 'Notes' | 'Doc';

// 统一的文档类型，用于后续结构化 / 分块 / 检索等管线
export type ContextDocType = 'resume' | 'job_description' | 'qa_notes' | 'project_notes' | 'meeting_doc';

export interface ContextFile {
  id: string;
  fileName: string;
  label: ContextLabel;
  summary: string;
  createdAt: number;
  /** 本文件是否已完成 RAG 索引构建（用于 UI 提示） */
  ragIndexed?: boolean;
  /** 原始全文内容，用于在设置中统一进行结构化分析 */
  rawText?: string;
  /** 归一化后的文档类型（与 label 解耦，支持 resume / job_description / qa_notes / project_notes） */
  docType?: ContextDocType;
  /** 本文件的语义分块与向量是否已完成构建 */
  chunksIndexed?: boolean;
}

export interface ContextSummary {
  jd: string;
  resume: string;
  notes: string;
}

// 结构化 JSON 文档记录（与具体文件关联）
export interface StructuredDocRecord {
  id: string;
  docId: string;
  docType: ContextDocType;
  json: any;
  createdAt: number;
}

// 语义分块（section 级别）
export interface SemanticChunk {
  id: string;
  docId: string;
  docType: ContextDocType;
  section: string;
  text: string;
  createdAt: number;
}

// 预生成面试问题
export interface GeneratedQuestion {
  id: string;
  sourceDocId: string;
  sourceSection: string;
  docType: ContextDocType;
  question: string;
  embedding: number[];
  createdAt: number;
}

// 最近极简回答摘要，用于追问时的轻量记忆
export interface AnswerSummary {
  question_zh: string;
  /** 极简一句英文回答（优先用于摘要） */
  concise_answer_en: string;
  /** 可读模式下的展开回答；追问时优先注入 [CONVERSATION]，避免模型只看到一句而接不上 */
  expanded_answer_en?: string;
  /** 兼容旧数据 */
  thinking_zh?: string;
  keywords_en?: string[];
  createdAt: number;
}

export interface Settings {
  /** 当前选中的 API 服务商 */
  apiProvider: ApiProvider;
  model: string;
  systemPrompt: string;
  mockAsr: boolean;
  mockLlm: boolean;
  listening: boolean;
  useRealtimeAsr: boolean;
  /** 已固定为 true（流式）；保留字段以兼容旧版 settings.json */
  useStreamingLlm: boolean;
  useRealtimeAllInOne: boolean; // 仅 OpenAI 支持；其它服务商用流式 Chat 等效
  responseStyle: ResponseStyle;
  audioDeviceId: number; // -1 = 系统默认
  /** 窗口不透明度（0-1），用于在面试界面上方半透明悬浮 */
  windowOpacity?: number;
  /** Ollama 本地 base URL，如 http://localhost:11434 */
  ollamaBaseUrl: string;
  /**
   * 为 true 时：展示答题卡期间仍保持监听；识别到下一道完整问题时自动切到新卡片（仍可手动关闭）。
   * 为 false 时：与旧版一致，弹出卡片后暂停监听，需手动关闭卡片后才继续听下一题。
   */
  autoDismissCardOnNewQuestion: boolean;
  /** 组会/项目介绍模式：上传项目文档，根据文档内容实时答疑 */
  meetingMode?: boolean;
  /** 答案语言：'en' 英文（默认）/ 'zh' 中文 */
  answerLanguage?: 'en' | 'zh';
}

// 流式 LLM 更新事件（兼容两种模式的所有字段）
export interface AssistStreamChunk {
  partial: Partial<AssistJSON & ReadableAssistJSON>;
  done: boolean;
  /** Realtime 一体：本轮面试官音频的独立语音转写（Whisper）；段式路径在 main 写入 combined，不经由此字段 */
  interviewerTranscript?: string;
}

export interface AssistEventPayload {
  assist: AssistJSON;
  queueSize: number;
  timestamp: number;
}

export interface ListenerStatus {
  listening: boolean;
}

/** 模型/解析层表示「本轮无有效问题」——与 isNoiseOrUnrecognizedQuestionZh 配合，不弹卡、不入实录、继续听 */
export const SKIP_TURN_QUESTION_ZH = '无法确定问题';

/**
 * 是否应静默跳过本轮答题卡（杂音、无问题、JSON 缺字段等统一走哨兵）。
 * 只认「无法确定问题」子串，避免误伤正常题干里单独的「无法确定」。
 */
export function isNoiseOrUnrecognizedQuestionZh(q: string | undefined | null): boolean {
  const s = (q ?? '').trim();
  return s.includes(SKIP_TURN_QUESTION_ZH);
}

