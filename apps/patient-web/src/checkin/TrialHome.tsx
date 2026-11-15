import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n.ts';
import page from '../enrol/enrol.module.css';
import { getJson, paths, type CheckInContent, type EpisodeView } from './api.ts';
import { CheckInScreen } from './CheckInScreen.tsx';
import { GoalScreen } from './GoalScreen.tsx';
import { queueStorage } from './idb.ts';
import { OfflineQueue } from './queue.ts';
import { flush, type WeekOutcome } from './submit.ts';
import { TrialCard } from './TrialCard.tsx';

const EMERGENCY_KEY = 'endo.emergency-number';

/** The app's single offline queue (spec 14). */
export const offlineQueue = new OfflineQueue(queueStorage());

/** The local emergency number, kept for offline use (not health data). */
export function useEmergencyNumber(): string | null {
  const [n, setN] = useState<string | null>(() => {
    try {
      return localStorage.getItem(EMERGENCY_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    void getJson<{ emergency_number: string | null }>(
      window.fetch.bind(window),
      '/v1/app-config',
    ).then((c) => {
      if (c && c !== 'signed-out') {
        setN(c.emergency_number);
        try {
          if (c.emergency_number) localStorage.setItem(EMERGENCY_KEY, c.emergency_number);
          else localStorage.removeItem(EMERGENCY_KEY);
        } catch {
          // Storage unavailable: the number still shows while online.
        }
      }
    });
  }, []);
  return n;
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly episodes: readonly EpisodeView[];
      readonly content: CheckInContent;
    }
  | {
      readonly kind: 'checkin';
      readonly episode: EpisodeView;
      readonly content: CheckInContent;
      readonly week: number;
    };

/**
 * Signed-in home (spec 21.7 screens 3 to 5): her goal for a new treatment, then the Trial Card
 * with one primary action when a week is open. Queued check-ins are sent on load and whenever the
 * phone comes back online.
 */
export function TrialHome() {
  const fetchFn = useMemo(() => window.fetch.bind(window), []);
  const emergency = useEmergencyNumber();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const lastEpisodes = useRef<readonly EpisodeView[]>([]);

  const load = () => {
    void Promise.all([
      getJson<{ episodes: EpisodeView[] }>(fetchFn, paths.episodes),
      getJson<CheckInContent>(fetchFn, paths.content),
    ]).then(([e, c]) => {
      if (!e || !c || e === 'signed-out' || c === 'signed-out') setView({ kind: 'error' });
      else {
        lastEpisodes.current = e.episodes;
        setView({ kind: 'ready', episodes: e.episodes, content: c });
      }
    });
  };
  useEffect(() => {
    void flush(fetchFn, offlineQueue).finally(load);
    const online = () => {
      void flush(fetchFn, offlineQueue).then((r) => {
        if (r.sent > 0) load();
      });
    };
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
    };
  }, []);

  const done = (r: WeekOutcome | null) => {
    if (r) {
      setNotice(
        r.kind === 'saved'
          ? t('checkin.saved')
          : r.kind === 'queued'
            ? t('checkin.queued')
            : r.kind === 'signed-out'
              ? t('checkin.signed-out')
              : r.code === 'checkin.too_late'
                ? t('checkin.too-late')
                : t('checkin.refused'),
      );
    }
    // Offline (or signed out), reloading would fail: go back to what she last saw, with the notice.
    if (r && (r.kind === 'queued' || r.kind === 'signed-out') && view.kind === 'checkin') {
      setView({ kind: 'ready', episodes: lastEpisodes.current, content: view.content });
      return;
    }
    setView({ kind: 'loading' });
    load();
  };

  if (view.kind === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (view.kind === 'error')
    return (
      <p role="alert" className={page['error']}>
        {t('common.try-later')}
      </p>
    );
  if (view.kind === 'checkin')
    return (
      <CheckInScreen
        episode={view.episode}
        content={view.content}
        weekIndex={view.week}
        queue={offlineQueue}
        emergencyNumber={emergency}
        onDone={done}
      />
    );

  const draft = view.episodes.find((e) => e.status === 'draft');
  const current = view.episodes.filter((e) => e.status === 'active' || e.status === 'in_review');
  return (
    <>
      {notice && <p role="status">{notice}</p>}
      {draft && <GoalScreen episode={draft} content={view.content} onConfirmed={load} />}
      {!draft && current.length === 0 && <p>{t('home.no-episode')}</p>}
      {current.map((e) => {
        const week = e.open_weeks[0];
        return (
          <div key={e.id}>
            <TrialCard episode={e} />
            {week !== undefined ? (
              <button
                type="button"
                className={page['primary']}
                onClick={() => {
                  setNotice(null);
                  setView({ kind: 'checkin', episode: e, content: view.content, week });
                }}
              >
                {t('checkin.start')}
              </button>
            ) : (
              <p className={page['muted']}>{t('checkin.none-open')}</p>
            )}
          </div>
        );
      })}
    </>
  );
}
