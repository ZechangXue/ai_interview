import EventEmitter from 'node:events';
import portAudio from 'naudiodon';
import WebSocket from 'ws';
import {
  isWASAPILoopbackSupported,
  startWASAPILoopback,
  stopWASAPILoopback
} from './wasapiLoopbackCapture';

export type QuestionCallback = (text: string, speechStoppedAt: number) => void;

interface RealtimeOptions {
  apiKey: string;
  model?: string;
  deviceId?: number;
}

const DEFAULT_REALTIME_MODEL = 'gpt-realtime-mini';
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${DEFAULT_REALTIME_MODEL}`;

// OpenAI Realtime API 要求 pcm16 @ 24kHz，但 naudiodon 可以给 16kHz
// 这里统一用 24kHz，和 Realtime API 完全对齐
const SAMPLE_RATE = 24000;

export class RealtimeTranscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private ai: any | null = null;
  private useWASAPI = false;
  private apiKey: string;
  private modelUrl: string;
  private deviceId: number;
  private onQuestion: QuestionCallback | null = null;
  private active = false;
  private lastLevelEmitTime = 0;

  constructor(opts: RealtimeOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.deviceId = opts.deviceId ?? -1;
    this.modelUrl = opts.model
      ? `wss://api.openai.com/v1/realtime?model=${opts.model}`
      : REALTIME_URL;
  }

  async start(onQuestion: QuestionCallback): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.onQuestion = onQuestion;
    await this.openWebSocket();
  }

  private modelFromUrl(): string {
    try {
      return new URL(this.modelUrl).searchParams.get('model') || DEFAULT_REALTIME_MODEL;
    } catch {
      return DEFAULT_REALTIME_MODEL;
    }
  }

  stop(): void {
    this.active = false;
    this.onQuestion = null;

    if (this.useWASAPI) {
      stopWASAPILoopback();
      this.useWASAPI = false;
    } else if (this.ai) {
      try { this.ai.quit(); } catch {}
    }
    this.ai = null;

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.modelUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      ws.on('open', () => {
        console.log('[Realtime] WebSocket 已连接');

        // 配置 session：纯转写模式，禁止自动生成 LLM 回复
        const sessionUpdate = {
          type: 'session.update',
          session: {
            type: 'realtime',
            model: this.modelFromUrl(),
            output_modalities: ['text'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: SAMPLE_RATE },
                // 显式开启转写，否则服务端不返回转写事件
                transcription: {
                  model: 'gpt-4o-mini-transcribe'
                },
                turn_detection: {
                  type: 'server_vad',
                  silence_duration_ms: 700,
                  threshold: 0.5,
                  // 关键：禁止服务端在 VAD 截断后自动生成回复
                  // 这样转写结果不用等 LLM 生成完就直接返回
                  create_response: false
                }
              }
            }
          }
        };

        ws.send(JSON.stringify(sessionUpdate));
        this.ws = ws;
        resolve();

        // 连接建立后开始推送音频
        this.startAudio();
      });

      ws.on('message', (data: Buffer) => {
        // debug: 打印所有事件类型
        try {
          const ev = JSON.parse(data.toString());
          if (ev.type && !ev.type.startsWith('input_audio_buffer.append')) {
            console.log('[Realtime] event:', ev.type, ev.transcript ?? ev.delta ?? '');
          }
        } catch {}
        this.handleServerEvent(data);
      });

      ws.on('error', (err: Error) => {
        console.error('[Realtime] WebSocket 错误:', err.message);
        this.stop();
        reject(err);
      });

      ws.on('close', () => {
        console.log('[Realtime] WebSocket 已关闭');
        this.ai?.quit?.();
        this.ai = null;
        this.ws = null;
      });
    });
  }

  private t0 = 0; // speech_started
  private t1 = 0; // speech_stopped
  private t2 = 0; // first transcription delta
  private t3 = 0; // transcription completed
  private firstDeltaSeen = false;

  private ms(from: number): string {
    return from ? `+${Date.now() - from}ms` : '+?ms';
  }

  private handleServerEvent(raw: Buffer) {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type: string = event.type ?? '';

    if (type === 'error') {
      console.error('[Realtime] error:', event.error ?? event);
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      this.t0 = Date.now();
      this.t1 = this.t2 = this.t3 = 0;
      this.firstDeltaSeen = false;
      console.log(`[⏱ T0] 说话开始`);
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      this.t1 = Date.now();
      console.log(`[⏱ T1] 语音停止       ${this.ms(this.t0)} (说话时长)`);
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      if (!this.firstDeltaSeen) {
        this.t2 = Date.now();
        this.firstDeltaSeen = true;
        console.log(`[⏱ T2] 首个转写 delta ${this.ms(this.t1)} (Whisper 首字)`);
      }
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.t3 = Date.now();
      const transcript: string = (event.transcript ?? '').trim();
      console.log(`[⏱ T3] 转写完成       ${this.ms(this.t1)} (Whisper 总耗时) | 文字: ${transcript}`);
      if (transcript && this.onQuestion) {
        this.onQuestion(transcript, this.t1);
      }
    }

    if (type === 'response.audio_transcript.done') {
      const transcript: string = (event.transcript ?? '').trim();
      if (transcript && this.onQuestion) {
        this.onQuestion(transcript, this.t1);
      }
    }
  }

  private startAudio() {
    if (!this.active) return;

    const useWASAPI =
      process.platform === 'win32' &&
      this.deviceId === -1 &&
      isWASAPILoopbackSupported();

    const onChunk = (chunk: Buffer): void => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const base64 = chunk.toString('base64');
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64
      }));
      const now = Date.now();
      if (now - this.lastLevelEmitTime >= 100) {
        this.lastLevelEmitTime = now;
        const sampleCount = chunk.length / 2;
        if (sampleCount > 0) {
          let sum = 0;
          for (let i = 0; i < sampleCount; i++) sum += Math.abs(chunk.readInt16LE(i * 2)) / 32768;
          this.emit('level', sum / sampleCount);
        }
      }
    };

    if (useWASAPI) {
      this.useWASAPI = true;
      startWASAPILoopback({ sampleRate: SAMPLE_RATE, channels: 1 }, onChunk);
      this.ai = {};
      return;
    }

    const inOptions: any = {
      channelCount: 1,
      sampleFormat: portAudio.SampleFormat16Bit,
      sampleRate: SAMPLE_RATE,
      deviceId: this.deviceId,
      closeOnError: true
    };

    const AudioIO: any = (portAudio as any).AudioIO;
    const ai = new AudioIO({ inOptions });
    ai.on('data', onChunk);
    ai.on('error', (err: Error) => {
      console.error('[Realtime] AudioIO error:', err.message);
    });
    ai.start();
    this.ai = ai;
  }
}
