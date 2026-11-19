import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import styles from '../desk/desk.module.css';
import { dashboard, type Dashboard } from './admin.ts';

/** The aggregate organisation dashboard (REQ-011): de-identified counts, small cells hidden. */
export function DashboardPage() {
  const f = useMemo(() => window.fetch.bind(window), []);
  const [data, setData] = useState<Dashboard | null | 'error'>(null);
  useEffect(() => {
    void dashboard(f).then((d) => {
      setData(d ?? 'error');
    });
  }, [f]);
  if (data === null)
    return (
      <main className={styles['page']}>
        <p role="status">{t('common.loading')}</p>
      </main>
    );
  if (data === 'error')
    return (
      <main className={styles['page']}>
        <p role="alert">{t('common.try-later')}</p>
        <a href="/">{t('admin.back')}</a>
      </main>
    );
  const min = String(data.min_cell);
  const show = (n: number | null) => (n === null ? t('dashboard.hidden', { min }) : String(n));
  return (
    <main className={styles['page']}>
      <p>
        <a href="/">{t('admin.back')}</a>
      </p>
      <h1 className={styles['title']}>{t('dashboard.title')}</h1>
      <p className={styles['muted']}>{t('dashboard.lead', { min })}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.month')}</th>
            <th scope="col">{t('dashboard.started')}</th>
            <th scope="col">{t('dashboard.due')}</th>
            <th scope="col">{t('dashboard.on-time', { days: String(data.on_time_grace_days) })}</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{m.month.slice(0, 7)}</th>
              <td>{show(m.episodes_started)}</td>
              <td>{show(m.reviews_due)}</td>
              <td>{show(m.reviews_on_time)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{t('dashboard.total')}</th>
            <td>{show(data.totals.episodes_started)}</td>
            <td>{show(data.totals.reviews_due)}</td>
            <td>{show(data.totals.reviews_on_time)}</td>
          </tr>
        </tfoot>
      </table>
      <p className={styles['muted']}>{t('dashboard.shadow')}</p>
    </main>
  );
}
