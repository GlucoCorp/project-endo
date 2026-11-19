import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import styles from '../desk/desk.module.css';
import { joinToken, startJoin } from './admin.ts';

/**
 * A colleague's invitation link (REQ-010). The token is read from the fragment and removed from
 * the address bar at once; the BFF keeps only its hash for the sign-in that follows.
 */
export function JoinPage() {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading');
  useEffect(() => {
    const token = joinToken(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState('invalid');
      return;
    }
    void startJoin(f, token).then((ok) => {
      setState(ok ? 'ready' : 'invalid');
    });
  }, [f]);
  return (
    <main className={styles['page']}>
      <h1 className={styles['title']}>{t('join.title')}</h1>
      {state === 'loading' && <p role="status">{t('common.loading')}</p>}
      {state === 'invalid' && <p role="alert">{t('join.invalid')}</p>}
      {state === 'ready' && (
        <>
          <p>{t('join.lead')}</p>
          {/* A full navigation: the BFF starts the staff sign-in and claims the invitation. */}
          <a className={styles['primary']} href="/auth/login">
            {t('join.continue')}
          </a>
        </>
      )}
    </main>
  );
}
