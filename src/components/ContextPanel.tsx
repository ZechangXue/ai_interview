import React, { useEffect, useState } from 'react';
import type { ContextFile, ContextLabel } from '../../electron/types';
import FileItem from './FileItem';

interface Props {
  onClose: () => void;
  meetingMode?: boolean;
  onToggleMeetingMode?: () => void;
}

const ContextPanel: React.FC<Props> = ({ onClose, meetingMode = false, onToggleMeetingMode }) => {
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [uploadLabel, setUploadLabel] = useState<ContextLabel>('JD');

  useEffect(() => {
    (async () => {
      const fs = await window.teleprompter.getContextFiles();
      setFiles(fs);
    })();
  }, []);

  useEffect(() => {
    window.teleprompter.onContextUpdated(() => { refresh(); });
  }, []);


  const refresh = async () => {
    const fs = await window.teleprompter.getContextFiles();
    setFiles(fs);
  };

  const handleClear = async () => {
    if (!window.confirm(meetingMode
      ? '确认清空所有项目文档与向量索引？'
      : '确认清空所有资料与问题历史？')) return;
    if (meetingMode) {
      await (window.teleprompter as any).clearMeetingDocuments();
    } else {
      await window.teleprompter.clearContext();
      await window.teleprompter.clearQuestionsHistory();
    }
    await refresh();
  };

  const handleUpload = async () => {
    const picked = await window.teleprompter.pickContextFile();
    if (!picked) return;
    try {
      const label: ContextLabel = meetingMode ? 'Doc' : uploadLabel;
      await window.teleprompter.addContextFile(picked, label);
      await refresh();
    } catch (e) {
      console.error(e);
      alert('导入失败，请检查文件路径或格式。');
    }
  };

  const meetingFiles = files.filter(f => (f as any).docType === 'meeting_doc');
  const interviewFiles = files.filter(f => (f as any).docType !== 'meeting_doc');
  const displayFiles = meetingMode ? meetingFiles : interviewFiles;

  return (
    <div className="panel-overlay">
      <div className="panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="panel-title">
            {meetingMode ? '项目文档库 / Meeting Docs' : '资料库 / Context'}
          </div>
          {onToggleMeetingMode && (
            <button
              className="btn"
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderColor: meetingMode ? 'rgba(168,85,247,0.8)' : undefined,
                color: meetingMode ? '#c084fc' : undefined
              }}
              onClick={onToggleMeetingMode}
              title={meetingMode ? '切换到面试模式' : '切换到组会/项目介绍模式'}
            >
              {meetingMode ? '组会模式 ▸ 切换面试' : '面试模式 ▸ 切换组会'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={handleClear}>
            {meetingMode ? '清空文档 & 索引' : '清空资料 & 问题历史'}
          </button>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="panel-body">
        {meetingMode ? (
          // ── 组会模式上传区 ─────────────────────────────────────────
          <div style={{ marginBottom: 8 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              上传项目 / 产品 / 技术文档（TXT / MD / PDF / DOCX）
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button className="btn" onClick={handleUpload}>
                选择文件并导入
              </button>
            </div>
            {meetingFiles.length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4, color: '#4ade80' }}>
                已上传 {meetingFiles.length} 份文档，可直接开始提问。
              </div>
            )}
          </div>
        ) : (
          // ── 面试模式上传区 ─────────────────────────────────────────
          <div style={{ marginBottom: 8 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              上传 TXT / MD / PDF / DOCX（使用系统文件选择器）
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <select
                className="select"
                style={{ maxWidth: 200 }}
                value={uploadLabel}
                onChange={e => setUploadLabel(e.target.value as ContextLabel)}
              >
                <option value="JD">JD · Job Description</option>
                <option value="Resume">Resume · 简历</option>
                <option value="Notes">Project Notes · 项目总结</option>
                <option value="Notes">QA Notes · Q&A 笔记</option>
              </select>
              <button className="btn" onClick={handleUpload}>
                选择文件并导入
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="muted">
            {meetingMode ? `已上传文档（${meetingFiles.length} 个）` : `已加载的资料（${interviewFiles.length} 个）`}
          </div>
          <div className="file-list">
            {displayFiles.length === 0 && (
              <div className="muted">
                {meetingMode ? '尚未上传任何项目文档。' : '尚未上传任何资料。'}
              </div>
            )}
            {displayFiles.map(f => (
              <FileItem key={f.id} file={f} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContextPanel;

