import React, { useEffect, useState } from 'react';
import type { Settings, ResponseStyle, ApiProvider } from '../../electron/types';

const PROVIDER_OPTIONS: { value: ApiProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '千问 (Qwen)' },
  { value: 'ollama', label: 'Ollama 本地' }
];

interface Props {
  onClose: () => void;
  onApiKeyChanged: (hasKey: boolean) => void;
  onResponseStyleChanged?: (style: ResponseStyle) => void;
  /** 与设置项「下一题自动关旧卡」同步到主界面（无需重开应用） */
  onAutoDismissCardOnNewQuestionChange?: (enabled: boolean) => void;
}

const SettingsPanel: React.FC<Props> = ({
  onClose,
  onApiKeyChanged,
  onResponseStyleChanged,
  onAutoDismissCardOnNewQuestionChange
}) => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testErrorMsg, setTestErrorMsg] = useState('');
  const [inputDevices, setInputDevices] = useState<{ id: number; name: string }[]>([]);
  const [autoDeviceName, setAutoDeviceName] = useState<string | null>(null);

  const provider = settings?.apiProvider ?? 'openai';
  const isOllama = provider === 'ollama';

  useEffect(() => {
    setTestResult(null);
    (async () => {
      const s = await window.teleprompter.getSettings();
      const hasKey = await window.teleprompter.hasApiKey(s?.apiProvider);
      const devices = await window.teleprompter.getInputDevices();
      const autoName = await window.teleprompter.getAutoDeviceName();
      setSettings(s);
      setHasApiKey(!!hasKey);
      setInputDevices(devices);
      setAutoDeviceName(autoName);
    })();
  }, []);

  useEffect(() => {
    if (!settings?.apiProvider) return;
    window.teleprompter.hasApiKey(settings.apiProvider).then(setHasApiKey);
  }, [settings?.apiProvider]);

  const update = async (partial: Partial<Settings>) => {
    const s = await window.teleprompter.updateSettings(partial);
    setSettings(s);
    if (partial.responseStyle !== undefined) {
      onResponseStyleChanged?.(partial.responseStyle as ResponseStyle);
    }
    if (partial.apiProvider !== undefined) {
      const hasKey = await window.teleprompter.hasApiKey(partial.apiProvider);
      setHasApiKey(!!hasKey);
    }
    if (partial.autoDismissCardOnNewQuestion !== undefined) {
      onAutoDismissCardOnNewQuestionChange?.(partial.autoDismissCardOnNewQuestion);
    }
  };

  const handleProviderChange = async (newProvider: ApiProvider) => {
    setTestResult(null);
    const defaultModel = await window.teleprompter.getDefaultModel(newProvider);
    await update({ apiProvider: newProvider, model: defaultModel });
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setTestResult(null);
    await window.teleprompter.saveApiKeyForProvider(provider, apiKeyInput.trim());
    setApiKeyInput('');
    setHasApiKey(true);
    onApiKeyChanged(true);
  };

  const handleClearApiKey = async () => {
    if (!window.confirm('确认删除当前服务商已保存的 Key / 地址？')) return;
    setTestResult(null);
    await window.teleprompter.clearApiKey(provider);
    setHasApiKey(false);
    onApiKeyChanged(false);
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);
    setTestErrorMsg('');
    try {
      const result = await window.teleprompter.testConnection(provider, settings?.model);
      if (result.ok) {
        setTestResult('success');
      } else {
        setTestResult('error');
        setTestErrorMsg(result.error ?? '未知错误');
      }
    } catch (e) {
      setTestResult('error');
      setTestErrorMsg((e as Error).message);
    } finally {
      setTestingConnection(false);
    }
  };

  if (!settings) {
    return (
      <div className="panel-overlay">
        <div className="panel-header">
          <div className="panel-title">Settings</div>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="panel-body">加载中…</div>
      </div>
    );
  }

  return (
    <div className="panel-overlay">
      <div className="panel-header">
        <div className="panel-title">Settings / 配置</div>
        <button className="icon-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <section>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>答案语言 / Answer Language</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['en', 'zh'] as const).map(lang => (
              <button
                key={lang}
                className="btn"
                style={{
                  flex: 1,
                  background: (settings.answerLanguage ?? 'en') === lang
                    ? 'rgba(99,102,241,0.85)'
                    : 'rgba(255,255,255,0.08)',
                  fontWeight: (settings.answerLanguage ?? 'en') === lang ? 700 : 400
                }}
                onClick={() => update({ answerLanguage: lang })}
              >
                {lang === 'en' ? '🇬🇧 English' : '🇨🇳 中文'}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>API 服务商</div>
          <select
            className="input"
            value={provider}
            onChange={e => handleProviderChange(e.target.value as ApiProvider)}
            style={{ width: '100%', marginBottom: 8 }}
          >
            {PROVIDER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{isOllama ? 'Ollama 地址' : 'API Key'}</span>
            {hasApiKey && <span className="badge">已保存</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              type={isOllama ? 'text' : 'password'}
              placeholder={isOllama ? 'http://localhost:11434' : 'sk-...'}
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              style={{ flex: 1, minWidth: 120 }}
            />
            <button className="btn" onClick={handleSaveApiKey}>
              保存
            </button>
            {hasApiKey && (
              <button
                className="btn"
                style={{ background: 'rgba(185,28,28,0.8)' }}
                onClick={handleClearApiKey}
              >
                删除
              </button>
            )}
            {hasApiKey && (
              <>
                {testResult === null && !testingConnection && (
                  <button className="btn" onClick={handleTestConnection}>
                    测试连接
                  </button>
                )}
                {testingConnection && (
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}>测试中…</span>
                )}
                {testResult === 'success' && !testingConnection && (
                  <span style={{ color: '#22c55e', fontWeight: 500, fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}>测试成功</span>
                )}
                {testResult === 'error' && !testingConnection && (
                  <span style={{ color: '#ef4444', fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }} title={testErrorMsg}>
                    连接失败
                  </span>
                )}
              </>
            )}
          </div>
          <div className="muted">
            {isOllama
              ? '本地 Ollama 服务地址，保存后可在下方选择模型。'
              : 'Key 保存在本机 keytar，不会写入代码；丢失需自行在对应后台重新生成。'}
          </div>
        </section>

        <section>
          <div style={{ marginBottom: 4 }}>模型名称</div>
          <input
            className="input"
            value={settings.model}
            onChange={e => update({ model: e.target.value })}
          />
          <div className="muted">
            切换服务商时会自动填入该服务商的推荐模型（instant 档），也可手动修改。
          </div>
        </section>

        <section>
          <div style={{ marginBottom: 4 }}>窗口透明度</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="input"
              type="range"
              min={0.4}
              max={1}
              step={0.05}
              value={settings.windowOpacity ?? 0.95}
              onChange={e => update({ windowOpacity: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span className="muted" style={{ width: 50, textAlign: 'right' }}>
              {Math.round((settings.windowOpacity ?? 0.95) * 100)}%
            </span>
          </div>
          <div className="muted" style={{ marginTop: 2 }}>
            调低透明度可以一边看面试界面一边看提示卡片，建议 60%~90%。
          </div>
        </section>

        <section>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>回答风格 · Response Style</div>
          {(
            [
              {
                value: 'concise' as ResponseStyle,
                label: 'Concise Hint Mode · 极简提醒',
                desc: '显示问题摘要 + 中文思路要点 + 英文关键词，快速提示作答方向。'
              },
              {
                value: 'readable' as ResponseStyle,
                label: 'Readable Answer Mode · 可读答案',
                desc: '显示一句简洁英文回答 + 3-4句展开说明，可在面试中直接朗读。'
              }
            ] as const
          ).map(({ value, label, desc }) => (
            <label
              key={value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 13,
                padding: '8px 10px',
                borderRadius: 6,
                marginBottom: 6,
                cursor: 'pointer',
                background: settings.responseStyle === value
                  ? 'rgba(59,130,246,0.15)'
                  : 'rgba(255,255,255,0.06)',
                border: settings.responseStyle === value
                  ? '1px solid rgba(59,130,246,0.4)'
                  : '1px solid transparent'
              }}
            >
              <input
                type="radio"
                name="responseStyle"
                value={value}
                checked={settings.responseStyle === value}
                onChange={() => update({ responseStyle: value })}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>{label}</div>
                <div className="muted" style={{ marginTop: 2 }}>{desc}</div>
              </div>
            </label>
          ))}
        </section>

        <section>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>答题卡与监听</div>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(148,163,184,0.25)'
            }}
          >
            <input
              type="checkbox"
              checked={settings.autoDismissCardOnNewQuestion !== false}
              onChange={e => update({ autoDismissCardOnNewQuestion: e.target.checked })}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <div>
              <div style={{ fontWeight: 500 }}>下一题自动关闭当前卡片并继续监听</div>
              <div className="muted" style={{ marginTop: 4 }}>
                开启后，识别到面试官的新一轮完整提问时，会自动收起当前提词卡并开始回答新问题（仍可用 Space
                手动关闭）。关闭此项则与旧版一致：须先手动关卡后才会继续听下一题。
              </div>
            </div>
          </label>
        </section>

        <section>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>Audio Source · 音频来源</div>
          <select
            className="input"
            value={settings.audioDeviceId ?? -1}
            onChange={e => update({ audioDeviceId: Number(e.target.value) })}
            style={{ width: '100%' }}
          >
            {inputDevices.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <div className="muted" style={{ marginTop: 4 }}>
            {(settings.audioDeviceId ?? -1) === -1
              ? <>系统播放声（会议/视频中面试官声音）将自动捕获，无需立体声混音或虚拟声卡。</>
              : <>使用所选麦克风设备。</>
            }
          </div>
        </section>

        <section>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>ASR 模式</div>

          {/* 全内属模式（仅 OpenAI） */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              marginBottom: 6,
              background: settings.useRealtimeAllInOne
                ? 'rgba(59,130,246,0.15)'
                : 'rgba(255,255,255,0.06)',
              border: settings.useRealtimeAllInOne
                ? '1px solid rgba(59,130,246,0.4)'
                : '1px solid transparent',
              opacity: provider !== 'openai' ? 0.6 : 1
            }}
          >
            <input
              type="checkbox"
              checked={settings.useRealtimeAllInOne}
              disabled={provider !== 'openai'}
              onChange={e => {
                update({ useRealtimeAllInOne: e.target.checked });
                if (e.target.checked) update({ useRealtimeAsr: false });
              }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>
                ⚡ gpt-4o-realtime 全内属（最低延迟，仅 OpenAI）
              </div>
              <div className="muted" style={{ marginTop: 2 }}>
                模型直接听音频并边说边生成面试提词 JSON。当前仅 OpenAI 支持；其它服务商使用流式 Chat，效果类似。
              </div>
            </div>
          </label>

          {/* 流式 Realtime ASR（仅 OpenAI） */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.06)',
              opacity: settings.useRealtimeAllInOne || provider !== 'openai' ? 0.4 : 1
            }}
          >
            <input
              type="checkbox"
              checked={settings.useRealtimeAsr && !settings.useRealtimeAllInOne}
              disabled={settings.useRealtimeAllInOne || provider !== 'openai'}
              onChange={e => update({ useRealtimeAsr: e.target.checked })}
            />
            <div>
              <div style={{ fontWeight: 500 }}>Realtime Whisper ASR（仅 OpenAI）</div>
              <div className="muted" style={{ marginTop: 2 }}>
                音频实时推送，说完后 Whisper 快速转写，再调 LLM。约 1-2s 延迟。
              </div>
            </div>
          </label>

          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            非 OpenAI 服务商：使用传统 Whisper 分段上传（需保存 OpenAI Key 用于转写）+ 当前 LLM 生成。
          </div>
        </section>

      </div>
    </div>
  );
};

export default SettingsPanel;

