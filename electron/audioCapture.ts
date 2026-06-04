import EventEmitter from 'node:events';
import portAudio from 'naudiodon';
import {
  isWASAPILoopbackSupported,
  startWASAPILoopback,
  stopWASAPILoopback
} from './wasapiLoopbackCapture';

interface AudioListenerOptions {
  sampleRate?: number;
  silenceMs?: number;
  silenceThreshold?: number;
  deviceId?: number;
  /**
   * 麦克风路径专用：RMS ≥ 此值视为「进入说话」（应高于笔记本风扇/底噪；约对齐 UI 第一根绿条 0.03）
   */
  voiceEnterRms?: number;
  /**
   * 麦克风路径专用：RMS ≤ 此值视为「静音」用于切段（应低于正常说话、高于纯底噪）
   */
  voiceExitRms?: number;
}

type ResolvedAudioOptions = Required<
  Pick<
    AudioListenerOptions,
    'sampleRate' | 'silenceMs' | 'silenceThreshold' | 'deviceId' | 'voiceEnterRms' | 'voiceExitRms'
  >
>;

export class AudioListener extends EventEmitter {
  private options: ResolvedAudioOptions;
  private ai: any | null = null;
  private useWASAPI = false;
  private listening = false;

  private currentBuffers: Buffer[] = [];
  private lastVoiceTime = 0;
  private lastLevelEmitTime = 0;
  /** 麦克风滞回：避免底噪长期 > silenceThreshold 导致永远无法触发 1s 静音、永远不 emit segment */
  private micVoiceLatch = false;

  constructor(options?: AudioListenerOptions) {
    super();
    this.options = {
      sampleRate: options?.sampleRate ?? 16000,
      silenceMs: options?.silenceMs ?? 1000,
      silenceThreshold: options?.silenceThreshold ?? 0.01,
      deviceId: options?.deviceId ?? -1,
      voiceEnterRms: options?.voiceEnterRms ?? 0.028,
      voiceExitRms: options?.voiceExitRms ?? 0.012
    };
  }

  start() {
    if (this.listening) return;
    this.listening = true;

    const useWASAPI =
      process.platform === 'win32' &&
      this.options.deviceId === -1 &&
      isWASAPILoopbackSupported();

    if (useWASAPI) {
      this.useWASAPI = true;
      startWASAPILoopback(
        { sampleRate: this.options.sampleRate, channels: 1 },
        (chunk: Buffer) => this.handleChunk(chunk)
      );
      this.lastVoiceTime = Date.now();
      return;
    }

    const inOptions: any = {
      channelCount: 1,
      sampleFormat: portAudio.SampleFormat16Bit,
      sampleRate: this.options.sampleRate,
      deviceId: this.options.deviceId,
      closeOnError: true
    };

    const AudioIO: any = (portAudio as any).AudioIO;
    this.ai = new AudioIO({ inOptions });
    this.ai.on('data', (chunk: Buffer) => this.handleChunk(chunk));
    this.ai.on('error', (err: Error) => {
      console.error('AudioIO error:', err);
    });

    this.ai.start();
    this.lastVoiceTime = Date.now();
  }

  stop() {
    if (!this.listening) return;
    this.listening = false;
    if (this.useWASAPI) {
      stopWASAPILoopback();
      this.useWASAPI = false;
    } else {
      try {
        this.ai?.quit();
      } catch {
        // ignore
      }
      this.ai = null;
    }
    this.currentBuffers = [];
    this.micVoiceLatch = false;
  }

  private handleChunk(chunk: Buffer) {
    if (!this.listening) return;

    const now = Date.now();

    // 每 100ms 向外广播一次当前音量（RMS 0~1）
    if (now - this.lastLevelEmitTime >= 100) {
      this.lastLevelEmitTime = now;
      this.emit('level', this.calcRms(chunk));
    }

    const isVoice = this.chunkHasVoice(chunk);

    if (isVoice) {
      this.currentBuffers.push(chunk);
      this.lastVoiceTime = now;
      return;
    }

    const silentDuration = now - this.lastVoiceTime;
    if (silentDuration >= this.options.silenceMs && this.currentBuffers.length > 0) {
      const segment = Buffer.concat(this.currentBuffers);
      this.currentBuffers = [];
      this.lastVoiceTime = now;
      this.emit('segment', segment);
    }
  }

  private calcRms(chunk: Buffer): number {
    const sampleCount = chunk.length / 2;
    if (sampleCount === 0) return 0;
    let sum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const val = chunk.readInt16LE(i * 2);
      sum += Math.abs(val) / 32768;
    }
    return sum / sampleCount;
  }

  private chunkHasVoice(chunk: Buffer): boolean {
    const rms = this.calcRms(chunk);
    // 系统音频环回：底噪通常很低，沿用简单阈值即可
    if (this.useWASAPI) {
      return rms > this.options.silenceThreshold;
    }
    // 物理麦克风：环境噪声易长期略高于 0.01，用滞回避免「永远判为在说话」→ 永远不结束段落
    const enter = this.options.voiceEnterRms;
    const exit = this.options.voiceExitRms;
    if (rms >= enter) this.micVoiceLatch = true;
    else if (rms <= exit) this.micVoiceLatch = false;
    return this.micVoiceLatch;
  }
}

