import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import { Drafting, type SharingPatient } from '../portal/drafting.ts';
import styles from './desk.module.css';
import { launchContext, launchHandle, linkLaunch, type LaunchContext } from './launch.ts';

/**
 * Opened from a record system (M7, spec 16.2): shows which patient the launch is for, filtering
 * the queue to her, or lets the clinician link the record to one of their patients once.
 */
export function LaunchPanel(props: {
  readonly csrf: () => string;
  readonly onPatient: (patientId: string) => void;
}) {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [handle] = useState(() => launchHandle(window.location.hash));
  const [ctx, setCtx] = useState<LaunchContext | null>(null);
  const [patients, setPatients] = useState<readonly SharingPatient[]>([]);
  const [chosen, setChosen] = useState('');
  const [message, setMessage] = useState<'exists' | 'error' | null>(null);
  const { onPatient, csrf } = props;

  useEffect(() => {
    if (!handle) return;
    window.history.replaceState(null, '', window.location.pathname);
    void launchContext(f, csrf(), handle).then((c) => {
      setCtx(c);
      if (typeof c === 'object' && c.linked) onPatient(c.patient_id);
      if (typeof c === 'object' && !c.linked)
        void new Drafting(f, csrf).patients().then((p) => {
          setPatients(p ?? []);
        });
    });
  }, [handle, f, csrf, onPatient]);

  if (!handle || ctx === null) return null;
  if (ctx === 'expired') return <p role="alert">{t('launch.expired')}</p>;
  if (ctx === 'error') return <p role="alert">{t('common.try-later')}</p>;
  if (ctx.linked)
    return (
      <p role="status" className={styles['muted']}>
        {t('launch.linked', { ref: ctx.patient_id.slice(-6) })}
      </p>
    );
  return (
    <section aria-labelledby="launch-title">
      <h2 id="launch-title">{t('launch.title')}</h2>
      <p>{t('launch.unlinked')}</p>
      <label className={styles['field']}>
        {t('launch.choose')}
        <select
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
          }}
        >
          <option value="">{t('clinic.choose')}</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {t('launch.patient', { ref: p.id.slice(-6), since: p.enrolled_at.slice(0, 10) })}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={styles['primary']}
        disabled={!chosen}
        onClick={() => {
          void linkLaunch(f, csrf(), handle, chosen).then((r) => {
            if (r === 'linked') {
              setCtx({ linked: true, patient_id: chosen });
              onPatient(chosen);
            } else setMessage(r === 'exists' ? 'exists' : 'error');
          });
        }}
      >
        {t('launch.link')}
      </button>
      {message === 'exists' && <p role="alert">{t('launch.exists')}</p>}
      {message === 'error' && <p role="alert">{t('common.try-later')}</p>}
    </section>
  );
}
