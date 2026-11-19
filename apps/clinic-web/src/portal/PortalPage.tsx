import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { t } from '../i18n.ts';
import { DraftEpisode } from './DraftEpisode.tsx';
import { Portal, type ConfirmResult, type Invitation, type SessionView } from './portal.ts';
import styles from './portal.module.css';

const day = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The clinic desk, first screen (spec 21.8; ADR-0021 slice 3): sign in, choose the organisation,
 * then confirm the patient in front of you: select her invitation, type the code from her phone,
 * and attest both statements.
 */
export function PortalPage() {
  const portal = useRef(new Portal(window.fetch.bind(window))).current;
  const [session, setSession] = useState<SessionView | null>(null);

  useEffect(() => {
    void portal.session().then(setSession);
  }, [portal]);

  return (
    <main className={styles['page']}>
      <h1 className={styles['title']}>{t('clinic.title')}</h1>
      {session === null ? (
        <p role="status">{t('common.loading')}</p>
      ) : session.kind === 'signed-out' ? (
        <>
          <p>{t('clinic.signed-out')}</p>
          {/* A full navigation: the BFF starts the OIDC sign-in (ADR-0019). */}
          <a className={styles['primary']} href="/auth/login">
            {t('clinic.sign-in')}
          </a>
        </>
      ) : session.kind === 'error' ? (
        <p role="alert">{t(session.message)}</p>
      ) : session.kind === 'choose-org' ? (
        <>
          <h2 className={styles['subtitle']}>{t('clinic.choose-org')}</h2>
          <ul className={styles['list']}>
            {session.organisations.map((o) => (
              <li key={o.index}>
                <button
                  type="button"
                  className={styles['row']}
                  onClick={() => {
                    void portal.chooseOrganisation(o.index).then(setSession);
                  }}
                >
                  {t('clinic.org-option', { org: o.orgId.slice(-6), role: o.role })}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p>
            <a href="/reviews">{t('desk.queue-title')}</a>
          </p>
          <p>
            <a href="/dashboard">{t('dashboard.title')}</a>
          </p>
          {session.role === 'org_admin' && (
            <p>
              <a href="/admin">{t('admin.title')}</a>
            </p>
          )}
          <Enrolments portal={portal} />
          <DraftEpisode portal={portal} />
        </>
      )}
    </main>
  );
}

function Enrolments({ portal }: { portal: Portal }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [identified, setIdentified] = useState(false);
  const [ownPhone, setOwnPhone] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void portal.invitations().then((list) => {
      setFailed(list === null);
      setInvitations(list ?? []);
    });
  };
  useEffect(load, [portal]);

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    void portal.confirm(selected, code, { identified, ownPhone }).then((r) => {
      setResult(r);
      setBusy(false);
      if (r.kind === 'confirmed' || r.kind === 'unavailable') {
        setCode('');
        setIdentified(false);
        setOwnPhone(false);
        setSelected(null);
        load();
      }
    });
  };

  const message = (r: ConfirmResult): string => {
    switch (r.kind) {
      case 'confirmed':
        return t('clinic.confirmed');
      case 'wrong':
        return t('clinic.wrong', { remaining: String(r.remaining) });
      case 'locked':
        return t('clinic.locked', { time: day(r.until) });
      case 'unavailable':
        return t('clinic.unavailable');
      case 'error':
        return t(r.message);
    }
  };

  return (
    <>
      <h2 className={styles['subtitle']}>{t('clinic.enrolments-title')}</h2>
      <p className={styles['muted']}>{t('clinic.enrolments-help')}</p>
      {result && (
        <p role={result.kind === 'confirmed' ? 'status' : 'alert'} className={styles['result']}>
          {message(result)}
        </p>
      )}
      {failed ? (
        <p role="alert">{t('common.try-later')}</p>
      ) : invitations === null ? (
        <p role="status">{t('common.loading')}</p>
      ) : invitations.length === 0 ? (
        <p>{t('clinic.no-invitations')}</p>
      ) : (
        <form onSubmit={submit} className={styles['form']}>
          <fieldset className={styles['fieldset']}>
            <ul className={styles['list']}>
              {invitations.map((i) => (
                <li key={i.id} className={styles['invitation']}>
                  <label>
                    <input
                      type="radio"
                      name="invitation"
                      value={i.id}
                      disabled={i.inUse}
                      checked={selected === i.id}
                      onChange={() => {
                        setSelected(i.id);
                      }}
                    />{' '}
                    {t('clinic.invitation', {
                      created: day(i.createdAt),
                      expires: day(i.expiresAt),
                    })}
                    {i.inUse && <span className={styles['muted']}> {t('clinic.in-use')}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <label className={styles['field']}>
            {t('clinic.code')}
            <input
              className={styles['code']}
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/[^0-9]/g, ''));
              }}
            />
          </label>
          <label className={styles['check']}>
            <input
              type="checkbox"
              checked={identified}
              onChange={(e) => {
                setIdentified(e.target.checked);
              }}
            />{' '}
            {t('clinic.identified')}
          </label>
          <label className={styles['check']}>
            <input
              type="checkbox"
              checked={ownPhone}
              onChange={(e) => {
                setOwnPhone(e.target.checked);
              }}
            />{' '}
            {t('clinic.own-phone')}
          </label>
          <button type="submit" className={styles['primary']} disabled={!selected || busy}>
            {t('clinic.confirm')}
          </button>
        </form>
      )}
    </>
  );
}
