import { t } from '../i18n.ts';
import styles from './checkin.module.css';
import type { EpisodeView } from './api.ts';
import { daysUntil, today, weekOf } from './flow.ts';

/**
 * The Trial Card (spec 21.6): treatment and dose, her goal in her words in quotation marks, the
 * week she is in and the days to review. The full Trial Strip comes with her history (REQ-008).
 */
export function TrialCard(props: { readonly episode: EpisodeView }) {
  const e = props.episode;
  const now = today();
  return (
    <section className={styles['card']} aria-label={t('trial.goal')}>
      <p className={styles['cardTitle']}>
        {e.treatment.display ?? e.treatment.code}, {e.dose_text}
      </p>
      {e.goal?.text && <p className={styles['goal']}>“{e.goal.text}”</p>}
      <div className={styles['meta']}>
        <span>
          {t('trial.week', {
            week: String(weekOf(now, e.start_date, e.review_interval_weeks)),
            total: String(e.review_interval_weeks),
          })}
        </span>
        <span>{t('trial.review', { days: String(daysUntil(now, e.review_date)) })}</span>
        <span>{t('trial.done-weeks', { count: String(e.check_ins.length) })}</span>
      </div>
    </section>
  );
}
