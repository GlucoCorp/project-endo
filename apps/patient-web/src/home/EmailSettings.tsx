import { useState, type SyntheticEvent } from 'react';
import { t } from '../i18n.ts';
import styles from '../enrol/enrol.module.css';
import { confirmEmailCode, requestEmailCode } from './email.ts';

type Step =
  | { readonly kind: 'address'; readonly error: boolean }
  | { readonly kind: 'code'; readonly requestId: string; readonly wrong: boolean }
  | { readonly kind: 'saved' }
  | { readonly kind: 'busy' };

/** Spec 10.1 fallback (ADR-0026): one field at a time, address then code. */
export function EmailSettings() {
  const fetchFn = window.fetch.bind(window);
  const [step, setStep] = useState<Step>({ kind: 'address', error: false });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');

  const sendCode = (e: SyntheticEvent) => {
    e.preventDefault();
    setStep({ kind: 'busy' });
    void requestEmailCode(fetchFn, address).then((id) => {
      setStep(
        id === 'error'
          ? { kind: 'address', error: true }
          : { kind: 'code', requestId: id, wrong: false },
      );
    });
  };
  const confirm = (e: SyntheticEvent, requestId: string) => {
    e.preventDefault();
    setStep({ kind: 'busy' });
    void confirmEmailCode(fetchFn, requestId, code).then((r) => {
      setCode('');
      setStep(
        r === 'confirmed'
          ? { kind: 'saved' }
          : r === 'wrong'
            ? { kind: 'code', requestId, wrong: true }
            : { kind: 'address', error: true },
      );
    });
  };

  return (
    <section aria-labelledby="email-title">
      <h2 id="email-title" className={styles['subtitle']}>
        {t('email.title')}
      </h2>
      {step.kind === 'busy' && <p role="status">{t('common.loading')}</p>}
      {step.kind === 'saved' && <p role="status">{t('email.saved')}</p>}
      {step.kind === 'address' && (
        <form onSubmit={sendCode}>
          <p className={styles['muted']}>{t('email.help')}</p>
          {step.error && (
            <p role="alert" className={styles['error']}>
              {t('common.try-later')}
            </p>
          )}
          <label className={styles['label']} htmlFor="email-address">
            {t('email.address')}
          </label>
          <input
            id="email-address"
            className={styles['input']}
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
            }}
          />
          <button type="submit" className={styles['quiet']}>
            {t('email.send')}
          </button>
        </form>
      )}
      {step.kind === 'code' && (
        <form
          onSubmit={(e) => {
            confirm(e, step.requestId);
          }}
        >
          <p role="status">{t('email.sent')}</p>
          {step.wrong && (
            <p role="alert" className={styles['error']}>
              {t('email.wrong')}
            </p>
          )}
          <label className={styles['label']} htmlFor="email-code">
            {t('email.code')}
          </label>
          <input
            id="email-code"
            className={styles['input']}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
          <button type="submit" className={styles['primary']}>
            {t('email.confirm')}
          </button>
        </form>
      )}
    </section>
  );
}
