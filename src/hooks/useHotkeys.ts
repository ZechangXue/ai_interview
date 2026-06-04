import { useEffect } from 'react';

interface HotkeysConfig {
  onSpace?: () => void;
  onToggleListening?: () => void;
  onOpenContext?: () => void;
  onHideWindow?: () => void;
}

export function useHotkeys(config: HotkeysConfig) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput =
        tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable;

      if (!isInput && e.code === 'Space') {
        if (config.onSpace) {
          e.preventDefault();
          config.onSpace();
        }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 's' && config.onToggleListening) {
          e.preventDefault();
          config.onToggleListening();
          return;
        }
        if (key === 'u' && config.onOpenContext) {
          e.preventDefault();
          config.onOpenContext();
          return;
        }
      }

      if (e.key === 'Escape' && config.onHideWindow) {
        e.preventDefault();
        config.onHideWindow();
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [config]);
}

