import React, { useState, useEffect, useCallback } from 'react';
import './MacSetupWizard.css';

// BlackHole 官方下载页（GitHub Releases）
const BLACKHOLE_DOWNLOAD_URL =
  'https://existingaudio.com/blackhole/';

type Step = 'install' | 'configure' | 'meeting' | 'done';

interface Props {
  onComplete: () => void;
}

const MacSetupWizard: React.FC<Props> = ({ onComplete }) => {
  const [step, setStep] = useState<Step>('install');
  const [blackHoleDetected, setBlackHoleDetected] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [multiOutputExists, setMultiOutputExists] = useState(false);

  // ─── 轮询：检测 BlackHole 是否安装完成 ──────────────────────────────────
  useEffect(() => {
    if (step !== 'install' || blackHoleDetected) return;

    const check = async () => {
      const result = await window.teleprompter.macCheckBlackHole();
      if (result.installed) {
        setBlackHoleDetected(true);
      }
    };

    check(); // 立即检查一次
    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  }, [step, blackHoleDetected]);

  // BlackHole 检测到后，延迟 1.2s 自动跳到下一步（给用户看到成功提示）
  useEffect(() => {
    if (!blackHoleDetected || step !== 'install') return;
    const t = setTimeout(() => setStep('configure'), 1200);
    return () => clearTimeout(t);
  }, [blackHoleDetected, step]);

  // ─── 轮询：检测多输出设备是否已创建（步骤2时） ──────────────────────────
  useEffect(() => {
    if (step !== 'configure') return;

    const check = async () => {
      const exists = await window.teleprompter.macCheckMultiOutput();
      if (exists) setMultiOutputExists(true);
    };

    check();
    const timer = setInterval(check, 2500);
    return () => clearInterval(timer);
  }, [step]);

  const handleDownload = useCallback(() => {
    window.teleprompter.macOpenExternalUrl(BLACKHOLE_DOWNLOAD_URL);
    setDownloadStarted(true);
  }, []);

  const handleOpenAudioMidi = useCallback(() => {
    window.teleprompter.macOpenAudioMidiSetup();
  }, []);

  const handleComplete = useCallback(async () => {
    await window.teleprompter.macMarkSetupDone();
    setStep('done');
    setTimeout(() => onComplete(), 1000);
  }, [onComplete]);

  // ─── 完成动画页 ──────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <div className="msw-overlay">
        <div className="msw-done">
          <div className="msw-done-check">✓</div>
          <p>配置完成，尽情使用！</p>
        </div>
      </div>
    );
  }

  const stepIndex = ['install', 'configure', 'meeting'].indexOf(step);

  return (
    <div className="msw-overlay">
      <div className="msw-card">

        {/* 进度指示点 */}
        <div className="msw-progress">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className={`msw-dot ${
                i === stepIndex ? 'active' : i < stepIndex ? 'passed' : ''
              }`}
            />
          ))}
        </div>

        {/* ══ 步骤 1：安装 BlackHole ══════════════════════════════════════ */}
        {step === 'install' && (
          <div className="msw-step">
            <div className="msw-icon">🔊</div>
            <h2>第一步：安装虚拟声卡</h2>
            <p className="msw-desc">
              BlackHole 是一个免费开源的虚拟声卡，<br />
              让本应用能"听到"会议软件里的声音
            </p>

            <button className="msw-btn primary" onClick={handleDownload}>
              ↓ 下载 BlackHole（免费，约 1MB）
            </button>

            {downloadStarted && !blackHoleDetected && (
              <div className="msw-hint">
                <p>
                  📦 打开下载的 <strong>.pkg</strong> 文件，按提示安装
                </p>
                <p className="msw-waiting">
                  <span className="msw-spin">⏳</span> 正在等待安装完成…
                </p>
              </div>
            )}

            {blackHoleDetected && (
              <div className="msw-success">
                ✓ 已检测到 BlackHole，自动进入下一步…
              </div>
            )}

            {!downloadStarted && (
              <button
                className="msw-btn skip"
                onClick={() => setStep('configure')}
              >
                已安装过，跳过
              </button>
            )}
          </div>
        )}

        {/* ══ 步骤 2：创建多输出设备 ═════════════════════════════════════ */}
        {step === 'configure' && (
          <div className="msw-step">
            <div className="msw-icon">🎛️</div>
            <h2>第二步：连接声音通道</h2>
            <p className="msw-desc">
              创建「多输出设备」，让你既能听到声音，应用也能捕获
            </p>

            <button className="msw-btn secondary" onClick={handleOpenAudioMidi}>
              打开「音频 MIDI 设置」↗
            </button>

            <ol className="msw-steps-list">
              <li>
                点左下角 <code>+</code> → 选<strong>「创建多输出设备」</strong>
              </li>
              <li>
                右侧勾选 <strong>BlackHole 2ch</strong> ＋{' '}
                <strong>内建扬声器</strong>（或你正在用的耳机）
              </li>
              <li>
                右键「多输出设备」→{' '}
                <strong>「将此设备用作系统声音输出」</strong>
              </li>
            </ol>

            {multiOutputExists && (
              <div className="msw-success">✓ 已检测到多输出设备！</div>
            )}

            <div className="msw-btn-row">
              <button className="msw-btn primary" onClick={() => setStep('meeting')}>
                已完成上面步骤 →
              </button>
              <button className="msw-btn skip" onClick={() => setStep('meeting')}>
                我用蓝牙耳机，跳过
              </button>
            </div>
          </div>
        )}

        {/* ══ 步骤 3：设置会议软件 ══════════════════════════════════════ */}
        {step === 'meeting' && (
          <div className="msw-step">
            <div className="msw-icon">💻</div>
            <h2>第三步：设置会议软件</h2>
            <p className="msw-desc">
              在会议软件中，把「扬声器 / 音频输出」改为：
              <br />
              <strong>Multi-Output Device（多输出设备）</strong>
            </p>

            <div className="msw-app-tips">
              <div className="msw-app-tip">
                <span className="msw-app-name">Zoom</span>
                设置 → 音频 → 扬声器
              </div>
              <div className="msw-app-tip">
                <span className="msw-app-name">腾讯会议</span>
                设置 → 音频 → 扬声器 / 输出设备
              </div>
              <div className="msw-app-tip">
                <span className="msw-app-name">Teams</span>
                设置 → 设备 → 扬声器
              </div>
              <div className="msw-app-tip">
                <span className="msw-app-name">Google Meet</span>
                右下角三点 → 设置 → 音频 → 扬声器
              </div>
            </div>

            <p className="msw-note">
              💡 只需配置一次，之后每次打开会议软件会自动使用。
            </p>

            <button className="msw-btn primary" onClick={handleComplete}>
              完成，开始使用！🚀
            </button>
          </div>
        )}

      </div>
    </div>
  );
};

export default MacSetupWizard;
