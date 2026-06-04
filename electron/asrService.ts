import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

function pcm16ToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const dataSize = pcm.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(headerSize + dataSize - 8, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  buffer.writeUInt32LE(byteRate, 28);
  const blockAlign = channels * BYTES_PER_SAMPLE;
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34); // bits per sample

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  pcm.copy(buffer, headerSize);
  return buffer;
}

export async function transcribeSegment(
  audioBuffer: Buffer,
  apiKey: string,
  mock: boolean
): Promise<string> {
  if (mock) {
    // Mock：用于开发调试
    return 'Could you briefly introduce your recent project experience?';
  }

  const client = new OpenAI({ apiKey });

  const tmpDir = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `segment-${Date.now()}.wav`);
  const wavBuffer = pcm16ToWav(audioBuffer, SAMPLE_RATE, CHANNELS);
  fs.writeFileSync(tmpPath, wavBuffer);

  try {
    const file = fs.createReadStream(tmpPath);
    const res = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'json'
    });
    const text = (res as any).text || '';
    return String(text).trim();
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

