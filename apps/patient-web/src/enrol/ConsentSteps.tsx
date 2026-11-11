import { useState } from 'react';
import { t } from '../i18n.ts';
import { PURPOSES, answer, text, type Decisions } from './consent.ts';
import styles from './enrol.module.css';

/**
 * Spec 21.7 screen 2: one purpose per screen, a plain explanation, two equal buttons. Neither is
 * pre-selected or visually favoured: both use the same style and size.
 */
export function ConsentSteps({ onDone }: { onDone: (d: Decisions) => void }) {
  const [decisions, setDecisions] = useState<Decisions>({});
  const step = PURPOSES.findIndex((p) => !(p in decisions));
  const purpose = step < 0 ? undefined : PURPOSES.at(step);
  if (!purpose) return <p role="status">{t('consent.saving')}</p>;

  const choose = (status: 'granted' | 'declined') => {
    const r = answer(decisions, purpose, status, new Date());
    setDecisions(r.decisions);
    if (r.done) onDone(r.decisions);
  };

  return (
    <section aria-labelledby="consent-title">
      <p className={styles['muted']}>{t('consent.step', { n: String(step + 1) })}</p>
      <h2 id="consent-title" className={styles['subtitle']}>
        {t(text(purpose, 'title'))}
      </h2>
      <p>{t(text(purpose, 'text'))}</p>
      <div className={styles['pair']}>
        <button
          type="button"
          className={styles['choice']}
          onClick={() => {
            choose('granted');
          }}
        >
          {t(text(purpose, 'grant'))}
        </button>
        <button
          type="button"
          className={styles['choice']}
          onClick={() => {
            choose('declined');
          }}
        >
          {t(text(purpose, 'decline'))}
        </button>
      </div>
    </section>
  );
}
