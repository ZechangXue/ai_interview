import React from 'react';

interface Props {
  theme: 'dark' | 'light';
  listening: boolean;
  hasApiKey: boolean;
  queueSize: number;
  audioLevel?: number;
  onThemeToggle: () => void;
  onToggleListening: () => void;
  onScreenshotAnswer?: () => void;
  onOpenContext: () => void;
  onOpenSettings: () => void;
  onExportInterview?: () => void;
  /** 正在生成 PDF（总结+打印），按钮显示「导出中」并禁用 */
  exportInterviewBusy?: boolean;
  onCloseWindow: () => void;
  children: React.ReactNode;
}

// 4 根竖条音量指示，高度递增，按 level 阈值依次点亮
const LevelMeter: React.FC<{ level: number; active: boolean }> = ({ level, active }) => {
  const bars = [
    { height: 6,  threshold: 0.03 },
    { height: 10, threshold: 0.08 },
    { height: 14, threshold: 0.18 },
    { height: 18, threshold: 0.35 },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18, marginLeft: 6, opacity: active ? 1 : 0.25 }}>
      {bars.map((bar, i) => {
        const lit = active && level >= bar.threshold;
        return (
          <div
            key={i}
            style={{
              width: 3,
              height: bar.height,
              borderRadius: 1,
              background: lit ? '#4ade80' : 'rgba(255,255,255,0.2)',
              transition: 'background 80ms ease',
            }}
          />
        );
      })}
    </div>
  );
};

const FloatingWindow: React.FC<Props> = ({
  theme,
  listening,
  hasApiKey,
  queueSize,
  audioLevel = 0,
  onThemeToggle,
  onToggleListening,
  onScreenshotAnswer,
  onOpenContext,
  onOpenSettings,
  onExportInterview,
  exportInterviewBusy = false,
  onCloseWindow,
  children
}) => {
  return (
    <div className={`floating-window ${theme === 'dark' ? 'theme-dark' : 'theme-light'}`}>
      <div className="top-bar" style={{ WebkitAppRegion: 'drag' as any }}>
        <div className="top-bar-left" style={{ WebkitAppRegion: 'no-drag' as any }}>
          <div className="app-title">过了么AI</div>
          <div className={`status-pill ${listening ? '' : 'paused'}`}>
            <span className="status-dot" />
            {listening ? 'Listening' : 'Paused'}
          </div>
          <LevelMeter level={audioLevel} active={listening} />
          {!hasApiKey && (
            <span className="badge" style={{ borderColor: '#f97316', color: '#f97316' }}>
              No API Key
            </span>
          )}
          {queueSize > 1 && (
            <span className="badge">
              Queue: {queueSize - 1}
            </span>
          )}
        </div>
        <div className="top-bar-right" style={{ WebkitAppRegion: 'no-drag' as any }}>
          {onExportInterview && (
            <button
              className="btn"
              type="button"
              onClick={onExportInterview}
              disabled={exportInterviewBusy}
              title="导出本次全部问答与 AI 复盘总结为 PDF"
              style={{ fontSize: 11, padding: '5px 10px', opacity: exportInterviewBusy ? 0.75 : 1 }}
            >
              {exportInterviewBusy ? '导出中…' : '一键导出'}
            </button>
          )}
          <button className="icon-btn" onClick={onThemeToggle} title="切换主题">
            {theme === 'dark' ? '☀︎' : '☾'}
          </button>
          <button className="btn" onClick={onToggleListening}>
            {listening ? '暂停监听' : '开始监听'}
          </button>
          {onScreenshotAnswer && (
            <button className="icon-btn" onClick={onScreenshotAnswer} title="截图识别回答">
              ⛶
            </button>
          )}
          <button className="icon-btn" onClick={onOpenContext} title="资料库 (Ctrl+U)">
            📚
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="设置">
            ⚙
          </button>
          <button className="icon-btn" onClick={onCloseWindow} title="关闭并退出程序">
            ✕
          </button>
        </div>
      </div>

      <div className="main-content">{children}</div>
    </div>
  );
};

export default FloatingWindow;

