/**
 * Windows-only: WASAPI loopback capture (system playback).
 * Use this when deviceId === -1 on Windows instead of naudiodon.
 */

const isWindows = process.platform === 'win32';

interface WasapiBinding {
  startLoopbackCapture: (opts: { sampleRate: number; channels: number }, cb: (buf: Buffer) => void) => void;
  stopLoopbackCapture: () => void;
}

let binding: WasapiBinding | null = null;

function loadBinding(): WasapiBinding | null {
  if (!isWindows) return null;
  if (binding !== null) return binding;
  try {
    const mod = require('wasapi-loopback') as Partial<WasapiBinding>;
    if (mod && typeof mod.startLoopbackCapture === 'function' && typeof mod.stopLoopbackCapture === 'function') {
      binding = mod as WasapiBinding;
      return binding;
    }
  } catch {
    // addon not built or not installed
  }
  binding = null;
  return null;
}

export function isWASAPILoopbackSupported(): boolean {
  return !!loadBinding();
}

export function startWASAPILoopback(
  options: { sampleRate: number; channels?: number },
  onAudioData: (pcmBuffer: Buffer) => void
): boolean {
  const b = loadBinding();
  if (!b) return false;
  b.startLoopbackCapture(
    { sampleRate: options.sampleRate, channels: options.channels ?? 1 },
    onAudioData
  );
  return true;
}

export function stopWASAPILoopback(): void {
  const b = loadBinding();
  if (b) b.stopLoopbackCapture();
}
