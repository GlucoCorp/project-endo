import { useEffect, useState } from 'react';
import { t } from '../i18n.ts';
import styles from '../enrol/enrol.module.css';
import { SIGN_IN_PATH, checkSession, signOut, type SessionState } from './session.ts';

/**
 * Home (spec 21.7). Signed out: sign in with her passkey, or open her clinic's link. Signed in:
 * her diary arrives in M2; for now she can sign out.
 */
export function HomePage() {
  const [state, setState] = useState<SessionState | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    void checkSession(window.fetch.bind(window)).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const leave = () => {
    setState('loading');
    void signOut(window.fetch.bind(window)).then((ok) => {
      setState(ok ? 'signed-out' : 'error');
    });
  };

  return (
    <main className={styles['page']}>
      <h1 className={styles['title']}>{t('home.title')}</h1>
      {state === 'loading' && <p role="status">{t('common.loading')}</p>}
      {state === 'error' && (
        <p role="alert" className={styles['error']}>
          {t('common.try-later')}
        </p>
      )}
      {state === 'signed-in' && (
        <>
          <p role="status">{t('home.signed-in')}</p>
          <button type="button" className={styles['quiet']} onClick={leave}>
            {t('home.sign-out')}
          </button>
        </>
      )}
      {state === 'signed-out' && (
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
