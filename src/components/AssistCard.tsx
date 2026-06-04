import React from 'react';
import type { AssistJSON, ReadableAssistJSON, ResponseStyle } from '../../electron/types';

type AnyAssist = Partial<AssistJSON & ReadableAssistJSON>;

interface Props {
  assist: AnyAssist;
  responseStyle?: ResponseStyle;
  streaming?: boolean;
  onClose?: () => void;
  /** 当前卡片已请求并显示可读答案（极简模式下点击「显示可读答案」后为 true） */
  displayAsReadable?: boolean;
  /** 极简模式下，请求当前问题的可读答案（一句+展开），返回 Promise 便于显示 loading */
  onGetReadableAnswer?: (questionZh: string) => Promise<void>;
  /** 组会/项目介绍模式：使用中文布局 */
  meetingMode?: boolean;
}

const Cursor: React.FC = () => (
  <span
    style={{
      display: 'inline-block',
      width: 2,
      height: '1em',
      background: 'currentColor',
      marginLeft: 2,
      verticalAlign: 'text-bottom',
      animation: 'blink 0.8s step-end infinite'
    }}
  />
);

const LoadingDots: React.FC = () => (
  <span className="muted" style={{ fontSize: 13 }}>
    生成中…
  </span>
);

// ── Layout A: Concise Hint Mode（现有行为，保持不变）────────────────────

const ConciseLayout: React.FC<{
  assist: AnyAssist;
  streaming: boolean;
  onClose?: () => void;
  onGetReadableAnswer?: (questionZh: string) => Promise<void>;
}> = ({ assist, streaming, onClose, onGetReadableAnswer }) => {
  const [loading, setLoading] = React.useState(false);
  const hasQuestion = !!assist.question_zh;
  const hasConciseAnswer = !!assist.concise_answer_en;
  const hasKeywords = Array.isArray(assist.keywords_en) && assist.keywords_en.length > 0;

  const handleGetReadable = async () => {
    if (!assist.question_zh || !onGetReadableAnswer) return;
    setLoading(true);
    try {
      await onGetReadableAnswer(assist.question_zh);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="assist-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div className="assist-question">
          {hasQuestion ? assist.question_zh : <LoadingDots />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {hasQuestion && onGetReadableAnswer && (
            <button
              type="button"
              className="btn"
              style={{ fontSize: 11, padding: '4px 8px' }}
              onClick={handleGetReadable}
              disabled={loading}
              title="获取可读答案（一句+展开），思路断了可直接朗读"
            >
              {loading ? '…' : '可读答案'}
            </button>
          )}
          {onClose && (
            <button
              className="icon-btn"
              style={{ marginLeft: 4 }}
              onClick={onClose}
              title="关闭当前卡片（Space）"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 极简模式：一句完整英文回答，可直接朗读 */}
      <div>
        <div className="assist-section-title">CONCISE · 一句回答</div>
        {hasConciseAnswer ? (
          <div
            className="assist-thinking"
            style={{ fontStyle: 'italic', color: 'var(--color-concise, #93c5fd)' }}
          >
            {assist.concise_answer_en}
            {streaming && !hasKeywords && <Cursor />}
          </div>
        ) : (
          <div className="assist-thinking" style={{ opacity: 0.5 }}>
            {streaming && hasKeywords ? (
              <span className="muted" style={{ fontSize: 13 }}>
                正在生成英文一句…
              </span>
            ) : (
              <LoadingDots />
            )}
          </div>
        )}
      </div>

      <div>
        <div className="assist-section-title">KEYWORDS · 英文关键词</div>
        {hasKeywords ? (
          <div className="assist-keywords">
            {(assist.keywords_en ?? []).map((k, idx) => (
              <span key={idx} className="keyword-chip">
                <strong>{k}</strong>
              </span>
            ))}
          </div>
        ) : (
          <div className="assist-keywords" style={{ opacity: 0.5 }}>
            <LoadingDots />
          </div>
        )}
      </div>
    </div>
  );
};

// ── Layout B: Readable Answer Mode（新模式）────────────────────────────

const ReadableLayout: React.FC<{
  assist: AnyAssist;
  streaming: boolean;
  onClose?: () => void;
  /** 从极简模式点击「可读答案」切换而来时为 true，此时不再重复展示一句回答（假定已说过） */
  fromConcise?: boolean;
}> = ({ assist, streaming, onClose, fromConcise }) => {
  const hasQuestion = !!assist.question_zh;
  const conciseOne = (assist as any).readable_concise_answer_en ?? assist.concise_answer_en;
  const hasConcise = !!conciseOne;
  const hasExpanded = !!assist.expanded_answer_en;

  return (
    <div className="assist-card">
      {/* 问题 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div className="assist-question">
          {hasQuestion ? assist.question_zh : <LoadingDots />}
        </div>
        {onClose && (
          <button
            className="icon-btn"
            style={{ marginLeft: 8, flexShrink: 0 }}
            onClick={onClose}
            title="关闭当前卡片（Space）"
          >
            ✕
          </button>
        )}
      </div>

      {/* 简洁回答：从极简切换而来时不再展示（假定那句已说过） */}
      {!fromConcise && (
        <div>
          <div className="assist-section-title">CONCISE · 一句回答</div>
          {hasConcise ? (
            <div
              className="assist-thinking"
              style={{ fontStyle: 'italic', color: 'var(--color-concise, #93c5fd)' }}
            >
              {conciseOne}
              {streaming && !hasExpanded && <Cursor />}
            </div>
          ) : (
            <div className="assist-thinking" style={{ opacity: 0.5 }}>
              <LoadingDots />
            </div>
          )}
        </div>
      )}

      {/* 展开回答 */}
      <div>
        <div className="assist-section-title">EXPANDED · 展开回答</div>
        {hasExpanded ? (
          <div className="assist-thinking" style={{ lineHeight: 1.7 }}>
            {assist.expanded_answer_en}
            {streaming && <Cursor />}
          </div>
        ) : (
          <div className="assist-thinking" style={{ opacity: 0.5 }}>
            <LoadingDots />
          </div>
        )}
      </div>
    </div>
  );
};

// ── Layout C: Meeting Mode（组会/项目介绍，中文回答）──────────────────

const MeetingLayout: React.FC<{
  assist: AnyAssist;
  streaming: boolean;
  onClose?: () => void;
}> = ({ assist, streaming, onClose }) => {
  const hasQuestion = !!assist.question_zh;
  const hasBrief = !!assist.concise_answer_en;
  const hasDetail = !!assist.expanded_answer_en;

  return (
    <div className="assist-card">
      {/* 问题 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div className="assist-question">
          {hasQuestion ? assist.question_zh : <LoadingDots />}
        </div>
        {onClose && (
          <button
            className="icon-btn"
            style={{ marginLeft: 8, flexShrink: 0 }}
            onClick={onClose}
            title="关闭当前卡片（Space）"
          >
            ✕
          </button>
        )}
      </div>

      {/* 简答（中文直接回答） */}
      <div>
        <div className="assist-section-title">简答</div>
        {hasBrief ? (
          <div
            className="assist-thinking"
            style={{ fontStyle: 'italic', color: 'var(--color-concise, #93c5fd)' }}
          >
            {assist.concise_answer_en}
            {streaming && !hasDetail && <Cursor />}
          </div>
        ) : (
          <div className="assist-thinking" style={{ opacity: 0.5 }}>
            <LoadingDots />
          </div>
        )}
      </div>

      {/* 详解（含原因/技术细节） */}
      <div>
        <div className="assist-section-title">详解</div>
        {hasDetail ? (
          <div className="assist-thinking" style={{ lineHeight: 1.7 }}>
            {assist.expanded_answer_en}
            {streaming && <Cursor />}
          </div>
        ) : (
          <div className="assist-thinking" style={{ opacity: 0.5 }}>
            <LoadingDots />
          </div>
        )}
      </div>
    </div>
  );
};

// ── 主组件：根据 responseStyle / meetingMode 选择布局 ─────────────────

const AssistCard: React.FC<Props> = ({
  assist,
  responseStyle = 'concise',
  streaming = false,
  onClose,
  displayAsReadable = false,
  onGetReadableAnswer,
  meetingMode = false
}) => {
  // 有 expanded_answer_en（面试/组会均如此），使用简答+详解布局
  if (meetingMode || assist.expanded_answer_en) {
    return (
      <MeetingLayout
        assist={assist}
        streaming={streaming}
        onClose={onClose}
      />
    );
  }

  // 降级：极少数情况下没有 expanded（如纯噪音后恢复的旧卡片），用紧凑布局
  return (
    <ConciseLayout
      assist={assist}
      streaming={streaming}
      onClose={onClose}
      onGetReadableAnswer={onGetReadableAnswer}
    />
  );
};

export default AssistCard;
