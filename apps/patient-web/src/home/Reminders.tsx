import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.ts';
import styles from '../enrol/enrol.module.css';
import { getJson } from '../checkin/api.ts';
import { browserPush } from './push-browser.ts';
import { isOn, turnOff, turnOn, type ReminderResult } from './reminders.ts';

/** Weekly reminder (spec 15): on or off for this device, at an hour she chooses. */
export function Reminders() {
  const fetchFn = useMemo(() => window.fetch.bind(window), []);
  const push = useMemo(() => browserPush(), []);
  const [on, setOn] = useState(false);
  const [hour, setHour] = useState(18);
  const [key, setKey] = useState<string | null>(null);
  const [result, setResult] = useState<ReminderResult | null>(null);

  useEffect(() => {
    void isOn(push).then(setOn);
    void getJson<{ vapid_public_key: string | null }>(fetchFn, '/v1/app-config').then((c) => {
      if (c && c !== 'signed-out') setKey(c.vapid_public_key);
    });
  }, [push, fetchFn]);

  if (!push || !key) return <p className={styles['muted']}>{t('reminder.unavailable')}</p>;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return (
    <section aria-labelledby="reminder-title">
      <h2 id="reminder-title" className={styles['subtitle']}>
        {t('reminder.title')}
      </h2>
      <p className={styles['muted']}>{t(on ? 'reminder.on' : 'reminder.off')}</p>
      {result && result !== 'on' && result !== 'off' && (
        <p role="alert" className={styles['error']}>
          {t(result === 'denied' ? 'reminder.denied' : 'common.try-later')}
        </p>
      )}
      {!on && (
        <label className={styles['label']}>
          {t('reminder.hour')}
          <select
            className={styles['input']}
            value={hour}
            onChange={(e) => {
              setHour(Number(e.target.value));
            }}
          >
            {Array.from({ length: 13 }, (_, i) => 8 + i).map((h) => (
              <option key={h} value={h}>
                {`${String(h).padStart(2, '0')}:00`}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className={styles['quiet']}
        aria-pressed={on}
        onClick={() => {
          void (on ? turnOff(fetchFn, push) : turnOn(fetchFn, push, key, hour, zone)).then((r) => {
            setResult(r);
            if (r === 'on') setOn(true);
            if (r === 'off') setOn(false);
          });
        }}
      >
        {t(on ? 'reminder.disable' : 'reminder.enable')}
      </button>
    </section>
  );
}
