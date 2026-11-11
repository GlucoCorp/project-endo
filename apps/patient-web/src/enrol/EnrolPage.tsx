import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.ts';
import { EnrolmentFlow, takeToken, type View } from './flow.ts';
import styles from './enrol.module.css';

const POLL_MS = 4_000;

/**
 * Welcome and enrolment (spec 21.7 screen 1; ADR-0021 sections 3 and 4). One thing per screen:
 * an explanation and Start; then the code to show the clinic, updating by itself; then the next
 * step once the clinic has confirmed.
 */
export function EnrolPage() {
  const flow = useRef(
    new EnrolmentFlow({
      fetch: window.fetch.bind(window),
      storage: window.sessionStorage,
      locks: 'locks' in navigator ? navigator.locks : undefined,
    }),
  ).current;
  // Read once, before anything else renders: the token leaves the address bar immediately.
  const [token] = useState(() => takeToken(window.location, window.history));
  const [view, setView] = useState<View>(token ? { kind: 'ready' } : { kind: 'busy' });
  const live = useRef(true);

  // Only update the view while the page is still mounted.
  const show = (v: View) => {
    if (live.current) setView(v);
  };

  useEffect(() => {
    live.current = true;
    if (!token) void flow.resume().then(show);
    return () => {
      live.current = false;
    };
  }, [flow, token]);

  // Opening another link in this tab changes only the fragment, which does not reload the page:
  // reload, so the new token is read (and removed from the address bar) like the first.
  useEffect(() => {
    const reload = () => {
      window.location.reload();
    };
    window.addEventListener('hashchange', reload);
    return () => {
      window.removeEventListener('hashchange', reload);
    };
  }, []);

  // While the clinic has not confirmed, ask again every few seconds.
  useEffect(() => {
    if (view.kind !== 'code' && view.kind !== 'signing-in') return undefined;
    const id = window.setInterval(() => {
      void flow.status().then(show);
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [flow, view.kind]);

  const act = (step: () => Promise<View>) => {
    setView({ kind: 'busy' });
    void step().then((v) => {
      // Continue: a full navigation to Keycloak, which returns her to this page.
      if (v.kind === 'navigate') window.location.assign(v.url);
      else show(v);
    });
  };

  return (
    <main className={styles['page']}>
      <h1 className={styles['title']}>{t('enrol.title')}</h1>
      <Body
        view={view}
        onStart={() => {
          if (token) act(() => flow.start(token));
        }}
        onStop={() => {
          act(() => flow.cancel());
        }}
        onContinue={() => {
          act(() => flow.continue());
        }}
      />
    </main>
  );
}

function Body({
  view,
  onStart,
  onStop,
  onContinue,
}: {
  view: View;
  onStart: () => void;
  onStop: () => void;
  onContinue: () => void;
}) {
  switch (view.kind) {
    case 'busy':
      return <p role="status">{t('common.loading')}</p>;
    case 'no-link':
      return <p>{t('enrol.no-link')}</p>;
    case 'ready':
      return (
        <>
          <p className={styles['lead']}>{t('enrol.intro')}</p>
          <p>{t('enrol.before-start')}</p>
          <button type="button" className={styles['primary']} onClick={onStart}>
            {t('enrol.start')}
          </button>
        </>
      );
    case 'code':
      return (
        <>
          {view.code ? (
            <>
              <h2 className={styles['subtitle']}>{t('enrol.code-title')}</h2>
              <p className={styles['code']} aria-label={t('enrol.code-label')}>
                {view.code}
              </p>
              <p>{t('enrol.code-help')}</p>
            </>
          ) : (
            <p>{t('enrol.code-lost')}</p>
          )}
          <p role="status" aria-live="polite" className={styles['muted']}>
            {t('enrol.waiting')}
          </p>
          <button type="button" className={styles['quiet']} onClick={onStop}>
            {t('enrol.stop')}
          </button>
        </>
      );
    case 'confirmed':
      return (
        <>
          <p role="status" aria-live="polite">
            {t('enrol.confirmed')}
          </p>
          <button type="button" className={styles['primary']} onClick={onContinue}>
            {t('enrol.create-sign-in')}
          </button>
        </>
      );
    case 'signing-in':
      return (
        <p role="status" aria-live="polite">
          {t('enrol.signing-in')}
        </p>
      );
    case 'signed-in':
      return (
        <p role="status" aria-live="polite">
          {t('enrol.signed-in')}
        </p>
      );
    case 'navigate':
      return <p role="status">{t('common.loading')}</p>;
    case 'ended':
    case 'error':
      return (
        <p role="alert" className={view.kind === 'error' ? styles['error'] : undefined}>
          {t(view.message)}
        </p>
      );
  }
}
