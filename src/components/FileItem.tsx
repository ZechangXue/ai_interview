import React from 'react';
import type { ContextFile } from '../../electron/types';

const labelText: Record<'JD' | 'Resume' | 'Notes' | 'Doc', string> = {
  JD: 'JD',
  Resume: 'Resume',
  Notes: 'Notes',
  Doc: '项目文档'
};

interface Props {
  file: ContextFile;
}

const FileItem: React.FC<Props> = ({ file }) => {
  const date = new Date(file.createdAt);
  const inProgress = !file.ragIndexed;

  return (
    <div className="file-item">
      <div className="file-main">
        <div className="file-name">{file.fileName}</div>
        <div className="file-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="label-tag">{labelText[file.label]}</span>
          <span className="muted">
            {date.toLocaleDateString()} {date.toLocaleTimeString()}
          </span>
          {inProgress ? (
            <span
              className="muted"
              style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(148,163,184,0.7)' }}
            >
              {file.label === 'Doc'
                ? '待索引，请点击「分析文档并建立索引」'
                : '上传完成，请点击上方「根据资料自动优化 System Prompt」'}
            </span>
          ) : (
            <span
              style={{
                fontSize: 12,
                padding: '2px 6px',
                borderRadius: 4,
                border: '1px solid rgba(34,197,94,0.8)',
                color: '#4ade80'
              }}
            >
              {file.label === 'Doc' ? '已建索引' : '已完成分析'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileItem;

