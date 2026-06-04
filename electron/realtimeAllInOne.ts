/**
 * RealtimeAllInOne
 *
 * 使用 gpt-4o-mini-realtime-preview 模型直接听音频并输出面试提词 JSON。
 * 架构：音频实时推送 → 模型边听边理解 → VAD 检测停顿 → 模型立刻输出 JSON（流式）
 * 对比传统方案：省去了 Whisper 转写延迟 + 单独 LLM 调用，感知延迟 ~300ms。
 */

import EventEmitter from 'node:events';
import portAudio from 'naudiodon';
import WebSocket from 'ws';
import {
  isWASAPILoopbackSupported,
  startWASAPILoopback,
  stopWASAPILoopback
} from './wasapiLoopbackCapture';
import {
  buildRecentConversationBlock,
  buildResumeForLlmPrompt,
  capStructuredJsonForPrompt,
  formatContextInstructionBlock,
  MEETING_SYSTEM_PROMPT
} from './llmClient';
import {
  isNoiseOrUnrecognizedQuestionZh,
  type AnswerSummary,
  type AssistStreamChunk,
  type ContextSummary,
  type ResponseStyle
} from './types';

export type AllInOneChunkCallback = (chunk: AssistStreamChunk) => void;

export interface AllInOneStartHooks {
  /** 当 response 已 done 但当时还没有 ASR 文本、随后 input_audio_transcription 完成时回调（用于一键导出等晚到写入） */
  onInterviewerTranscriptReady?: (text: string) => void;
}

interface AllInOneOptions {
  apiKey: string;
  /** 默认 gpt-4o-mini-realtime-preview，也可换 gpt-4o-realtime-preview */
  model?: string;
  systemPrompt: string;
  contextSummary: ContextSummary;
  questionsHistory: string[];
  structuredContext?: { jd: string; resume: string; notes: string };
  /** 与 Chat 路径一致：追问时带上最近 User/Assistant 轮次 */
  answerSummaries?: AnswerSummary[];
  deviceId?: number;
  responseStyle?: ResponseStyle;
  /** 组会模式：注入文档全文，模型依据文档内容回答 */
  meetingMode?: boolean;
  meetingDocContent?: string;
  /** 面试模式：CV+JD 全文（替代结构化摘要） */
  interviewDocContent?: string;
}

const SAMPLE_RATE = 24000;
const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEBUG_REALTIME_EVENTS = process.env.REALTIME_DEBUG === '1';

export class RealtimeAllInOne extends EventEmitter {
  private ws: WebSocket | null = null;
  private ai: any | null = null;
  private useWASAPI = false;
  private opts: AllInOneOptions;
  private onChunk: AllInOneChunkCallback | null = null;
  private onInterviewerTranscriptReadyHook: ((text: string) => void) | null = null;
  private running = false;

  // 流式 JSON 解析状态
  private accumulated = '';
  private lastConciseLen = 0;
  private lastExpandedLen = 0;
  private emittedQuestion = false;
  private cardShown = false;
  private finalChunkEmitted = false;
  private t0 = 0;
  private t1 = 0;
  private t4 = 0;
  private lastLevelEmitTime = 0;
  private lastAudioDebugEmitTime = 0;
  private audioDebugChunks = 0;
  private audioDebugRmsSum = 0;
  private audioDebugPeak = 0;
  /** 本轮面试官输入音频的独立转写（与 JSON 里的 question_zh 分离） */
  private userTranscriptTurn = '';
  /** response.text.done 已发出但此时尚无转写，等待 transcription.completed 再交给主进程写导出 */
  private sessionExportAwaitingVerbatim = false;

  constructor(opts: AllInOneOptions) {
    super();
    this.opts = opts;
  }

  async start(onChunk: AllInOneChunkCallback, hooks?: AllInOneStartHooks): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onChunk = onChunk;
    this.onInterviewerTranscriptReadyHook = hooks?.onInterviewerTranscriptReady ?? null;
    await this.openWebSocket();
  }

  /** 只停音频（卡片显示时调用），WebSocket 保持让模型把回复输完 */
  stopAudio(): void {
    if (this.useWASAPI) {
      stopWASAPILoopback();
      this.useWASAPI = false;
    } else {
      try { this.ai?.quit(); } catch {}
    }
    this.ai = null;
    console.log('[AllInOne] 音频已停止（等待模型响应完成）');
  }

  /** 完全停止：音频 + WebSocket */
  stop(): void {
    this.running = false;
    this.onChunk = null;
    this.onInterviewerTranscriptReadyHook = null;
    this.sessionExportAwaitingVerbatim = false;
    this.stopAudio();
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private buildInstructions(): string {
    const {
      systemPrompt,
      contextSummary,
      questionsHistory,
      structuredContext,
      answerSummaries,
      meetingMode,
      meetingDocContent,
      interviewDocContent
    } = this.opts;

    // ── 组会模式：注入文档全文，用会议专属 prompt ──────────────────────────
    if (meetingMode) {
      const conversation = buildRecentConversationBlock(answerSummaries);
      const docBlock = meetingDocContent?.trim()
        ? `[DOCUMENT CONTENT]\n${meetingDocContent.trim()}`
        : `[DOCUMENT CONTENT]\n(No documents uploaded yet. Please upload your project documents first.)`;

      return `${MEETING_SYSTEM_PROMPT}

====================
${docBlock}

[CONVERSATION HISTORY]
Use this to understand the ongoing discussion context. If the current question is a follow-up, build on what was already said.
${conversation}

[OUTPUT FORMAT]
JSON only, no extra text outside the object:
{
  "question_zh": "one-line summary of what was asked (match the language of the question)",
  "concise_answer_en": "direct answer in 2-3 sentences — give the core conclusion and the key reason behind it",
  "expanded_answer_en": "deeper explanation in 4-6 sentences — cover the design reasoning, trade-offs, how it connects to other parts of the system, and any relevant context"
}
Only set question_zh to exactly "无法确定问题" when there is genuinely no recognizable question at all (pure noise). For any real question, always give a substantive answer.

[CURRENT_QUESTION]
(The attendee's utterance in the live audio — respond after each pause.)`;
    }

    // ── 面试模式（默认）────────────────────────────────────────────────────
    const historyJoined = questionsHistory.map((q, i) => `${i + 1}. ${q}`).join('\n');
    const recentTurns = (answerSummaries ?? []).slice(-3);
    const conversation = buildRecentConversationBlock(answerSummaries);

    const historyHint =
      questionsHistory.length > 0
        ? questionsHistory[questionsHistory.length - 1]
        : undefined;

    const instructionBlock = formatContextInstructionBlock('realtime');

    const historyBlock =
      recentTurns.length > 0
        ? ''
        : `

[HISTORY]
${historyJoined || '(none)'}`;

    // 文档上下文：优先全文注入，无文档时回退到结构化摘要
    let docContextBlock: string;
    if (interviewDocContent?.trim()) {
      docContextBlock = `[DOCUMENT CONTENT]\n${interviewDocContent.trim()}`;
    } else {
      const resumeBlock = buildResumeForLlmPrompt(
        structuredContext?.resume,
        contextSummary.resume,
        structuredContext?.jd,
        historyHint
      );
      const jdBlock = structuredContext?.jd?.trim()
        ? capStructuredJsonForPrompt(structuredContext.jd, 'jd')
        : contextSummary.jd?.trim() || '(none)';
      const notesBlock = structuredContext?.notes?.trim()
        ? capStructuredJsonForPrompt(structuredContext.notes, 'notes')
        : contextSummary.notes?.trim() || '(none)';
      docContextBlock = `[RESUME]\n${resumeBlock}\n\n[JD]\n${jdBlock}\n\n[NOTES]\n${notesBlock}`;
    }

    return `${systemPrompt}

====================
[MODE]
Realtime audio: interviewer speaks; after a pause, respond with JSON only (see [OUTPUT] in system prompt).

${docContextBlock}

${instructionBlock}

[CONVERSATION]
${conversation}${historyBlock}

[CURRENT_QUESTION]
(The interviewer's utterance in the **live audio** for this turn—respond to what they just said after each pause.)`;
  }

  private openWebSocket(): Promise<void> {
    const model = this.opts.model ?? DEFAULT_MODEL;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${model}`,
        {
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`
          }
        }
      );

      ws.on('open', () => {
        console.log(`[AllInOne] WebSocket 已连接 (${model})`);

        const instructions = `${this.buildInstructions()}

[CRITICAL REALTIME OUTPUT RULE]
Return exactly one JSON object and nothing else. Do not write prose before or after it.
The object must contain: "question_zh", "concise_answer_en", and "expanded_answer_en".
If you are tempted to answer normally, put that answer inside concise_answer_en and expanded_answer_en instead.`;
        console.log('[AllInOne][Prompt] instructions length =', instructions.length);
        if (DEBUG_REALTIME_EVENTS) {
          console.log('[AllInOne][Prompt] instructions =\n', instructions);
        }

        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model,
            output_modalities: ['text'],
            instructions,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                transcription: {
                  model: 'gpt-4o-mini-transcribe'
                },
                turn_detection: {
                  type: 'server_vad',
                  silence_duration_ms: 700,
                  threshold: 0.5,
                  create_response: true
                }
              }
            }
          }
        }));

        this.ws = ws;
        resolve();
        this.startAudio();
      });

      ws.on('message', (data: Buffer) => this.handleEvent(data));

      ws.on('error', (err: Error) => {
        console.error('[AllInOne] WebSocket 错误:', err.message);
        this.stop();
        reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[AllInOne] WebSocket 已关闭 code=${code} reason=${reason.toString() || '(empty)'}`);
        this.ai?.quit?.();
        this.ai = null;
        this.ws = null;
      });
    });
  }

  private resetResponseState(): void {
    this.accumulated = '';
    this.lastConciseLen = 0;
    this.lastExpandedLen = 0;
    this.emittedQuestion = false;
    this.cardShown = false;
    this.finalChunkEmitted = false;
  }

  private handleEvent(raw: Buffer): void {
    let event: any;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    const type: string = event.type ?? '';

    // 临时诊断：打印所有收到的事件类型及关键字段
    if (DEBUG_REALTIME_EVENTS && !type.includes('audio_buffer') && !type.includes('session.')) {
      const snippet = JSON.stringify(event).slice(0, 300);
      console.log(`[AllInOne][EVT] type=${type} | ${snippet}`);
    }

    if (type === 'error') {
      console.error('[AllInOne] Realtime error:', event.error ?? event);
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      // 上一轮在等晚到转写时，若面试官已开始说下一句，则用当前缓冲（常为空）结束等待，避免 pending 永远不落地
      if (this.sessionExportAwaitingVerbatim && this.onInterviewerTranscriptReadyHook) {
        try {
          this.onInterviewerTranscriptReadyHook(this.userTranscriptTurn.trim());
        } catch (e) {
          console.warn('[AllInOne] onInterviewerTranscriptReadyHook failed', e);
        }
        this.sessionExportAwaitingVerbatim = false;
      }
      this.t0 = Date.now();
      this.t1 = 0;
      this.userTranscriptTurn = '';
      console.log('[⏱ T0][AllInOne] 说话开始');
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const d = event.delta;
      if (typeof d === 'string' && d) this.userTranscriptTurn += d;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t =
        (typeof event.transcript === 'string' && event.transcript) ||
        (typeof event.text === 'string' && event.text) ||
        (event.item?.formatted?.transcript as string) ||
        '';
      if (t.trim()) this.userTranscriptTurn = t.trim();
      if (this.sessionExportAwaitingVerbatim && this.userTranscriptTurn.trim() && this.onInterviewerTranscriptReadyHook) {
        try {
          this.onInterviewerTranscriptReadyHook(this.userTranscriptTurn.trim());
        } catch (e) {
          console.warn('[AllInOne] onInterviewerTranscriptReadyHook failed', e);
        }
        this.sessionExportAwaitingVerbatim = false;
        this.userTranscriptTurn = '';
      }
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      this.t1 = Date.now();
      console.log(`[⏱ T1][AllInOne] 语音停止 +${this.t1 - this.t0}ms (说话时长)`);
    }

    // 模型开始生成回复（通常在 speech_stopped 后几十毫秒）
    if (type === 'response.created') {
      this.t4 = Date.now();
      this.resetResponseState();
      const lag = this.t1 ? `+${this.t4 - this.t1}ms (T1→T4)` : '';
      console.log(`[⏱ T4][AllInOne] 模型开始生成 ${lag}`);
    }

    // 流式文本 delta（JSON 片段）。Realtime GA 使用 response.output_text.delta；
    // 旧 preview 版本使用 response.text.delta，content_part 作为兜底。
    if (
      type === 'response.text.delta' ||
      type === 'response.output_text.delta' ||
      type === 'response.content_part.delta'
    ) {
      const delta =
        typeof event.delta === 'string'
          ? event.delta
          : typeof event.delta?.text === 'string'
            ? event.delta.text
            : typeof event.text === 'string'
              ? event.text
              : '';
      this.accumulated += delta;
      this.parseAndEmit(false);
    }

    // 响应完成
    if (
      type === 'response.text.done' ||
      type === 'response.output_text.done' ||
      type === 'response.content_part.done' ||
      type === 'response.done'
    ) {
      const finalText = this.extractFinalResponseText(event);
      if (finalText && finalText.length > this.accumulated.length) {
        this.accumulated = finalText;
      }
      this.parseAndEmit(true);
      const t6 = Date.now();
      const t1t6 = this.t1 ? `T1→T6: +${t6 - this.t1}ms` : '';
      console.log(`[⏱ T6][AllInOne] 完成 +${t6 - this.t4}ms (LLM) | ${t1t6}`);
    }
  }

  private extractFinalResponseText(event: any): string {
    if (typeof event.text === 'string') return event.text;
    const output = event.response?.output;
    if (!Array.isArray(output)) return '';
    const texts: string[] = [];
    for (const item of output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part?.text === 'string') texts.push(part.text);
        else if (typeof part?.transcript === 'string') texts.push(part.transcript);
      }
    }
    return texts.join('');
  }

  private parseAndEmit(done: boolean): void {
    if (done && this.finalChunkEmitted) return;

    const acc = this.accumulated;
    const partial: any = {};
    let hasUpdate = false;

    // question_zh（等完整字符串）
    if (!this.emittedQuestion) {
      const m = acc.match(/"question_zh"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        partial.question_zh = unescape(m[1]);
        this.emittedQuestion = true;
        hasUpdate = true;
      }
    }

    // 所有模式统一输出 concise + expanded（面试/组会均如此）
    // concise_answer_en（流式打字）
    const conciseMatch = acc.match(/"concise_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (conciseMatch) {
      const val = unescape(conciseMatch[1]);
      if (val.length > this.lastConciseLen) {
        partial.concise_answer_en = val;
        this.lastConciseLen = val.length;
        hasUpdate = true;
      }
    }
    // expanded_answer_en（流式打字）
    const expandedMatch = acc.match(/"expanded_answer_en"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (expandedMatch) {
      const val = unescape(expandedMatch[1]);
      if (val.length > this.lastExpandedLen) {
        partial.expanded_answer_en = val;
        this.lastExpandedLen = val.length;
        hasUpdate = true;
      }
    }

    // done 时用完整 JSON 做最终校准
    if (done) {
      if (DEBUG_REALTIME_EVENTS) {
        console.log(`[AllInOne][ParseDebug] done=true accumulated(len=${acc.length})=${acc.slice(0, 400)}`);
      }
      try {
        const jsonMatch = acc.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const obj = JSON.parse(jsonMatch[0]) as any;
          if (obj.question_zh) partial.question_zh = String(obj.question_zh).trim();
          if (obj.concise_answer_en) partial.concise_answer_en = String(obj.concise_answer_en).trim();
          if (obj.expanded_answer_en) partial.expanded_answer_en = String(obj.expanded_answer_en).trim();
          hasUpdate = true;
        }
      } catch {}

      // Realtime occasionally follows the answer intent but ignores the JSON-only
      // wrapper. Still emit a card instead of dropping the whole turn.
      if (!hasUpdate) {
        const answerText = acc.trim();
        if (answerText) {
          const transcript = this.userTranscriptTurn.trim();
          if (!this.shouldEmitFallbackCard(transcript, answerText)) {
            this.sessionExportAwaitingVerbatim = false;
            this.userTranscriptTurn = '';
            return;
          }
          const paragraphs = answerText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
          const firstSentence =
            answerText.match(/^(.{20,220}?[.!?])(?:\s|$)/)?.[1]?.trim() ||
            paragraphs[0]?.slice(0, 220).trim() ||
            answerText.slice(0, 220).trim();

          partial.question_zh = transcript || '当前问题';
          partial.concise_answer_en = firstSentence;
          partial.expanded_answer_en = paragraphs.length > 1 ? paragraphs.join('\n\n') : answerText;
          hasUpdate = true;
          this.emittedQuestion = true;
        }
      }
    }

    const transcriptForFiltering = this.userTranscriptTurn.trim();
    const candidateQuestion = String(partial.question_zh ?? '').trim();
    const candidateAnswer = partial.concise_answer_en || partial.expanded_answer_en || acc;
    if (
      done &&
      transcriptForFiltering &&
      !this.isLikelyActionableUtterance(transcriptForFiltering) &&
      !this.isLikelyActionableUtterance(candidateQuestion)
    ) {
      this.sessionExportAwaitingVerbatim = false;
      this.userTranscriptTurn = '';
      return;
    }
    if (
      done &&
      !transcriptForFiltering &&
      this.isGenericClarificationAnswer(candidateAnswer)
    ) {
      this.sessionExportAwaitingVerbatim = false;
      this.userTranscriptTurn = '';
      return;
    }

    // 过滤无意义识别
    if (isNoiseOrUnrecognizedQuestionZh(partial.question_zh)) {
      if (done) {
        this.sessionExportAwaitingVerbatim = false;
        this.userTranscriptTurn = '';
      }
      return;
    }

    if (!hasUpdate && !done) return;

    if (!this.cardShown && partial.question_zh) {
      this.cardShown = true;
      const dt = this.t4 ? `+${Date.now() - this.t4}ms` : '';
      console.log(`[⏱ T5][AllInOne] 卡片首次弹出 ${dt} (首字)`);
    }

    if (this.onChunk) {
      const tr = this.userTranscriptTurn.trim();
      this.onChunk({
        partial,
        done,
        ...(done && tr ? { interviewerTranscript: tr } : {})
      });
      if (done) this.finalChunkEmitted = true;
    }

    if (done) {
      const tr = this.userTranscriptTurn.trim();
      const hasValidCard =
        !!partial.question_zh && !isNoiseOrUnrecognizedQuestionZh(partial.question_zh);
      if (hasValidCard && !tr) {
        this.sessionExportAwaitingVerbatim = true;
      } else {
        this.sessionExportAwaitingVerbatim = false;
        if (tr) this.userTranscriptTurn = '';
      }
    }
  }

  private shouldEmitFallbackCard(transcript: string, answerText: string): boolean {
    if (!transcript) return false;
    if (!this.isLikelyActionableUtterance(transcript)) return false;
    if (this.isGenericClarificationAnswer(answerText) && !/[?？]/.test(transcript)) return false;
    return true;
  }

  private isLikelyActionableUtterance(text: string): boolean {
    const s = text.trim().toLowerCase();
    if (!s) return false;
    const normalized = s.replace(/[^\p{L}\p{N}\s?？]/gu, '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    const nonQuestions = [
      /^(i'?ll|i will) see you$/,
      /^see you$/,
      /^bye( bye)?$/,
      /^goodbye$/,
      /^thank(s| you)( very much)?$/,
      /^okay$/,
      /^ok$/,
      /^yeah$/,
      /^yes$/,
      /^no$/,
      /^sure$/,
      /^great$/,
      /^sounds good$/,
      /^go ahead$/,
      /^please continue$/
    ];
    if (nonQuestions.some(re => re.test(normalized))) return false;

    if (/[?？]/.test(text)) return true;
    if (/[\u4e00-\u9fff]/.test(text)) {
      return /(什么|为什么|怎么|如何|哪个|哪些|是否|能否|可否|请.*(介绍|描述|解释|说明|讲|回答)|介绍一下|描述一下|解释一下|说明一下|讲一下)/.test(text);
    }

    return /\b(what|why|how|when|where|which|who|can you|could you|would you|do you|did you|are you|is it|tell me|describe|explain|walk me through|talk about|introduce|clarify|elaborate|compare|summarize|give me|show me)\b/.test(normalized);
  }

  private isGenericClarificationAnswer(text: string | undefined): boolean {
    const s = (text ?? '').toLowerCase();
    return /could you (please )?(clarify|let me know)|let me know what specific|what specific (detail|aspect)|go ahead whenever|i'?m here to help|sure, let me clarify/.test(s);
  }

  private startAudio(): void {
    if (!this.running || this.ai) return;

    const deviceId = this.opts.deviceId ?? -1;
    const useWASAPI =
      process.platform === 'win32' &&
      deviceId === -1 &&
      isWASAPILoopbackSupported();

    const onChunk = (chunk: Buffer): void => {
      const now = Date.now();
      const sampleCount = chunk.length / 2;
      let rms = 0;
      if (sampleCount > 0) {
        let sum = 0;
        for (let i = 0; i < sampleCount; i++) sum += Math.abs(chunk.readInt16LE(i * 2)) / 32768;
        rms = sum / sampleCount;
        if (DEBUG_REALTIME_EVENTS) {
          this.audioDebugChunks++;
          this.audioDebugRmsSum += rms;
          if (rms > this.audioDebugPeak) this.audioDebugPeak = rms;
        }
      }

      if (DEBUG_REALTIME_EVENTS && now - this.lastAudioDebugEmitTime >= 1000) {
        if (this.audioDebugChunks > 0) {
          console.log(
            `[AllInOne][AudioDebug] chunks=${this.audioDebugChunks} avgRms=${(this.audioDebugRmsSum / this.audioDebugChunks).toFixed(5)} peakRms=${this.audioDebugPeak.toFixed(5)} ws=${this.ws?.readyState ?? 'none'}`
          );
        }
        this.lastAudioDebugEmitTime = now;
        this.audioDebugChunks = 0;
        this.audioDebugRmsSum = 0;
        this.audioDebugPeak = 0;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64')
      }));
      if (now - this.lastLevelEmitTime >= 100) {
        this.lastLevelEmitTime = now;
        this.emit('level', rms);
      }
    };

    if (useWASAPI) {
      this.useWASAPI = true;
      startWASAPILoopback({ sampleRate: SAMPLE_RATE, channels: 1 }, onChunk);
      this.ai = {}; // non-null so we know audio is active
      console.log('[AllInOne] 音频捕获已启动 (WASAPI 系统音频)');
      return;
    }

    const inOptions: any = {
      channelCount: 1,
      sampleFormat: (portAudio as any).SampleFormat16Bit,
      sampleRate: SAMPLE_RATE,
      deviceId,
      closeOnError: true
    };

    const AudioIO: any = (portAudio as any).AudioIO;
    const ai = new AudioIO({ inOptions });
    ai.on('data', onChunk);
    ai.on('error', (err: Error) => {
      console.error('[AllInOne] AudioIO error:', err.message);
    });
    ai.start();
    this.ai = ai;
    console.log('[AllInOne] 音频捕获已启动');
  }
}

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
