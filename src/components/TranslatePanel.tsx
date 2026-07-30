import React, { useEffect, useRef } from 'react';

export interface TranslateEntry {
  id: number;
  text: string;
  timestamp: string;
  streaming?: boolean;
}

interface Props {
  listening: boolean;
  summarizing: boolean;
  entries: TranslateEntry[];
  onToggleListening: () => void;
  onSummarize: () => void;
}

const TranslatePanel: React.FC<Props> = ({
  listening,
  summarizing,
  entries,
  onToggleListening,
  onSummarize
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新条目出现时滚到顶部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      height: '100%',
      minHeight: 0
    }}>
      {/* 控制按钮行 */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          className="btn"
          style={{
            flex: 1,
            background: listening
              ? 'rgba(16, 185, 129, 0.25)'
              : 'rgba(15, 23, 42, 0.7)',
            border: listening
              ? '1px solid rgba(16, 185, 129, 0.5)'
              : '1px solid rgba(148, 163, 184, 0.3)',
            color: listening ? '#6ee7b7' : undefined,
            fontWeight: listening ? 600 : 400,
            justifyContent: 'center',
            padding: '8px 12px',
            fontSize: 13
          }}
          onClick={onToggleListening}
          disabled={summarizing}
        >
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: listening ? '#10b981' : '#6b7280',
            display: 'inline-block',
            marginRight: 6,
            flexShrink: 0
          }} />
          {listening ? '暂停监听' : '开始监听'}
        </button>

        <button
          className="btn"
          style={{
            flex: 1,
            background: summarizing
              ? 'rgba(99, 102, 241, 0.15)'
              : 'rgba(99, 102, 241, 0.3)',
            border: '1px solid rgba(99, 102, 241, 0.5)',
            color: '#a5b4fc',
            fontWeight: 600,
            justifyContent: 'center',
            padding: '8px 12px',
            fontSize: 13,
            opacity: summarizing ? 0.7 : 1
          }}
          onClick={onSummarize}
          disabled={summarizing}
        >
          {summarizing ? '总结中…' : '翻译总结'}
        </button>
      </div>

      {/* 结果展示区 */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderRadius: 10,
          background: 'radial-gradient(circle at top left, rgba(15, 23, 42, 0.98), #020617)',
          border: '1px solid rgba(148, 163, 184, 0.4)',
          padding: 12
        }}
      >
        {entries.length === 0 ? (
          <div style={{
            color: 'rgba(148, 163, 184, 0.5)',
            fontSize: 13,
            textAlign: 'center',
            marginTop: 20
          }}>
            点击「开始监听」后再点「翻译总结」，即可翻译当前段落
          </div>
        ) : (
          entries.map((entry, idx) => (
            <div key={entry.id}>
              {/* 时间戳分隔 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6
              }}>
                <span style={{
                  fontSize: 11,
                  color: 'rgba(148, 163, 184, 0.5)',
                  flexShrink: 0
                }}>
                  {entry.timestamp}
                </span>
                <div style={{
                  flex: 1,
                  height: 1,
                  background: 'rgba(148, 163, 184, 0.15)'
                }} />
              </div>
              {/* 翻译内容 */}
              <div style={{
                fontSize: 14,
                lineHeight: 1.7,
                color: '#e5e7eb',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}>
                {entry.text}
                {/* 流式光标（最新条目还未完成时显示） */}
                {entry.streaming ? (
                  <span style={{
                    display: 'inline-block',
                    width: 2,
                    height: '1em',
                    background: '#6ee7b7',
                    marginLeft: 2,
                    verticalAlign: 'text-bottom',
                    animation: 'blink 1s step-start infinite'
                  }} />
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 状态提示 */}
      {listening && (
        <div style={{
          fontSize: 11,
          color: 'rgba(110, 231, 183, 0.7)',
          textAlign: 'center',
          flexShrink: 0
        }}>
          正在监听…点击「翻译总结」生成当前段落翻译
        </div>
      )}
    </div>
  );
};

export default TranslatePanel;
