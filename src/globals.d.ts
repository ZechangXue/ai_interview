import type {
  AssistEventPayload,
  AssistStreamChunk,
  ListenerStatus,
  Settings,
  ContextFile,
  ContextLabel,
  ApiProvider
} from '../electron/types';

declare global {
  interface Window {
    teleprompter: {
      getSettings: () => Promise<Settings>;
      updateSettings: (partial: Partial<Settings>) => Promise<Settings>;
      getApiKey: () => Promise<boolean>;
      hasApiKey: (provider?: ApiProvider) => Promise<boolean>;
      saveApiKeyForProvider: (provider: ApiProvider, value: string) => Promise<void>;
      setApiKey: (key: string) => Promise<void>;
      clearApiKey: (provider?: ApiProvider) => Promise<void>;
      testConnection: (provider: ApiProvider, model?: string) => Promise<{ ok: boolean; error?: string }>;
      getDefaultModel: (provider: ApiProvider) => Promise<string>;
      regenerateSystemPrompt: () => Promise<string>;

      addContextFile: (filePath: string, label: ContextLabel) => Promise<ContextFile>;
      getContextFiles: () => Promise<ContextFile[]>;
      clearContext: () => Promise<void>;
      clearQuestionsHistory: () => Promise<void>;

      pickContextFile: () => Promise<string | null>;
      onContextUpdated: (cb: () => void) => void;

      startListening: () => Promise<ListenerStatus>;
      stopListening: () => Promise<ListenerStatus>;
      toggleListening: () => Promise<ListenerStatus>;
      getListenerStatus: () => Promise<ListenerStatus>;
      answerFromScreenshot: () => Promise<{ ok: boolean; error?: string }>;

      hideWindow: () => Promise<void>;
      showWindow: () => Promise<void>;
      quitApp: () => Promise<void>;

      onAssist: (cb: (payload: AssistEventPayload) => void) => void;
      onAssistStream: (cb: (chunk: AssistStreamChunk) => void) => void;

      getInputDevices: () => Promise<{ id: number; name: string }[]>;
      getAutoDeviceName: () => Promise<string | null>;
      openSystemSoundSettings: () => Promise<void>;
      onAudioLevel: (cb: (level: number) => void) => void;

      getReadableAnswer: (
        questionZh: string,
        contextFromConcise?: { concise_answer_en: string; keywords_en?: string[] },
        options?: { persistToLog?: boolean }
      ) => Promise<{
        question_zh: string;
        concise_answer_en: string;
        expanded_answer_en: string;
      }>;
      /** 用户点开「可读答案」时写入：图1 一句 + 图2 展开（与当前卡片一致） */
      persistExpandedFromCard: (payload: {
        question_zh: string;
        concise_answer_en: string;
        expanded_answer_en: string;
        keywords_en?: string[];
      }) => Promise<void>;

      exportInterviewSession: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      prepareInterviewSessionExport: () => Promise<
        { ok: true; tempPdfPath: string } | { ok: false; error: string }
      >;
      finalizeInterviewSessionExport: (
        tempPdfPath: string
      ) => Promise<{ ok: boolean; path?: string; error?: string }>;

      // ── Mac 音频引导（darwin 专属，其他平台返回 undefined） ────────────────
      macCheckBlackHole: () => Promise<{
        installed: boolean;
        deviceId: number | null;
        deviceName: string | null;
      }>;
      macCheckMultiOutput: () => Promise<boolean>;
      macSetupDone: () => Promise<boolean>;
      macMarkSetupDone: () => Promise<void>;
      macOpenAudioMidiSetup: () => Promise<void>;
      macOpenSoundPreferences: () => Promise<void>;
      macOpenExternalUrl: (url: string) => Promise<void>;
      getPlatform: () => string;  // 同步，preload 直接返回 process.platform
    };
  }
}

export {};

