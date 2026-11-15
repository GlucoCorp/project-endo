import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { t } from '../i18n.ts';
import styles from './portal.module.css';
import { Drafting, type Catalogue, type EpisodeSummary, type SharingPatient } from './drafting.ts';
import type { Portal } from './portal.ts';

const short = (id: string) => id.slice(-6);
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Start a treatment trial (REQ-002): choose a patient who shares with the care team, a treatment
 * from the catalogue, the dose, the start date and the review interval. It stays a draft until she
 * confirms it with her goal in her app.
 */
export function DraftEpisode({ portal }: { portal: Portal }) {
  const drafting = useRef(
    new Drafting(window.fetch.bind(window), () => portal.csrfToken()),
  ).current;
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [patients, setPatients] = useState<readonly SharingPatient[] | null>(null);
  const [patient, setPatient] = useState('');
  const [treatment, setTreatment] = useState('');
  const [dose, setDose] = useState('');
  const [start, setStart] = useState(todayIso());
  const [weeks, setWeeks] = useState(12);
  const [episodes, setEpisodes] = useState<readonly EpisodeSummary[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    void drafting.catalogue().then(setCatalogue);
    void drafting.patients().then(setPatients);
  }, [drafting]);
  useEffect(() => {
    if (patient)
      void drafting.episodes(patient).then((e) => {
        setEpisodes(e ?? []);
      });
    else setEpisodes([]);
  }, [patient, drafting]);

  const chosen = catalogue?.treatments.find((x) => `${x.system}|${x.code}` === treatment);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!patient || !chosen || busy) return;
    setBusy(true);
    void drafting
      .draft(
        patient,
        {
          treatment: { system: chosen.system, code: chosen.code },
          dose_text: dose,
          start_date: start,
          review_interval_weeks: weeks,
        },
        key.current,
      )
      .then((r) => {
        setBusy(false);
        if (r.kind === 'drafted') {
          key.current = crypto.randomUUID();
          setDose('');
          setMessage({ ok: true, text: t('clinic.draft-done') });
          void drafting.episodes(patient).then((x) => {
            setEpisodes(x ?? []);
          });
        } else
          setMessage({
            ok: false,
            text: r.kind === 'error' ? t('common.try-later') : t('clinic.draft-refused'),
          });
      });
  };

  return (
    <section aria-labelledby="draft-title">
      <h2 id="draft-title" className={styles['subtitle']}>
        {t('clinic.draft-title')}
      </h2>
      {catalogue?.draft && <p className={styles['muted']}>{t('clinic.draft-placeholder')}</p>}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={styles['result']}>
          {message.text}
        </p>
      )}
      {patients !== null && patients.length === 0 && <p>{t('clinic.no-patients')}</p>}
      {patients !== null && patients.length > 0 && (
        <form onSubmit={submit} className={styles['form']}>
          <label className={styles['field']}>
            {t('clinic.patient')}
            <select
              value={patient}
              onChange={(e) => {
                setPatient(e.target.value);
                setMessage(null);
              }}
            >
              <option value="">{t('clinic.choose')}</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('clinic.patient-option', {
                    id: short(p.id),
                    date: p.enrolled_at.slice(0, 10),
                  })}
                </option>
              ))}
            </select>
          </label>
          <label className={styles['field']}>
            {t('clinic.treatment')}
            <select
              value={treatment}
              onChange={(e) => {
                setTreatment(e.target.value);
              }}
            >
              <option value="">{t('clinic.choose')}</option>
              {catalogue?.treatments.map((x) => (
                <option key={`${x.system}|${x.code}`} value={`${x.system}|${x.code}`}>
                  {x.display}
                </option>
              ))}
            </select>
          </label>
          <label className={styles['field']}>
            {t('clinic.dose')}
            <input
              maxLength={120}
              value={dose}
              onChange={(e) => {
                setDose(e.target.value);
              }}
            />
          </label>
          <label className={styles['field']}>
            {t('clinic.start-date')}
            <input
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
              }}
            />
          </label>
          <label className={styles['field']}>
            {t('clinic.review-weeks')}
            <input
              type="number"
              min={4}
              max={26}
              value={weeks}
              onChange={(e) => {
                setWeeks(Number(e.target.value));
              }}
            />
          </label>
          <button
            type="submit"
            className={styles['primary']}
            disabled={!patient || !chosen || dose.trim() === '' || busy}
          >
            {t('clinic.draft-submit')}
          </button>
        </form>
      )}
      {episodes.length > 0 && (
        <ul className={styles['list']}>
          {episodes.map((e) => (
            <li key={e.id} className={styles['invitation']}>
              {t('clinic.episode-line', {
                treatment: e.treatment.display ?? e.treatment.code,
                dose: e.dose_text,
                status: e.status,
                review: e.review_date,
              })}
              {e.red_flags.length > 0 && (
                <strong> {t('clinic.red-flags', { count: String(e.red_flags.length) })}</strong>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
