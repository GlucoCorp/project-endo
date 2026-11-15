import { useEffect, useRef } from 'react';
import { t } from '../i18n.ts';
import styles from './checkin.module.css';

/**
 * Red flag (spec 21.7 screen 6; REQ-007). Full screen, shown at once, before any network call:
 * the instruction in the largest type, the local emergency number as a large call button when
 * one is configured, and "I understand" to acknowledge. It cannot be dismissed any other way.
 * It never says the care team was told.
 */
export function UrgentScreen(props: {
  readonly emergencyNumber: string | null;
  readonly crisis: boolean;
  readonly onAcknowledge: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div
      className={styles['urgent']}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="urgent-title"
    >
      <h1 id="urgent-title" ref={heading} tabIndex={-1} className={styles['urgentTitle']}>
        {t('urgent.title')}
      </h1>
      {props.emergencyNumber ? (
        <a className={styles['call']} href={`tel:${props.emergencyNumber}`}>
          {t('urgent.call', { number: props.emergencyNumber })}
        </a>
      ) : (
        <p className={styles['urgentText']}>{t('urgent.no-number')}</p>
      )}
      {props.crisis && <p className={styles['urgentText']}>{t('urgent.crisis')}</p>}
      <button type="button" className={styles['ack']} onClick={props.onAcknowledge}>
        {t('urgent.ack')}
      </button>
    </div>
  );
}
