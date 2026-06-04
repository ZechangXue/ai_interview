/**
 * Mac 专属 IPC 处理器
 * 在 main.ts 的 app.whenReady 里仅 darwin 下调用，Windows 完全不执行。
 */

import { ipcMain, shell } from 'electron';
import {
  checkBlackHoleInstalled,
  checkMultiOutputExists,
  isMacSetupDone,
  markMacSetupDone,
  resetMacSetup,
  openAudioMidiSetup,
  openSystemSoundPreferences,
} from './macAudioSetup';

export function registerMacIpcHandlers(): void {
  /** 检测 BlackHole 是否已安装 */
  ipcMain.handle('mac:checkBlackHole', () => checkBlackHoleInstalled());

  /** 检测多输出设备是否存在 */
  ipcMain.handle('mac:checkMultiOutput', () => checkMultiOutputExists());

  /** 查询引导是否已完成 */
  ipcMain.handle('mac:setupDone', () => isMacSetupDone());

  /** 标记引导完成 */
  ipcMain.handle('mac:markSetupDone', () => markMacSetupDone());

  /** 重置引导（调试用） */
  ipcMain.handle('mac:resetSetup', () => resetMacSetup());

  /** 打开「音频 MIDI 设置」 */
  ipcMain.handle('mac:openAudioMidiSetup', async () => {
    try {
      await openAudioMidiSetup();
    } catch {
      // ignore
    }
  });

  /** 打开系统声音偏好设置 */
  ipcMain.handle('mac:openSoundPreferences', async () => {
    try {
      await openSystemSoundPreferences();
    } catch {
      // ignore
    }
  });

  /** 用系统默认浏览器打开外部 URL（用于下载 BlackHole） */
  ipcMain.handle('mac:openExternalUrl', (_evt, url: unknown) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });
}
