import { useEffect } from 'react';
import { t } from './i18n.ts';
import { offlineQueue } from './checkin/TrialHome.tsx';
import { signOutNow } from './home/session.ts';
import styles from './quick-exit.module.css';

/**
 * Quick exit (spec 13.2): on every screen, clearly labelled, one tap. It clears what this tab
 * holds (the session storage with her code, in-memory state goes with the page) and replaces the
 * page with a blank one, replacing the history entry so Back does not return here. Pressing
 * Escape twice in a row does the same. No third-party page is opened (spec 2.1).
 */
export function quickExit(): void {
  try {
    window.sessionStorage.clear();
    // Spec 13.2: the session ends and the offline queue (and its key) is destroyed. Neither is
    // awaited: the screen goes first.
    signOutNow(window.fetch.bind(window));
    void offlineQueue.clear().catch(() => undefined);
  } finally {
    window.location.replace('about:blank');
  }
}

export function QuickExit() {
  useEffect(() => {
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const now = Date.now();
      if (now - last < 800) quickExit();
      last = now;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <button
      type="button"
      className={styles['exit']}
      title={t('common.quick-exit-help')}
      onClick={quickExit}
    >
      {t('common.quick-exit')}
    </button>
  );
}
