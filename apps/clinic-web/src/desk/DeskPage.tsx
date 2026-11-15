import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { TrialStrip, stripModel } from '@endo/ui/trial-strip';
import { t } from '../i18n.ts';
import { Portal } from '../portal/portal.ts';
import { Drafting, type Catalogue } from '../portal/drafting.ts';
import styles from './desk.module.css';
import {
  DECISIONS,
  Desk,
  PROCEDURES,
  decisionKey,
  filterQueue,
  queueKey,
  type Decision,
  type QueueFilter,
  type QueueRow,
  type Review,
} from './desk.ts';

const today = () => new Date().toISOString().slice(0, 10);
const words = (s: string) => s.replace(/_/g, ' ');

/** The clinician desk (spec 21.8): review queue, review, decision, pre-surgery check, print. */
export function DeskPage() {
  const portal = useRef(new Portal(window.fetch.bind(window))).current;
  const desk = useMemo(
    () => new Desk(window.fetch.bind(window), () => portal.csrfToken()),
    [portal],
  );
  const [ready, setReady] = useState<'loading' | 'active' | 'choose-org' | 'signed-out'>('loading');
  const [rows, setRows] = useState<readonly QueueRow[] | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<QueueRow | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void portal.session().then((s) => {
      setReady(s.kind === 'active' || s.kind === 'choose-org' ? s.kind : 'signed-out');
      if (s.kind === 'active') void desk.queue().then(setRows);
    });
  }, [portal, desk]);

  const shown = rows ? filterQueue(rows, filter, today(), search) : [];
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === '/') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    const r = queueKey(e.key, index, shown.length);
    if (r === 'open') setOpen(shown.at(index) ?? null);
    else if (r !== null) setIndex(r);
  };

  if (ready === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (ready === 'signed-out')
    return (
      <main className={styles['page']}>
        <a href="/">{t('clinic.sign-in')}</a>
      </main>
    );
  if (ready === 'choose-org')
    return (
      <main className={styles['page']}>
        <a href="/">{t('clinic.choose-org')}</a>
      </main>
    );
  if (open)
    return (
      <ReviewView
        desk={desk}
        row={open}
        csrf={() => portal.csrfToken()}
        onClose={() => {
          setOpen(null);
          void desk.queue().then(setRows);
        }}
      />
    );
  return (
    <main className={styles['page']} onKeyDown={onKey}>
      <h1 className={styles['title']}>{t('desk.queue-title')}</h1>
      <p className={styles['muted']}>{t('desk.shadow')}</p>
      <div className={styles['filters']} role="group" aria-label={t('desk.filters')}>
        {(['all', 'this_week', 'overdue'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f);
            }}
          >
            {t(`desk.filter-${f}`)}
          </button>
        ))}
        <input
          ref={searchRef}
          type="search"
          aria-label={t('desk.search')}
          placeholder={t('desk.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
      </div>
      {rows === null ? (
        <p role="status">{t('common.loading')}</p>
      ) : shown.length === 0 ? (
        <p>{t('desk.queue-empty')}</p>
      ) : (
        <ol className={styles['queue']} tabIndex={0} aria-label={t('desk.queue-title')}>
          {shown.map((r, i) => (
            <li
              key={r.episode_id}
              className={`${styles['row'] ?? ''} ${r.red_flags > 0 ? (styles['flagged'] ?? '') : ''}`}
              aria-current={i === index}
            >
              <button
                type="button"
                className={styles['rowButton']}
                onClick={() => {
                  setIndex(i);
                  setOpen(r);
                }}
              >
                <span>{t('desk.row-patient', { id: r.patient_id.slice(-6) })}</span>
                <span>{r.treatment.display ?? r.treatment.code}</span>
                <span>{t('desk.row-week', { week: String(r.week) })}</span>
                <span>
                  {r.overdue
                    ? t('desk.overdue', { date: r.review_date })
                    : t('desk.due', { date: r.review_date })}
                </span>
                {r.red_flags > 0 && (
                  <strong className={styles['critical']}>
                    {t('clinic.red-flags', { count: String(r.red_flags) })}
                  </strong>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className={styles['muted']}>{t('desk.keys')}</p>
    </main>
  );
}

function ReviewView(props: { desk: Desk; row: QueueRow; csrf: () => string; onClose: () => void }) {
  const { desk, row } = props;
  const [review, setReview] = useState<Review | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [treatment, setTreatment] = useState('');
  const [dose, setDose] = useState('');
  const [start, setStart] = useState(row.review_date);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Keyboard users land in the review (1-5, Ctrl+Enter, Escape work at once).
    if (review) mainRef.current?.focus();
  }, [review]);

  useEffect(() => {
    void desk.review(row.patient_id, row.episode_id).then(setReview);
    void new Drafting(window.fetch.bind(window), props.csrf).catalogue().then(setCatalogue);
  }, [desk, row, props.csrf]);

  const chosen = catalogue?.treatments.find((x) => `${x.system}|${x.code}` === treatment);
  const needsTreatment = decision === 'switch' || decision === 'add';
  const record = () => {
    if (!decision || (needsTreatment && (!chosen || !dose.trim()))) return;
    const choice = chosen
      ? {
          treatment: { system: chosen.system, code: chosen.code },
          dose_text: dose.trim(),
          start_date: start,
          review_interval_weeks: 12,
        }
      : undefined;
    void desk
      .decide(
        row.patient_id,
        row.episode_id,
        decision,
        note,
        choice ? { next: choice, added: choice } : {},
        key.current,
      )
      .then((r) => {
        setMessage(
          r.kind === 'ok'
            ? { ok: true, text: t('desk.recorded') }
            : {
                ok: false,
                text:
                  r.kind === 'refused' && r.code === 'review.not_open'
                    ? t('desk.not-open')
                    : t('common.try-later'),
              },
        );
      });
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      record();
      return;
    }
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    )
      return;
    const d = decisionKey(e.key);
    if (d) setDecision(d);
    if (e.key === 'Escape') props.onClose();
  };

  if (!review) return <p role="status">{t('common.loading')}</p>;
  const ep = review.episode;
  const model = stripModel(ep.review_interval_weeks, review.weeks);
  return (
    <main ref={mainRef} tabIndex={-1} className={styles['review']} onKeyDown={onKey}>
      <nav className={styles['noprint']}>
        <button type="button" onClick={props.onClose}>
          {t('desk.back')}
        </button>
        <button
          type="button"
          onClick={() => {
            window.print();
          }}
        >
          {t('desk.print')}
        </button>
      </nav>
      <section className={styles['left']} aria-label={t('desk.history')}>
        <h2>{t('desk.history')}</h2>
        {review.history.length === 0 && <p className={styles['muted']}>{t('desk.no-history')}</p>}
        <ul>
          {review.history.map((h) => (
            <li key={h.id}>
              {t('clinic.episode-line', {
                treatment: h.treatment.display ?? h.treatment.code,
                dose: h.dose_text,
                status: h.status,
                review: h.review_date,
              })}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles['centre']} aria-label={t('desk.evidence')}>
        <h1 className={styles['title']}>
          {ep.treatment.display ?? ep.treatment.code}, {ep.dose_text}
        </h1>
        {ep.goal && <p className={styles['goal']}>“{ep.goal}”</p>}
        <p className={styles['muted']}>{t('desk.shadow')}</p>
        {review.red_flags.length > 0 && (
          <p className={styles['critical']} role="alert">
            {t('clinic.red-flags', { count: String(review.red_flags.length) })}
          </p>
        )}
        <TrialStrip
          model={model}
          title={t('desk.strip', { start: ep.start_date, review: ep.review_date })}
        />
        {review.decisions.length > 0 && (
          <ul>
            {review.decisions.map((d) => (
              <li key={d.decided_at}>
                {words(d.decision)}: {d.note ?? ''}
              </li>
            ))}
          </ul>
        )}
        <p className={styles['printonly']}>{t('desk.signature')}</p>
      </section>
      <section
        className={`${styles['right'] ?? ''} ${styles['noprint'] ?? ''}`}
        aria-label={t('desk.decision')}
      >
        <h2>{t('desk.decision')}</h2>
        <p className={styles['muted']}>{t('desk.guideline-pending')}</p>
        <fieldset>
          <legend>{t('desk.decision')}</legend>
          {DECISIONS.map((d, i) => (
            <label key={d} className={styles['option']}>
              <input
                type="radio"
                name="decision"
                checked={decision === d}
                onChange={() => {
                  setDecision(d);
                }}
              />
              {String(i + 1)}. {t(`desk.decision-${d}`)}
            </label>
          ))}
        </fieldset>
        {needsTreatment && (
          <>
            <label>
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
            <label>
              {t('clinic.dose')}
              <input
                maxLength={120}
                value={dose}
                onChange={(e) => {
                  setDose(e.target.value);
                }}
              />
            </label>
            <label>
              {t('clinic.start-date')}
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                }}
              />
            </label>
          </>
        )}
        <label>
          {t('desk.note')}
          <textarea
            maxLength={2000}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </label>
        <button type="button" className={styles['primary']} disabled={!decision} onClick={record}>
          {t('desk.record')}
        </button>
        {message && <p role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        <SurgeryCheck desk={desk} patientId={row.patient_id} />
      </section>
    </main>
  );
}

interface Snapshot {
  readonly treatments: readonly {
    readonly treatment: { readonly code: string; readonly display: string | null };
    readonly start_date: string;
    readonly weeks_planned: number;
    readonly check_ins: number;
    readonly adherence: number | null;
    readonly decision: string | null;
  }[];
}

function SurgeryCheck(props: { desk: Desk; patientId: string }) {
  const [procedure, setProcedure] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [discussed, setDiscussed] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const key = useRef(crypto.randomUUID());
  return (
    <section aria-label={t('desk.surgery')}>
      <h2>{t('desk.surgery')}</h2>
      <label>
        {t('desk.procedure')}
        <select
          value={procedure}
          onChange={(e) => {
            setProcedure(e.target.value);
            setSnapshot(null);
            setDiscussed(false);
            setSaved(null);
            if (e.target.value)
              void props.desk
                .surgeryPreview(props.patientId, e.target.value, crypto.randomUUID())
                .then((r) => {
                  if (r.kind === 'ok') setSnapshot(r.body as Snapshot);
                });
          }}
        >
          <option value="">{t('clinic.choose')}</option>
          {PROCEDURES.map((p) => (
            <option key={p} value={p}>
              {words(p)}
            </option>
          ))}
        </select>
      </label>
      {snapshot && (
        <>
          <ul className={styles['checklist']}>
            {snapshot.treatments.map((x) => (
              <li key={`${x.treatment.code}-${x.start_date}`}>
                {t('desk.tried', {
                  treatment: x.treatment.display ?? x.treatment.code,
                  weeks: String(x.check_ins),
                  planned: String(x.weeks_planned),
                  adherence:
                    x.adherence === null ? '—' : `${String(Math.round(x.adherence * 100))}%`,
                })}
              </li>
            ))}
          </ul>
          <p className={styles['muted']}>{t('desk.surgery-pending')}</p>
          <label className={styles['option']}>
            <input
              type="checkbox"
              checked={discussed}
              onChange={(e) => {
                setDiscussed(e.target.checked);
              }}
            />
            {t('desk.discussed')}
          </label>
          <button
            type="button"
            disabled={!discussed}
            onClick={() => {
              void props.desk.surgeryRecord(props.patientId, procedure, key.current).then((r) => {
                setSaved(r.kind === 'ok');
              });
            }}
          >
            {t('desk.save-check')}
          </button>
          {saved !== null && (
            <p role={saved ? 'status' : 'alert'}>
              {saved ? t('desk.check-saved') : t('common.try-later')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
