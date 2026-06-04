import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from './hooks/useHotkeys';
import FloatingWindow from './components/FloatingWindow';
import AssistCard from './components/AssistCard';
import ContextPanel from './components/ContextPanel';
import SettingsPanel from './components/SettingsPanel';
import MacSetupWizard from './components/MacSetupWizard';
import {
  isNoiseOrUnrecognizedQuestionZh,
  type AssistEventPayload,
  type AssistJSON,
  type ReadableAssistJSON,
  type ResponseStyle
} from '../electron/types';

type Theme = 'dark' | 'light';

interface QueueItem {
  id: number;
  payload: AssistEventPayload;
}

const MAX_QUEUE = 3;

const App: React.FC = () => {
  const [theme, setTheme] = useState<Theme>('dark');
  const [listening, setListening] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [showContext, setShowContext] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHints, setShowHints] = useState(true);

  const [responseStyle, setResponseStyle] = useState<ResponseStyle>('concise');
  const [audioLevel, setAudioLevel] = useState(0);
  const [displayCurrentAsReadable, setDisplayCurrentAsReadable] = useState(false);
  const [autoDismissCardOnNewQuestion, setAutoDismissCardOnNewQuestion] = useState(true);
  const [exportInterviewBusy, setExportInterviewBusy] = useState(false);
  const [meetingMode, setMeetingMode] = useState(false);
  const [showMacSetup, setShowMacSetup] = useState(false);

  // 流式卡片状态
  const [streamCard, setStreamCard] = useState<Partial<AssistJSON & ReadableAssistJSON> | null>(null);
  const [streaming, setStreaming] = useState(false);
  const streamStoppedRef = useRef(false); // 用户关闭流式卡片后忽略后续 chunk
  const prefetchedQuestionRef = useRef<string | null>(null); // 已为哪条问题预取了可读答案，避免重复请求
  const streamingRef = useRef(false);
  const autoDismissRef = useRef(true);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    autoDismissRef.current = autoDismissCardOnNewQuestion;
  }, [autoDismissCardOnNewQuestion]);

  useEffect(() => {
    (async () => {
      try {
        const settings = await window.teleprompter.getSettings();
        const status = await window.teleprompter.getListenerStatus();
        const hasKey = await window.teleprompter.getApiKey();
        setListening(status.listening);
        setHasApiKey(hasKey);
        setTheme('dark');
        setResponseStyle((settings.responseStyle as ResponseStyle) ?? 'concise');
        setAutoDismissCardOnNewQuestion(settings.autoDismissCardOnNewQuestion !== false);
        setMeetingMode(!!(settings as any).meetingMode);
        // 不自动开始监听，由用户每次打开后手动点击「开始监听」

        // Mac 平台：若首次使用则弹出音频引导（同步读取 process.platform，无 IPC 开销）
        const platform = window.teleprompter.getPlatform();
        if (platform === 'darwin') {
          const done = await window.teleprompter.macSetupDone();
          if (!done) setShowMacSetup(true);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // 音量指示：订阅 level 事件；停止监听时归零
  useEffect(() => {
    window.teleprompter.onAudioLevel((level) => {
      setAudioLevel(level);
    });
  }, []);

  useEffect(() => {
    if (!listening) setAudioLevel(0);
  }, [listening]);

  // 非流式卡片
  useEffect(() => {
    window.teleprompter.onAssist((payload) => {
      setQueue((prev) => {
        const autoDismiss = autoDismissRef.current;
        if (prev.length > 0 && !autoDismiss) return prev;

        if (prev.length > 0 && autoDismiss) {
          queueMicrotask(() => setDisplayCurrentAsReadable(false));
          return [{ id: Date.now(), payload }];
        }

        if (!autoDismiss) {
          (async () => {
            try {
              const status = await window.teleprompter.stopListening();
              setListening(status.listening);
            } catch (e) {
              console.error('stopListening error', e);
            }
          })();
        }
        return [{ id: Date.now(), payload }];
      });
    });
  }, []);

  // 流式卡片
  useEffect(() => {
    window.teleprompter.onAssistStream((chunk) => {
      if (streamStoppedRef.current) return;

      const qNoise = chunk.partial.question_zh;
      if (typeof qNoise === 'string' && isNoiseOrUnrecognizedQuestionZh(qNoise)) {
        if (chunk.done) {
          streamingRef.current = false;
          setStreaming(false);
        }
        return;
      }

      const autoDismiss = autoDismissRef.current;

      const partialHasContent =
        (chunk.partial.question_zh !== undefined && String(chunk.partial.question_zh).trim().length > 0) ||
        chunk.partial.thinking_zh !== undefined ||
        chunk.partial.keywords_en !== undefined ||
        chunk.partial.concise_answer_en !== undefined ||
        chunk.partial.expanded_answer_en !== undefined;

      let shouldStopListening = false;
      let bumpStreaming = false;
      let clearQueueForNewStream = false;

      setStreamCard((prev) => {
        const idleCardShowing = prev !== null && !streamingRef.current;

        // 上一题已生成完毕、仍保持监听时：新一轮输出开始 → 自动切题（等同关掉旧卡）
        if (autoDismiss && idleCardShowing && !chunk.done && partialHasContent) {
          prefetchedQuestionRef.current = null;
          streamStoppedRef.current = false;
          streamingRef.current = true;
          bumpStreaming = true;
          clearQueueForNewStream = true;
          queueMicrotask(() => setDisplayCurrentAsReadable(false));
          return {
            ...(chunk.partial.question_zh !== undefined ? { question_zh: chunk.partial.question_zh } : {}),
            ...(chunk.partial.thinking_zh !== undefined ? { thinking_zh: chunk.partial.thinking_zh } : {}),
            ...(chunk.partial.keywords_en !== undefined ? { keywords_en: chunk.partial.keywords_en } : {}),
            ...(chunk.partial.concise_answer_en !== undefined
              ? { concise_answer_en: chunk.partial.concise_answer_en }
              : {}),
            ...(chunk.partial.expanded_answer_en !== undefined
              ? { expanded_answer_en: chunk.partial.expanded_answer_en }
              : {})
          };
        }

        const isFirst = !prev;
        if (isFirst && chunk.partial.question_zh) {
          streamStoppedRef.current = false;
          streamingRef.current = true;
          bumpStreaming = true;
          clearQueueForNewStream = true;
          if (!autoDismiss) {
            shouldStopListening = true;
          }
        }

        if (!prev && !chunk.partial.question_zh) return prev;

        const merged: Partial<AssistJSON & ReadableAssistJSON> = {
          ...(prev ?? {}),
          ...(chunk.partial.question_zh !== undefined ? { question_zh: chunk.partial.question_zh } : {}),
          ...(chunk.partial.thinking_zh !== undefined ? { thinking_zh: chunk.partial.thinking_zh } : {}),
          ...(chunk.partial.keywords_en !== undefined ? { keywords_en: chunk.partial.keywords_en } : {}),
          ...(chunk.partial.concise_answer_en !== undefined ? { concise_answer_en: chunk.partial.concise_answer_en } : {}),
          ...(chunk.partial.expanded_answer_en !== undefined ? { expanded_answer_en: chunk.partial.expanded_answer_en } : {})
        };

        // 题干切换时必须丢掉上一题的预取展开，否则 !expanded 预取条件永远不成立 → 后续轮 [CONVERSATION] 无展开
        if (
          chunk.partial.question_zh !== undefined &&
          prev &&
          typeof prev.question_zh === 'string' &&
          String(prev.question_zh).trim() !== String(chunk.partial.question_zh).trim()
        ) {
          delete merged.expanded_answer_en;
          delete merged.readable_concise_answer_en;
        }

        return merged;
      });

      if (clearQueueForNewStream) {
        queueMicrotask(() => setQueue([]));
      }

      if (shouldStopListening) {
        (async () => {
          try {
            const status = await window.teleprompter.stopListening();
            setListening(status.listening);
          } catch {
            /* ignore */
          }
        })();
      }

      if (bumpStreaming) {
        setStreaming(true);
      }

      if (chunk.done) {
        streamingRef.current = false;
        setStreaming(false);
      }
    });
  }, []);

  // 面试/组会模式均已一次性生成 expanded_answer_en，不再需要二次预取

  const currentCard = useMemo(() => queue[0]?.payload.assist ?? null, [queue]);
  const hasCard = currentCard !== null || streamCard !== null;

  const closeCurrentCard = async () => {
    setDisplayCurrentAsReadable(false);
    prefetchedQuestionRef.current = null;
    setQueue((prev) => prev.slice(1));
    streamStoppedRef.current = true;
    setStreamCard(null);
    setStreaming(false);
    streamingRef.current = false;
    try {
      const status = await window.teleprompter.getListenerStatus();
      if (!status.listening) {
        const next = await window.teleprompter.startListening();
        setListening(next.listening);
      } else {
        setListening(true);
      }
      streamStoppedRef.current = false;
    } catch (e) {
      console.error('startListening error', e);
    }
  };

  const handleGetReadableAnswer = async (questionZh: string) => {
    // 若已预取或卡片上已有展开：先按当前卡片把「一句+展开」写入导出/会话，再切换展示
    if (streamCard?.question_zh === questionZh && streamCard.expanded_answer_en) {
      const conc = streamCard.concise_answer_en?.trim();
      if (conc) {
        await window.teleprompter.persistExpandedFromCard({
          question_zh: questionZh,
          concise_answer_en: conc,
          expanded_answer_en: streamCard.expanded_answer_en,
          keywords_en: Array.isArray(streamCard.keywords_en) ? streamCard.keywords_en : undefined
        });
      }
      setDisplayCurrentAsReadable(true);
      return;
    }
    const qAssist = queue[0]?.payload?.assist;
    if (queue.length > 0 && qAssist?.question_zh === questionZh && qAssist.expanded_answer_en) {
      const conc = qAssist.concise_answer_en?.trim();
      if (conc) {
        await window.teleprompter.persistExpandedFromCard({
          question_zh: questionZh,
          concise_answer_en: conc,
          expanded_answer_en: qAssist.expanded_answer_en,
          keywords_en: Array.isArray(qAssist.keywords_en) ? qAssist.keywords_en : undefined
        });
      }
      setDisplayCurrentAsReadable(true);
      return;
    }
    const currentCard = streamCard ?? queue[0]?.payload?.assist ?? null;
    const contextFromConcise =
      currentCard?.concise_answer_en
        ? {
            concise_answer_en: currentCard.concise_answer_en,
            keywords_en: Array.isArray(currentCard.keywords_en) ? currentCard.keywords_en : undefined
          }
        : undefined;
    const r = await window.teleprompter.getReadableAnswer(questionZh, contextFromConcise);
    setStreamCard((prev) => {
      if (!prev || prev.question_zh !== questionZh) return prev;
      return { ...prev, expanded_answer_en: r.expanded_answer_en, readable_concise_answer_en: r.concise_answer_en };
    });
    setQueue((prev) => {
      if (prev.length === 0) return prev;
      const [first, ...rest] = prev;
      if (first.payload.assist?.question_zh !== questionZh) return prev;
      const merged = { ...first.payload.assist, expanded_answer_en: r.expanded_answer_en, readable_concise_answer_en: r.concise_answer_en };
      return [{ ...first, payload: { ...first.payload, assist: merged } }, ...rest];
    });
    setDisplayCurrentAsReadable(true);
  };

  const toggleListening = async () => {
    try {
      const status = await window.teleprompter.toggleListening();
      setListening(status.listening);
    } catch (e) {
      console.error('toggleListening error', e);
    }
  };

  const handleThemeToggle = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  const handleExportInterview = useCallback(async () => {
    if (exportInterviewBusy) return;
    setExportInterviewBusy(true);
    try {
      const prep = await window.teleprompter.prepareInterviewSessionExport();
      setExportInterviewBusy(false);
      if (!prep.ok) {
        alert(prep.error || '导出失败');
        return;
      }
      const r = await window.teleprompter.finalizeInterviewSessionExport(prep.tempPdfPath);
      if (r.ok && r.path) {
        alert(`已导出 PDF：\n${r.path}`);
      } else if (r.error && r.error !== '已取消') {
        alert(r.error || '导出失败');
      }
    } catch (e) {
      console.error(e);
      setExportInterviewBusy(false);
      alert('导出失败');
    }
  }, [exportInterviewBusy]);

  useHotkeys({
    onSpace: () => {
      if (hasCard) {
        closeCurrentCard();
      }
    },
    onToggleListening: () => {
      toggleListening();
    },
    onOpenContext: () => {
      setShowContext(true);
      setShowSettings(false);
    },
    onHideWindow: () => {
      setShowHints(h => !h);
    }
  });

  const onApiKeyChanged = (hasKey: boolean) => {
    setHasApiKey(hasKey);
  };

  const handleToggleMeetingMode = async () => {
    const next = !meetingMode;
    setMeetingMode(next);
    try {
      await window.teleprompter.updateSettings({ meetingMode: next } as any);
    } catch (e) {
      console.error('Failed to save meetingMode setting', e);
    }
  };

  const handleScreenshotAnswer = async () => {
    try {
      const result = await window.teleprompter.answerFromScreenshot();
      if (!result.ok && result.error && result.error !== 'cancelled') {
        console.error('Screenshot answer failed:', result.error);
      }
    } catch (e) {
      console.error('Screenshot answer failed:', e);
    }
  };

  return (
    <div className="app-root">
      <FloatingWindow
        theme={theme}
        listening={listening}
        hasApiKey={hasApiKey}
        audioLevel={audioLevel}
        onThemeToggle={handleThemeToggle}
        onToggleListening={toggleListening}
        onScreenshotAnswer={handleScreenshotAnswer}
        onOpenContext={() => {
          setShowContext(true);
          setShowSettings(false);
        }}
        onOpenSettings={() => {
          setShowSettings(true);
          setShowContext(false);
        }}
        onExportInterview={handleExportInterview}
        exportInterviewBusy={exportInterviewBusy}
        onCloseWindow={() => window.teleprompter.quitApp()}
        queueSize={queue.length}
      >
        {streamCard ? (
          <AssistCard
            assist={streamCard}
            responseStyle={responseStyle}
            streaming={streaming}
            onClose={closeCurrentCard}
            displayAsReadable={displayCurrentAsReadable}
            onGetReadableAnswer={handleGetReadableAnswer}
            meetingMode={meetingMode}
          />
        ) : currentCard ? (
          <AssistCard
            assist={currentCard}
            responseStyle={responseStyle}
            onClose={closeCurrentCard}
            displayAsReadable={displayCurrentAsReadable}
            onGetReadableAnswer={handleGetReadableAnswer}
            meetingMode={meetingMode}
          />
        ) : (
          <div className="placeholder">
            <div>
              {meetingMode
                ? '组会模式：等待捕捉提问…'
                : '等待捕捉下一条「对方提问」…'}
            </div>
            <div className="muted">
              {meetingMode
                ? '请先上传项目文档并点击「分析文档并建立索引」，然后开始监听。'
                : '确保系统音频设备配置为 Stereo Mix / WASAPI loopback，或在 Settings 中开启 Mock 调试。'}
            </div>
          </div>
        )}

        {showContext && (
          <ContextPanel
            onClose={() => setShowContext(false)}
            meetingMode={meetingMode}
            onToggleMeetingMode={handleToggleMeetingMode}
          />
        )}

        {showSettings && (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onApiKeyChanged={onApiKeyChanged}
            onResponseStyleChanged={setResponseStyle}
            onAutoDismissCardOnNewQuestionChange={setAutoDismissCardOnNewQuestion}
          />
        )}

        {/* Mac 首次使用引导（仅 darwin，Windows 永远不会渲染） */}
        {showMacSetup && (
          <MacSetupWizard onComplete={() => setShowMacSetup(false)} />
        )}

        {showHints && (
          <div className="footer-hints">
            <div>
              <span className="kbd">Space</span> 关闭当前卡片 ·{' '}
              <span className="kbd">Ctrl+S</span> 开关监听
            </div>
            <div>
              <span className="kbd">Ctrl+Shift+H</span> 隐藏/显示窗口 · <span className="kbd">Ctrl+U</span> 资料库 · <span className="kbd">Esc</span> 隐藏提示栏
            </div>
          </div>
        )}
      </FloatingWindow>
    </div>
  );
};

export default App;

