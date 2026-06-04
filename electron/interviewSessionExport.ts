/**
 * 一键导出：读取会话实录 JSON → 调用 LLM 中文总结 → Chromium printToPDF
 */
import { BrowserWindow, dialog, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { readSessionInterviewLog, type SessionInterviewEntry } from './sessionInterviewLog';
import { generateInterviewSessionSummary } from './llmClient';
import { getSettings, getApiKey } from './settingsStore';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function buildTranscriptForSummary(entries: SessionInterviewEntry[]): string {
  const lines: string[] = [];
  entries.forEach((e, i) => {
    const raw = (e.interviewer_question_raw ?? '').trim();
    lines.push(`【第 ${i + 1} 轮】`);
    lines.push(`面试官原话（语音转写）：${raw || '（本轮无逐字转写）'}`);
    lines.push(`卡片题摘要（中文）：${e.question_zh}`);
    lines.push(`极简一句（英文）：${e.concise_answer_en}`);
    if (e.expanded_answer_en?.trim()) {
      lines.push(`可读展开（英文）：${e.expanded_answer_en}`);
    }
    if (e.keywords_en?.length) {
      lines.push(`关键词（英文）：${e.keywords_en.join(', ')}`);
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

function buildHtmlDocument(entries: SessionInterviewEntry[], summaryZh: string, generatedAt: string): string {
  const blocks = entries
    .map((e, i) => {
      const raw = (e.interviewer_question_raw ?? '').trim();
      const rawHtml = raw
        ? escapeHtml(raw)
        : '<span class="muted">(No verbatim transcript for this turn — e.g. older log or readable-only path.)</span>';
      const kw =
        e.keywords_en?.length ?
          `<div class="kw"><span class="label">Keywords</span> ${escapeHtml(e.keywords_en.join(' · '))}</div>`
        : '';
      const exp = e.expanded_answer_en?.trim()
        ? `<div class="block"><span class="label">Expanded answer (EN)</span><p>${escapeHtml(e.expanded_answer_en)}</p></div>`
        : '';
      return `
<section class="qa">
  <h2>Q${i + 1} <span class="muted">${escapeHtml(formatTs(e.ts))}</span></h2>
  <div class="block"><span class="label">Interviewer · verbatim (ASR)</span><p>${rawHtml}</p></div>
  <div class="block"><span class="label">Card summary (ZH · model)</span><p>${escapeHtml(e.question_zh)}</p></div>
  <div class="block"><span class="label">Concise answer (EN)</span><p>${escapeHtml(e.concise_answer_en)}</p></div>
  ${exp}
  ${kw}
</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Interview transcript export</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, "Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif;
      font-size: 12px;
      line-height: 1.55;
      color: #0f172a;
      padding: 24px 32px 40px;
      max-width: 720px;
      margin: 0 auto;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    .meta { color: #64748b; font-size: 11px; margin-bottom: 28px; }
    h2 { font-size: 14px; margin: 20px 0 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    .muted { font-weight: normal; color: #94a3b8; font-size: 11px; margin-left: 8px; }
    .block { margin: 8px 0 12px; }
    .label {
      display: inline-block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #64748b;
      margin-bottom: 4px;
    }
    .block p { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .kw { font-size: 11px; color: #475569; margin-top: 6px; }
    .summary {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 16px 18px;
      margin-top: 28px;
    }
    .summary h2 { margin-top: 0; border: none; padding: 0; }
    .summary p { margin: 0; white-space: pre-wrap; word-break: break-word; }
    @media print {
      body { padding: 16px 20px; }
    }
  </style>
</head>
<body>
  <h1>Interview transcript · 面试实录导出</h1>
  <div class="meta">Exported from 过了么AI · ${escapeHtml(generatedAt)}</div>
  ${blocks}
  <section class="summary">
    <h2>AI recap · 中文复盘总结</h2>
    <p>${escapeHtml(summaryZh)}</p>
  </section>
</body>
</html>`;
}

export type PrepareExportResult =
  | { ok: true; tempPdfPath: string }
  | { ok: false; error: string };

/** 生成 PDF 到临时文件（LLM 总结 + Chromium 打印），不弹保存框 — 供前端显示「导出中」后再 finalize */
export async function prepareSessionInterviewExportPdf(): Promise<PrepareExportResult> {
  const entries = readSessionInterviewLog();
  if (!entries.length) {
    return { ok: false, error: '本次会话暂无问答记录' };
  }

  const settings = getSettings();
  const apiKey = await getApiKey();
  const transcript = buildTranscriptForSummary(entries);

  let summaryZh = '';
  try {
    summaryZh = await generateInterviewSessionSummary(transcript, settings, apiKey);
  } catch (e) {
    console.error('[Export] summary LLM failed', e);
    summaryZh =
      '（总结生成失败：请检查网络、模型名称与 API Key 配置后重试导出。以下为本次已记录的问答实录。）';
  }

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const html = buildHtmlDocument(entries, summaryZh, generatedAt);

  const tmpHtml = path.join(os.tmpdir(), `interview_export_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, `\ufeff${html}`, 'utf-8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true }
  });

  try {
    await win.loadFile(tmpHtml);
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' }
    });

    const tmpPdf = path.join(os.tmpdir(), `interview_export_${Date.now()}.pdf`);
    fs.writeFileSync(tmpPdf, pdfBuffer);
    return { ok: true, tempPdfPath: tmpPdf };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Export] prepare PDF failed', e);
    return { ok: false, error: msg || '生成 PDF 失败' };
  } finally {
    win.destroy();
    try {
      fs.unlinkSync(tmpHtml);
    } catch {
      /* ignore */
    }
  }
}

function isAllowedTempPdfPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const tmp = path.resolve(os.tmpdir());
  const rel = path.relative(tmp, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return /^interview_export_\d+\.pdf$/.test(path.basename(resolved));
}

/** 弹出保存对话框并将临时 PDF 写入用户选择路径 */
export async function finalizeSessionInterviewExportPdf(
  parentWindow: BrowserWindow | null,
  tempPdfPath: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!isAllowedTempPdfPath(tempPdfPath)) {
    return { ok: false, error: '无效的导出临时文件' };
  }
  if (!fs.existsSync(tempPdfPath)) {
    return { ok: false, error: '临时文件已失效，请重新导出' };
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = fs.readFileSync(tempPdfPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || '读取临时文件失败' };
  }

  const defaultName = `Interview-export-${new Date().toISOString().slice(0, 10)}.pdf`;
  const saveOpts = {
    title: '导出面试实录 PDF',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  };
  const parent =
    parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, saveOpts)
    : await dialog.showSaveDialog(saveOpts);

  try {
    fs.unlinkSync(tempPdfPath);
  } catch {
    /* ignore */
  }

  if (canceled || !filePath) {
    return { ok: false, error: '已取消' };
  }

  fs.writeFileSync(filePath, pdfBuffer);
  return { ok: true, path: filePath };
}

/** 一步完成：准备 + 保存（兼容旧调用） */
export async function exportSessionInterviewToPdf(
  parentWindow: BrowserWindow | null
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const prep = await prepareSessionInterviewExportPdf();
  if (!prep.ok) return { ok: false, error: prep.error };
  return finalizeSessionInterviewExportPdf(parentWindow, prep.tempPdfPath);
}
