import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import { SIGN_IN_PATH } from '../home/session.ts';
import {
  cancelDeletion,
  deletionStatus,
  exportRecord,
  requestDeletion,
  type Deletion,
} from './data.ts';

function Reauth() {
  return (
    <p role="alert">
      {t('common.reauth')}{' '}
      <a className={page['primary']} href={SIGN_IN_PATH}>
        {t('common.sign-in-again')}
      </a>
    </p>
  );
}

/** Saves the file through a temporary link; the object URL is released at once. */
function save(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'my-endo-record.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Her data rights (REQ-009; spec 13.4): download her record, delete her account. */
export function DataPage() {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [deletion, setDeletion] = useState<Deletion | null | 'error'>(null);
  const [exported, setExported] = useState<'done' | 'reauth' | 'error' | null>(null);
  const [message, setMessage] = useState<'reauth' | 'error' | 'kept' | null>(null);
  const [understood, setUnderstood] = useState(false);
  useEffect(() => {
    void deletionStatus(f).then((d) => {
      setDeletion(d ?? 'error');
    });
  }, [f]);
  const scheduled = typeof deletion === 'object' && deletion?.status === 'scheduled';

  return (
    <main className={page['page']}>
      <p>
        <a href="/">{t('history.home')}</a>
      </p>
      <h1 className={page['title']}>{t('data.title')}</h1>

      <section aria-labelledby="export-title">
        <h2 id="export-title" className={page['subtitle']}>
          {t('data.export-title')}
        </h2>
        <p className={page['muted']}>{t('data.export-what')}</p>
        <button
          type="button"
          className={page['primary']}
          onClick={() => {
            void exportRecord(f).then((r) => {
              if (r instanceof Blob) {
                save(r);
                setExported('done');
              } else setExported(r);
            });
          }}
        >
          {t('data.export')}
        </button>
        {exported === 'done' && <p role="status">{t('data.exported')}</p>}
        {exported === 'reauth' && <Reauth />}
        {exported === 'error' && (
          <p role="alert" className={page['error']}>
            {t('common.try-later')}
          </p>
        )}
      </section>

      <section aria-labelledby="delete-title">
        <h2 id="delete-title" className={page['subtitle']}>
          {t('data.delete-title')}
        </h2>
        {deletion === null && <p role="status">{t('common.loading')}</p>}
        {deletion === 'error' && (
          <p role="alert" className={page['error']}>
            {t('common.try-later')}
          </p>
        )}
        {scheduled && (
          <>
            <p role="status">
              {t('data.delete-scheduled', { date: deletion.due_at.slice(0, 10) })}
            </p>
            <button
              type="button"
              className={page['primary']}
              onClick={() => {
                void cancelDeletion(f).then((r) => {
                  if (r === 'error') setMessage('error');
                  else {
                    setDeletion(r);
                    setMessage('kept');
                    setUnderstood(false);
                  }
                });
              }}
            >
              {t('data.delete-keep')}
            </button>
          </>
        )}
        {typeof deletion === 'object' && deletion !== null && !scheduled && (
          <>
            <p>{t('data.delete-what')}</p>
            <label className={page['label']}>
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => {
                  setUnderstood(e.target.checked);
                }}
              />{' '}
              {t('data.delete-confirm')}
            </label>
            <button
              type="button"
              className={page['quiet']}
              disabled={!understood}
              onClick={() => {
                void requestDeletion(f).then((r) => {
                  if (r === 'reauth' || r === 'error') setMessage(r);
                  else {
                    setDeletion(r);
                    setMessage(null);
                  }
                });
              }}
            >
              {t('data.delete')}
            </button>
          </>
        )}
        {message === 'kept' && <p role="status">{t('data.delete-kept')}</p>}
        {message === 'reauth' && <Reauth />}
        {message === 'error' && (
          <p role="alert" className={page['error']}>
            {t('common.try-later')}
          </p>
        )}
      </section>
    </main>
  );
}
