/**
 * Mac 专属：BlackHole 虚拟声卡 + 音频设置辅助模块
 * 仅在 darwin 平台运行，Windows 构建完全不会加载此文件。
 */

import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ─── PortAudio 懒加载（避免 Mac 下 naudiodon 未重编译时整体崩溃） ────────────
let _portAudio: any = null;

function getPortAudio(): any {
  if (_portAudio !== null) return _portAudio;
  try {
    _portAudio = require('naudiodon');
  } catch {
    _portAudio = undefined;
  }
  return _portAudio;
}

// ─── 配置状态持久化 ───────────────────────────────────────────────────────────

function getSetupFlagPath(): string {
  const { app } = require('electron') as typeof import('electron');
  return path.join(app.getPath('userData'), 'mac-audio-setup-done.json');
}

/** 用户是否已完成过 Mac 音频引导（持久化标记） */
export function isMacSetupDone(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return fs.existsSync(getSetupFlagPath());
  } catch {
    return false;
  }
}

/** 写入「已完成」标记 */
export function markMacSetupDone(): void {
  try {
    fs.writeFileSync(
      getSetupFlagPath(),
      JSON.stringify({ done: true, ts: new Date().toISOString() }),
      'utf-8'
    );
  } catch {
    // ignore
  }
}

/** 重置引导状态（调试用） */
export function resetMacSetup(): void {
  try {
    const p = getSetupFlagPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

// ─── 音频设备检测 ─────────────────────────────────────────────────────────────

export interface MacDeviceInfo {
  installed: boolean;
  deviceId: number | null;
  deviceName: string | null;
}

/** 检测 BlackHole 是否已安装（通过 PortAudio 设备列表） */
export function checkBlackHoleInstalled(): MacDeviceInfo {
  if (process.platform !== 'darwin') {
    return { installed: false, deviceId: null, deviceName: null };
  }
  try {
    const pa = getPortAudio();
    if (!pa) return { installed: false, deviceId: null, deviceName: null };

    const devices = pa.getDevices() as Array<{
      id: number;
      name: string;
      maxInputChannels: number;
    }>;

    const bh = devices.find(
      d => d.name?.toLowerCase().includes('blackhole') && d.maxInputChannels > 0
    );

    if (bh) {
      return { installed: true, deviceId: bh.id, deviceName: bh.name };
    }
    return { installed: false, deviceId: null, deviceName: null };
  } catch {
    return { installed: false, deviceId: null, deviceName: null };
  }
}

/** 检测是否已存在多输出设备（Multi-Output Device） */
export function checkMultiOutputExists(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const pa = getPortAudio();
    if (!pa) return false;

    const devices = pa.getDevices() as Array<{ name: string }>;
    return devices.some(
      d =>
        d.name?.toLowerCase().includes('multi-output') ||
        d.name?.toLowerCase().includes('多输出')
    );
  } catch {
    return false;
  }
}

// ─── 系统操作 ─────────────────────────────────────────────────────────────────

/** 打开「音频 MIDI 设置」 */
export async function openAudioMidiSetup(): Promise<void> {
  await execAsync('open -a "Audio MIDI Setup"');
}

/** 打开系统「声音」偏好设置 */
export async function openSystemSoundPreferences(): Promise<void> {
  try {
    // macOS 13 Ventura+
    await execAsync(
      'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"'
    );
  } catch {
    try {
      // macOS 12 及以下
      await execAsync('open "/System/Library/PreferencePanes/Sound.prefPane"');
    } catch {
      // ignore
    }
  }
}
