import { useRef, useState, type SyntheticEvent } from 'react';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import styles from './checkin.module.css';
import { deviceTimeZone, paths, send, type CheckInContent, type EpisodeView } from './api.ts';

/** Never a template code (codes start with a letter). */
const OWN = '__own';

/**
 * "Your goal" (spec 21.7 screen 3; REQ-002): suggested goals as large rows, plus "Write my own"
 * (up to 140 characters, stored encrypted). Confirming starts the treatment trial.
 */
export function GoalScreen(props: {
  readonly episode: EpisodeView;
  readonly content: CheckInContent;
  readonly onConfirmed: () => void;
}) {
  const fetchFn = window.fetch.bind(window);
  const key = useRef(crypto.randomUUID());
  const [choice, setChoice] = useState<string | null>(null);
  const [own, setOwn] = useState('');
  const [error, setError] = useState<'busy' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = choice === OWN ? own.trim().length > 0 : choice !== null;

  const confirm = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const goal = choice === OWN ? { text: own.trim() } : { template_code: choice };
    void send(fetchFn, paths.confirm(props.episode.id), key.current, {
      goal,
      time_zone: deviceTimeZone(),
    }).then((r) => {
      setBusy(false);
      if (r.kind === 'ok') props.onConfirmed();
      else setError(r.kind === 'refused' && r.code === 'episode.line_busy' ? 'busy' : 'failed');
    });
  };

  return (
    <form onSubmit={confirm}>
      <h2 className={page['subtitle']}>{t('goal.title')}</h2>
      <p className={page['muted']}>
        {t('goal.treatment', {
          treatment: props.episode.treatment.display ?? props.episode.treatment.code,
          dose: props.episode.dose_text,
          date: props.episode.start_date,
        })}
      </p>
      {props.content.draft && <p className={styles['draft']}>{t('checkin.draft')}</p>}
      {error && (
        <p role="alert" className={page['error']}>
          {t(error === 'busy' ? 'goal.busy' : 'common.try-later')}
        </p>
      )}
      <fieldset className={styles['options']}>
        {props.content.goals.map((g) => (
          <label key={g.code} className={styles['option']}>
            <input
              type="radio"
              name="goal"
              checked={choice === g.code}
              onChange={() => {
                setChoice(g.code);
              }}
            />
            {g.text}
          </label>
        ))}
        <label className={styles['option']}>
          <input
            type="radio"
            name="goal"
            checked={choice === OWN}
            onChange={() => {
              setChoice(OWN);
            }}
          />
          {t('goal.own')}
        </label>
      </fieldset>
      {choice === OWN && (
        <>
          <label className={page['label']} htmlFor="goal-own">
            {t('goal.own-label')}
          </label>
          <input
            id="goal-own"
            className={page['input']}
            maxLength={140}
            autoComplete="off"
            value={own}
            onChange={(e) => {
              setOwn(e.target.value);
            }}
          />
        </>
      )}
      <button type="submit" className={page['primary']} disabled={!ready || busy}>
        {t('goal.confirm')}
      </button>
    </form>
  );
}
