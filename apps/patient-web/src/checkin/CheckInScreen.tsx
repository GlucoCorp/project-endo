import { useRef, useState, type SyntheticEvent } from 'react';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import styles from './checkin.module.css';
import type { CheckInContent, EpisodeView } from './api.ts';
import {
  answered,
  nextStep,
  previousStep,
  progress,
  toSubmission,
  toggle,
  type AnswerKey,
  type AnswerValue,
  type Answers,
  type Step,
} from './flow.ts';
import type { OfflineQueue } from './queue.ts';
import { reportRedFlags, submitWeek, type WeekOutcome } from './submit.ts';
import { UrgentScreen } from './UrgentScreen.tsx';

/** Option codes as words while the wording is a draft (approved wording replaces this). */
const words = (code: string) => code.replace(/_/g, ' ');

/**
 * The weekly check-in (spec 6, 21.7 screen 5): one question per screen, "3 of 8", red flags first
 * and never skippable. Reporting a red flag shows the urgent screen at once and sends the flags
 * on their own (or queues them offline) before anything else.
 */
export function CheckInScreen(props: {
  readonly episode: EpisodeView;
  readonly content: CheckInContent;
  readonly weekIndex: number;
  readonly queue: OfflineQueue;
  readonly emergencyNumber: string | null;
  readonly onDone: (outcome: WeekOutcome | null) => void;
}) {
  const { episode, content, weekIndex, queue } = props;
  const fetchFn = window.fetch.bind(window);
  const key = useRef(crypto.randomUUID());
  const [step, setStep] = useState<Step>('red_flags');
  const [answers, setAnswers] = useState<Answers>(new Map());
  const [urgent, setUrgent] = useState<{ shownAt: Date; crisis: boolean } | null>(null);
  const [shownAt, setShownAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: AnswerKey, v: AnswerValue) => {
    setAnswers((a) => new Map(a).set(k, v));
  };
  const list = (k: AnswerKey) => {
    const v = answers.get(k);
    return Array.isArray(v) ? (v as readonly string[]) : undefined;
  };

  const forward = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!answered(step, answers)) return;
    if (step === 'red_flags') {
      const flags = list('red_flags') ?? [];
      if (flags.length > 0 && !urgent && !shownAt) {
        // Urgent screen first, before any network call (REQ-007).
        const at = new Date();
        setShownAt(at);
        setUrgent({
          shownAt: at,
          crisis: content.red_flags.some((f) => flags.includes(f.id) && f.routes_to !== null),
        });
        void reportRedFlags(fetchFn, queue, episode.id, key.current, flags, at, null);
        return;
      }
    }
    if (step === 'review') {
      setBusy(true);
      void submitWeek(
        fetchFn,
        queue,
        episode.id,
        key.current,
        weekIndex,
        toSubmission(content, weekIndex, answers),
        shownAt,
      ).then((r) => {
        setBusy(false);
        props.onDone(r);
      });
      return;
    }
    setStep(nextStep(content, weekIndex, answers, step));
  };
  const back = () => {
    const p = previousStep(content, weekIndex, answers, step);
    if (p) setStep(p);
    else props.onDone(null);
  };

  if (urgent)
    return (
      <UrgentScreen
        emergencyNumber={props.emergencyNumber}
        crisis={urgent.crisis}
        onAcknowledge={() => {
          // The acknowledgement goes with the flags under the same key (the server keeps one).
          void reportRedFlags(
            fetchFn,
            queue,
            episode.id,
            key.current,
            list('red_flags') ?? [],
            urgent.shownAt,
            new Date(),
          );
          setUrgent(null);
          setStep('Q1');
        }}
      />
    );

  const p = progress(content, weekIndex, answers, step);
  const texts = new Map(Object.entries(content.text));
  const text = (id: string) => texts.get(id) ?? id;
  const multi = (
    k: 'Q5' | 'Q8' | 'red_flags',
    options: readonly { id: string; label: string }[],
    none: string | null,
  ) => (
    // Once reported, red flags are fixed for this check-in: they were sent under its key.
    <fieldset className={styles['options']} disabled={k === 'red_flags' && shownAt !== null}>
      {options.map((o) => (
        <label key={o.id} className={styles['option']}>
          <input
            type="checkbox"
            checked={(list(k) ?? []).includes(o.id)}
            onChange={() => {
              set(k, toggle(list(k), o.id, none));
            }}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
  const single = (k: 'Q2' | 'Q3' | 'Q6' | 'Q7', options: readonly string[]) => (
    <fieldset className={styles['options']}>
      {options.map((o) => (
        <label key={o} className={styles['option']}>
          <input
            type="radio"
            name={k}
            checked={answers.get(k) === o}
            onChange={() => {
              set(k, o);
            }}
          />
          {words(o)}
        </label>
      ))}
    </fieldset>
  );
  const scale = (k: 'Q1' | 'Q7' | 'GIC', min: number, max: number, anchors: readonly string[]) => (
    <>
      <div
        className={styles['scale']}
        role="group"
        aria-labelledby="q-title"
        style={{ gridTemplateColumns: `repeat(${String(max - min + 1)}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <button
            key={n}
            type="button"
            className={styles['segment']}
            aria-pressed={answers.get(k) === n}
            onClick={() => {
              set(k, n);
            }}
          >
            {n}
          </button>
        ))}
      </div>
      <div className={styles['anchors']}>
        {anchors.map((a) => (
          <span key={a}>{a}</span>
        ))}
      </div>
      {typeof answers.get(k) === 'number' && (
        <p className={styles['value']}>{String(answers.get(k))}</p>
      )}
    </>
  );

  const goal = episode.goal?.text ?? '';
  return (
    <form onSubmit={forward}>
      {content.draft && <p className={styles['draft']}>{t('checkin.draft')}</p>}
      {step !== 'review' && (
        <p className={styles['progress']}>
          {t('checkin.progress', { index: String(p.index), total: String(p.total) })}
        </p>
      )}
      {step === 'red_flags' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {t('checkin.red-flags-title')}
          </h2>
          <p className={page['muted']}>{t('checkin.choose-all')}</p>
          {multi(
            'red_flags',
            content.red_flags.map((f) => ({ id: f.id, label: f.text })),
            null,
          )}
          {shownAt === null && (
            <button
              type="button"
              className={page['quiet']}
              onClick={() => {
                set('red_flags', []);
                setStep('Q1');
              }}
            >
              {t('checkin.red-flags-none')}
            </button>
          )}
        </>
      )}
      {step === 'Q1' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q1')}
          </h2>
          {scale('Q1', 0, 10, ['0', '5', '10'])}
        </>
      )}
      {step === 'Q2' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q2')}
          </h2>
          {single('Q2', content.options.Q2)}
        </>
      )}
      {step === 'Q3' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q3').replace('{goal}', goal)}
          </h2>
          {single('Q3', content.options.Q3)}
        </>
      )}
      {step === 'Q5' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q5')}
          </h2>
          <p className={page['muted']}>{t('checkin.choose-all')}</p>
          {multi(
            'Q5',
            content.options.Q5.map((o) => ({ id: o, label: words(o) })),
            null,
          )}
          {(list('Q5') ?? []).length === 0 && (
            <button
              type="button"
              className={page['quiet']}
              onClick={() => {
                set('Q5', []);
                setStep(nextStep(content, weekIndex, new Map(answers).set('Q5', []), 'Q5'));
              }}
            >
              {t('checkin.none')}
            </button>
          )}
        </>
      )}
      {step === 'Q6' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q6')}
          </h2>
          {single('Q6', content.options.Q6)}
        </>
      )}
      {step === 'Q7' &&
        (episode.adherence_mode === 'daily' ? (
          <>
            <h2 id="q-title" className={styles['question']}>
              {text('Q7')}
            </h2>
            {scale('Q7', 0, 7, ['0', '7'])}
          </>
        ) : (
          <>
            <h2 id="q-title" className={styles['question']}>
              {text('Q7_device_or_injection')}
            </h2>
            {single('Q7', ['yes', 'no'])}
          </>
        ))}
      {step === 'Q8' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('Q8')}
          </h2>
          <p className={page['muted']}>{t('checkin.choose-all')}</p>
          {multi(
            'Q8',
            content.options.Q8.map((o) => ({ id: o, label: words(o) })),
            'none',
          )}
        </>
      )}
      {step === 'GIC' && (
        <>
          <h2 id="q-title" className={styles['question']}>
            {text('GIC')}
          </h2>
          {scale('GIC', 1, 7, ['1', '7'])}
        </>
      )}
      {step === 'review' && <h2 className={styles['question']}>{t('checkin.review-title')}</h2>}
      <div className={styles['nav']}>
        <button type="button" className={page['quiet']} onClick={back}>
          {step === 'red_flags' ? t('checkin.cancel') : t('checkin.back')}
        </button>
        <button
          type="submit"
          className={page['primary']}
          disabled={busy || !answered(step, answers)}
        >
          {step === 'review' ? t('checkin.save') : t('checkin.next')}
        </button>
      </div>
    </form>
  );
}
