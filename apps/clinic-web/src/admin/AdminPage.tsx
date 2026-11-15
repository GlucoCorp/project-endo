import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n.ts';
import { Portal } from '../portal/portal.ts';
import styles from '../desk/desk.module.css';
import { Admin, parseSettings, type Member } from './admin.ts';

/** Organisation settings and team (REQ-010; spec 21.8). For the organisation's admins. */
export function AdminPage() {
  const portal = useRef(new Portal(window.fetch.bind(window))).current;
  const admin = useMemo(
    () => new Admin(window.fetch.bind(window), () => portal.csrfToken()),
    [portal],
  );
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [weeks, setWeeks] = useState('');
  const [languages, setLanguages] = useState('en');
  const [emergency, setEmergency] = useState('');
  const [message, setMessage] = useState<'saved' | 'invalid' | 'error' | null>(null);
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [teamMessage, setTeamMessage] = useState<'last-admin' | 'error' | null>(null);

  const loadMembers = () => {
    void admin.members().then((m) => {
      setMembers(m ?? []);
    });
  };

  useEffect(() => {
    void portal.session().then((s) => {
      const ok = s.kind === 'active' && s.role === 'org_admin';
      setAllowed(ok);
      if (!ok) return;
      void admin.settings().then((st) => {
        if (!st) return;
        setWeeks(st.default_review_interval_weeks?.toString() ?? '');
        setLanguages(st.languages.join(', '));
        setEmergency(st.emergency_number ?? '');
      });
      void admin.members().then((m) => {
        setMembers(m ?? []);
      });
    });
  }, [portal, admin]);

  if (allowed === null)
    return (
      <main className={styles['page']}>
        <p role="status">{t('common.loading')}</p>
      </main>
    );
  if (!allowed)
    return (
      <main className={styles['page']}>
        <p role="alert">{t('admin.not-admin')}</p>
        <a href="/">{t('admin.back')}</a>
      </main>
    );

  return (
    <main className={styles['page']}>
      <p>
        <a href="/">{t('admin.back')}</a>
      </p>
      <h1 className={styles['title']}>{t('admin.title')}</h1>

      <section aria-labelledby="settings-title">
        <h2 id="settings-title">{t('admin.settings')}</h2>
        <label className={styles['field']}>
          {t('admin.interval')}
          <select
            value={weeks}
            onChange={(e) => {
              setWeeks(e.target.value);
            }}
          >
            <option value="">{t('admin.interval-none')}</option>
            {[4, 6, 8, 10, 12, 16, 20, 26].map((w) => (
              <option key={w} value={String(w)}>
                {t('admin.weeks', { weeks: String(w) })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles['field']}>
          {t('admin.languages')}
          <input
            value={languages}
            onChange={(e) => {
              setLanguages(e.target.value);
            }}
          />
        </label>
        <label className={styles['field']}>
          {t('admin.emergency')}
          <input
            inputMode="numeric"
            value={emergency}
            onChange={(e) => {
              setEmergency(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className={styles['primary']}
          onClick={() => {
            const s = parseSettings(weeks, languages, emergency);
            if (!s) {
              setMessage('invalid');
              return;
            }
            void admin.saveSettings(s).then((r) => {
              setMessage(r.kind === 'ok' ? 'saved' : r.kind === 'refused' ? 'invalid' : 'error');
            });
          }}
        >
          {t('admin.save')}
        </button>
        {message === 'saved' && <p role="status">{t('admin.saved')}</p>}
        {message === 'invalid' && <p role="alert">{t('admin.invalid')}</p>}
        {message === 'error' && <p role="alert">{t('common.try-later')}</p>}
      </section>

      <section aria-labelledby="team-title">
        <h2 id="team-title">{t('admin.team')}</h2>
        <ul className={styles['queue']}>
          {members.map((m) => (
            <li key={m.clinician_id}>
              {t('admin.member', {
                ref: m.clinician_id.slice(-6),
                since: m.since,
                role: m.role === 'org_admin' ? 'admin' : 'clinician',
                status: t(m.active ? 'admin.active' : 'admin.inactive'),
              })}{' '}
              {m.you ? (
                t('admin.you')
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void admin.change(m.clinician_id, m.role, !m.active).then((r) => {
                        setTeamMessage(
                          r.kind === 'ok'
                            ? null
                            : r.kind === 'refused' && r.code === 'org.last_admin'
                              ? 'last-admin'
                              : 'error',
                        );
                        loadMembers();
                      });
                    }}
                  >
                    {t(m.active ? 'admin.deactivate' : 'admin.reactivate')}
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() => {
                      void admin
                        .change(
                          m.clinician_id,
                          m.role === 'org_admin' ? 'clinician' : 'org_admin',
                          m.active,
                        )
                        .then((r) => {
                          setTeamMessage(
                            r.kind === 'ok'
                              ? null
                              : r.kind === 'refused' && r.code === 'org.last_admin'
                                ? 'last-admin'
                                : 'error',
                          );
                          loadMembers();
                        });
                    }}
                  >
                    {t(m.role === 'org_admin' ? 'admin.make-clinician' : 'admin.make-admin')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {teamMessage === 'last-admin' && <p role="alert">{t('admin.last-admin')}</p>}
        {teamMessage === 'error' && <p role="alert">{t('common.try-later')}</p>}
      </section>
    </main>
  );
}
