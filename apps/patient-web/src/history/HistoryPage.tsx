import { useEffect, useMemo, useRef, useState } from 'react';
import { TrialStrip, stripModel } from '@endo/ui/trial-strip';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import styles from '../checkin/checkin.module.css';
import {
  accessLog,
  createShareLink,
  history,
  shareLinks,
  stopSharing,
  type AccessEvent,
  type LinkRow,
  type Summary,
  type TreatmentCard,
} from './history.ts';

/** One Trial Card, collapsed by default, expanding to its strip (spec 21.6, 21.7 screen 7). */
export function TrialCards(props: { readonly summary: Summary }) {
  return (
    <>
      {props.summary.treatments.length === 0 && <p>{t('history.empty')}</p>}
      {props.summary.treatments.map((c: TreatmentCard) => (
        <details key={c.id} className={styles['card']} open={props.summary.treatments.length === 1}>
          <summary className={styles['cardTitle']}>
            {c.treatment.display ?? c.treatment.code}, {c.dose_text} · {c.start_date} –{' '}
            {c.review_date}
          </summary>
          {c.goal && <p className={styles['goal']}>“{c.goal}”</p>}
          {c.decision && (
            <p>{t('history.decision', { decision: c.decision.replace(/_/g, ' ') })}</p>
          )}
          <TrialStrip
            model={stripModel(c.review_interval_weeks, c.weeks)}
            title={t('history.strip', { start: c.start_date, review: c.review_date })}
          />
        </details>
      ))}
    </>
  );
}

/** Her history, sharing and access log (REQ-008; spec 13.3). Print makes a PDF on her device. */
export function HistoryPage() {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [summary, setSummary] = useState<Summary | null | 'error'>(null);
  const [links, setLinks] = useState<readonly LinkRow[]>([]);
  const [log, setLog] = useState<readonly AccessEvent[] | null>(null);
  const [days, setDays] = useState(7);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | 'error' | null>(null);
  const key = useRef(crypto.randomUUID());

  const loadLinks = () => {
    void shareLinks(f).then((l) => {
      setLinks(l ?? []);
    });
  };
  useEffect(() => {
    void history(f).then((s) => {
      setSummary(s ?? 'error');
    });
    loadLinks();
    void accessLog(f).then(setLog);
  }, []);

  return (
    <main className={page['page']}>
      <h1 className={page['title']}>{t('history.title')}</h1>
      <p>
        <a href="/">{t('history.home')}</a>{' '}
        <button
          type="button"
          className={page['quiet']}
          onClick={() => {
            window.print();
          }}
        >
          {t('history.print')}
        </button>
      </p>
      {summary === null && <p role="status">{t('common.loading')}</p>}
      {summary === 'error' && (
        <p role="alert" className={page['error']}>
          {t('common.try-later')}
        </p>
      )}
      {summary && summary !== 'error' && <TrialCards summary={summary} />}

      <section aria-labelledby="share-title">
        <h2 id="share-title" className={page['subtitle']}>
          {t('history.share-title')}
        </h2>
        <p className={page['muted']}>{t('history.share-what')}</p>
        <label className={page['label']}>
          {t('history.share-days')}
          <select
            className={page['input']}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
            }}
          >
            {[1, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {t('history.days', { days: String(d) })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={page['primary']}
          onClick={() => {
            void createShareLink(f, days, key.current, window.location.origin).then((r) => {
              key.current = crypto.randomUUID();
              setMade(r === 'already' ? 'error' : r);
              loadLinks();
            });
          }}
        >
          {t('history.share-create')}
        </button>
        {made === 'error' && (
          <p role="alert" className={page['error']}>
            {t('common.try-later')}
          </p>
        )}
        {made && made !== 'error' && (
          <div role="status">
            <p>{t('history.share-made', { date: made.expiresAt.slice(0, 10) })}</p>
            <input
              className={page['input']}
              readOnly
              value={made.url}
              aria-label={t('history.share-link')}
            />
          </div>
        )}
        <ul>
          {links
            .filter((l) => l.active)
            .map((l) => (
              <li key={l.id}>
                {t('history.share-active', { date: l.expires_at.slice(0, 10) })}{' '}
                <button
                  type="button"
                  className={page['quiet']}
                  onClick={() => {
                    void stopSharing(f, l.id).then(loadLinks);
                  }}
                >
                  {t('history.share-stop')}
                </button>
              </li>
            ))}
        </ul>
      </section>

      <section aria-labelledby="log-title">
        <h2 id="log-title" className={page['subtitle']}>
          {t('history.log-title')}
        </h2>
        {log === null ? (
          <p role="status">{t('common.loading')}</p>
        ) : log.length === 0 ? (
          <p>{t('history.log-empty')}</p>
        ) : (
          <ul>
            {log.map((e) => (
              <li key={`${e.at}-${e.action}`}>
                {t('history.log-row', {
                  date: e.at.slice(0, 16).replace('T', ' '),
                  who: e.role === 'anonymous' ? t('history.log-link') : e.role.replace(/_/g, ' '),
                  what: e.action.replace(/[._]/g, ' '),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
