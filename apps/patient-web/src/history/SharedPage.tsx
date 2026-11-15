import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import { TrialCards } from './HistoryPage.tsx';
import { tokenFrom, viewShared, type Summary } from './history.ts';

/**
 * A shared summary (REQ-008), for someone she gave a link to. The token is read from the
 * fragment and removed from the address bar at once; it is kept in memory only.
 */
export function SharedPage() {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [state, setState] = useState<Summary | 'loading' | 'invalid' | 'error'>('loading');
  useEffect(() => {
    const token = tokenFrom(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState('invalid');
      return;
    }
    void viewShared(f, token).then(setState);
  }, [f]);
  return (
    <main className={page['page']}>
      <h1 className={page['title']}>{t('shared.title')}</h1>
      {state === 'loading' && <p role="status">{t('common.loading')}</p>}
      {state === 'invalid' && <p role="alert">{t('shared.invalid')}</p>}
      {state === 'error' && <p role="alert">{t('common.try-later')}</p>}
      {typeof state === 'object' && (
        <>
          {state.expires_at && (
            <p className={page['muted']}>
              {t('shared.until', { date: state.expires_at.slice(0, 10) })}
            </p>
          )}
          <TrialCards summary={state} />
        </>
      )}
    </main>
  );
}
