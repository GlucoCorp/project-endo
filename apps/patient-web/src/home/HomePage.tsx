import { useEffect, useState } from 'react';
import { t } from '../i18n.ts';
import { EmailSettings } from './EmailSettings.tsx';
import { Reminders } from './Reminders.tsx';
import { TrialHome, offlineQueue } from '../checkin/TrialHome.tsx';
import styles from '../enrol/enrol.module.css';
import {
  SIGN_IN_PATH,
  checkSession,
  lockNow,
  setAppLock,
  signOut,
  type SessionState,
} from './session.ts';

/**
 * Home (spec 21.7). Signed out: sign in with her passkey, or open her clinic's link. Locked
 * (spec 10.1 app lock): nothing but "Unlock". Signed in: her check-in arrives in M2; for now app
 * lock and sign out.
 */
export function HomePage() {
  const [state, setState] = useState<SessionState | { readonly kind: 'loading' }>({
    kind: 'loading',
  });
  const fetchFn = window.fetch.bind(window);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void checkSession(fetchFn).then((s) => {
        // No session: whatever is queued can never be sent under it (spec 14).
        if (s.kind === 'signed-out') void offlineQueue.clear().catch(() => undefined);
        if (live) setState(s);
      });
    };
    refresh();
    // Leaving the app locks it (if she chose app lock); coming back shows where she is.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') lockNow(fetchFn);
      else refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const leave = () => {
    setState({ kind: 'loading' });
    void offlineQueue.clear().catch(() => undefined);
    void signOut(fetchFn).then((ok) => {
      setState(ok ? { kind: 'signed-out' } : { kind: 'error' });
    });
  };
  const toggleLock = (enabled: boolean) => {
    void setAppLock(fetchFn, enabled).then((ok) => {
      setState(ok ? { kind: 'signed-in', appLock: enabled } : { kind: 'error' });
    });
  };

  return (
    <main className={styles['page']}>
      <h1 className={styles['title']}>{t('home.title')}</h1>
      {state.kind === 'loading' && <p role="status">{t('common.loading')}</p>}
      {state.kind === 'error' && (
        <p role="alert" className={styles['error']}>
          {t('common.try-later')}
        </p>
      )}
      {state.kind === 'locked' && (
        <>
          <p role="status">{t('home.locked')}</p>
          <a className={styles['primary']} href={SIGN_IN_PATH}>
            {t('home.unlock')}
          </a>
        </>
      )}
      {state.kind === 'signed-in' && (
        <>
          <TrialHome />
          <p>
            <a href="/history">{t('home.history')}</a>
          </p>
          <p className={styles['muted']}>
            {t(state.appLock ? 'home.app-lock-on' : 'home.app-lock-off')}
          </p>
          <button
            type="button"
            className={styles['quiet']}
            aria-pressed={state.appLock}
            onClick={() => {
              toggleLock(!state.appLock);
            }}
          >
            {t(state.appLock ? 'home.app-lock-disable' : 'home.app-lock-enable')}
          </button>
          <Reminders />
          <EmailSettings />
          <button type="button" className={styles['quiet']} onClick={leave}>
            {t('home.sign-out')}
          </button>
        </>
      )}
      {state.kind === 'signed-out' && (
        <>
          <a className={styles['primary']} href={SIGN_IN_PATH}>
            {t('home.sign-in')}
          </a>
          <p className={styles['muted']}>{t('enrol.no-link')}</p>
        </>
      )}
    </main>
  );
}
