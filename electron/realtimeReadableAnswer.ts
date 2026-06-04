/**
 * 通过 Realtime API（WebSocket）用「文本输入」请求可读答案（一句+展开）。
 * 当用户已选 useRealtimeAsr 或 useRealtimeAllInOne 时，可读答案也走同一 Realtime 模型，延迟更低。
 */

import WebSocket from 'ws';
import type { ReadableAssistJSON } from './types';

const DEFAULT_REALTIME_MODEL = 'gpt-4o-mini-realtime-preview';

/**
 * 使用 Realtime 模型：发文本问题 → 收 JSON 可读答案。
 * @param apiKey OpenAI API Key
 * @param model 如 gpt-4o-mini-realtime-preview
 * @param instructions 完整 system 指令（含上下文），与 llmClient.buildSystemContent(READABLE_SYSTEM_PROMPT, ...) 一致
 * @param questionZh 当前问题中文
 */
export function generateReadableAnswerViaRealtime(
  apiKey: string,
  model: string,
  instructions: string,
  questionZh: string
): Promise<ReadableAssistJSON> {
  const effectiveModel = model || DEFAULT_REALTIME_MODEL;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${effectiveModel}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    let accumulated = '';
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Realtime readable answer timeout'));
    }, 60000);

    ws.on('open', () => {
      // 仅文本输出，不需要音频；不启用 turn_detection，由我们主动 response.create
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions,
          input_audio_format: 'pcm16',
          turn_detection: null
        }
      }));

      // 用户消息：当前问题（文本）
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: questionZh }]
        }
      }));

      // 触发生成
      ws.send(JSON.stringify({ type: 'response.create' }));
    });

    ws.on('message', (data: Buffer) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      const type = event.type ?? '';

      if (type === 'error') {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        reject(new Error(event.error?.message ?? 'Realtime error'));
        return;
      }

      if (type === 'response.text.delta') {
        accumulated += event.delta ?? '';
      }

      if (type === 'response.text.done') {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        const raw = event.text ?? accumulated;
        let obj: any = {};
        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) obj = JSON.parse(m[0]);
        } catch {}
        resolve({
          question_zh: typeof obj.question_zh === 'string' && obj.question_zh.trim()
            ? obj.question_zh.trim() : questionZh,
          concise_answer_en: typeof obj.concise_answer_en === 'string' && obj.concise_answer_en.trim()
            ? obj.concise_answer_en.trim() : '',
          expanded_answer_en: typeof obj.expanded_answer_en === 'string' && obj.expanded_answer_en.trim()
            ? obj.expanded_answer_en.trim() : ''
        });
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  });
}
