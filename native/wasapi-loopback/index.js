'use strict';

const path = require('path');
const isWindows = process.platform === 'win32';

let binding = null;
if (isWindows) {
  try {
    binding = require(path.join(__dirname, 'build', 'Release', 'wasapi_loopback.node'));
  } catch (e) {
    try {
      binding = require(path.join(__dirname, 'build', 'Debug', 'wasapi_loopback.node'));
    } catch (e2) {
      // Addon not built or not found
    }
  }
}

/**
 * Start WASAPI loopback capture from the default playback device.
 * @param {Object} options - { sampleRate: 16000|24000, channels: 1 }
 * @param {Function} onAudioData - (pcmBuffer: Buffer) => void, PCM int16 LE mono
 */
function startLoopbackCapture(options, onAudioData) {
  if (!isWindows) {
    throw new Error('WASAPI loopback is only supported on Windows');
  }
  if (!binding || !binding.startLoopbackCapture) {
    throw new Error('WASAPI loopback addon not available (build failed or not Windows)');
  }
  const opts = { sampleRate: 16000, channels: 1, ...options };
  binding.startLoopbackCapture(opts, onAudioData);
}

/**
 * Stop the current loopback capture.
 */
function stopLoopbackCapture() {
  if (!isWindows) return;
  if (binding && binding.stopLoopbackCapture) {
    binding.stopLoopbackCapture();
  }
}

module.exports = {
  startLoopbackCapture,
  stopLoopbackCapture,
  isSupported: isWindows && !!binding?.startLoopbackCapture
};
