import { createHash, randomBytes } from 'node:crypto';
import { sql, type Generated, type Kysely } from 'kysely';

export interface SessionDatabase {
  browser_session: {
    token_hash: string;
    kind: string;
    doc: unknown;
    issuer: string | null;
    sid: string | null;
    subject: string | null;
    idle_ms: number;
    absolute_ms: number;
    created_at: Generated<Date>;
    last_seen_at: Generated<Date>;
  };
}

export interface StoredSession<T> {
  readonly doc: T;
  readonly createdAt: number;
  /** When it was last used before this read (milliseconds). */
  readonly lastSeenBefore: number;
}

export interface NewSessionRow<T> {
  readonly kind: string;
  readonly doc: T;
  readonly idleMs: number;
  readonly absoluteMs: number;
  readonly issuer?: string | null;
  readonly sid?: string | null;
  readonly subject?: string | null;
  /** Keep the session's original creation time (rotation keeps the absolute deadline). */
  readonly createdAt?: number;
  /** Keep the last activity time (a background rotation never extends the idle time). */
  readonly lastSeenAt?: number;
}

/** Thrown inside a rotation to undo it: the old session stays as it was. */
class Declined extends Error {}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** An opaque 256-bit session token for the cookie. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/**
 * Durable sessions (ADR-0033): tokens stored as SHA-256 only; idle and absolute expiry checked
 * by the database on every read, so all replicas agree; rotation is atomic (the old token stops
 * working in the same transaction the new one starts).
 */
export class SessionTable {
  readonly #db: Kysely<SessionDatabase>;

  constructor(db: Kysely<SessionDatabase>) {
    this.#db = db;
  }

  async insert<T>(row: NewSessionRow<T>): Promise<string> {
    const token = newSessionToken();
    await this.#db
      .insertInto('browser_session')
      .values({
        token_hash: hash(token),
        kind: row.kind,
        doc: JSON.stringify(row.doc),
        issuer: row.issuer ?? null,
        sid: row.sid ?? null,
        subject: row.subject ?? null,
        idle_ms: row.idleMs,
        absolute_ms: row.absoluteMs,
        ...(row.createdAt ? { created_at: new Date(row.createdAt) } : {}),
      })
      .execute();
    return token;
  }

  /**
   * The live session of this kind, or null (an expired one is removed). `touch` counts the read
   * as activity; background reads pass false so polling never keeps a session alive.
   */
  async get<T>(token: string, kind: string, touch = true): Promise<StoredSession<T> | null> {
    const key = hash(token);
    const live = sql<boolean>`last_seen_at > now() - make_interval(secs => idle_ms / 1000.0)
      AND created_at > now() - make_interval(secs => absolute_ms / 1000.0)`;
    const row = await this.#db
      .with('prev', (db) =>
        db
          .selectFrom('browser_session')
          .select(['token_hash', 'last_seen_at'])
          .where('token_hash', '=', key)
          .where('kind', '=', kind)
          .where(live),
      )
      .updateTable('browser_session')
      .from('prev')
      .set((eb) => ({
        last_seen_at: touch ? sql<Date>`now()` : eb.ref('browser_session.last_seen_at'),
      }))
      .whereRef('browser_session.token_hash', '=', 'prev.token_hash')
      .returning([
        'browser_session.doc',
        'browser_session.created_at',
        'prev.last_seen_at as before',
      ])
      .executeTakeFirst();
    if (!row) {
      // Only an expired row is removed: a live session of another kind stays as it is.
      await this.#db
        .deleteFrom('browser_session')
        .where('token_hash', '=', key)
        .where(
          sql<boolean>`last_seen_at <= now() - make_interval(secs => idle_ms / 1000.0)
            OR created_at <= now() - make_interval(secs => absolute_ms / 1000.0)`,
        )
        .execute();
      return null;
    }
    return {
      doc: row.doc as T,
      createdAt: row.created_at.getTime(),
      lastSeenBefore: row.before.getTime(),
    };
  }

  /** Replaces the document of a live session (no-op if it is gone). */
  async patch(token: string, doc: unknown): Promise<void> {
    await this.#db
      .updateTable('browser_session')
      .set({ doc: JSON.stringify(doc) })
      .where('token_hash', '=', hash(token))
      .execute();
  }

  /**
   * Atomically ends `token` (if live and of `kind`) and starts a new session from its document.
   * Null if the old one is gone or expired, or if `next` declines (returns null), in which case
   * the old session is kept unchanged.
   */
  async rotate<T, U>(
    token: string,
    kind: string,
    next: (old: StoredSession<T>) => NewSessionRow<U> | null,
  ): Promise<string | null> {
    try {
      return await this.#rotate(token, kind, next);
    } catch (error) {
      if (error instanceof Declined) return null;
      throw error;
    }
  }

  #rotate<T, U>(
    token: string,
    kind: string,
    next: (old: StoredSession<T>) => NewSessionRow<U> | null,
  ): Promise<string | null> {
    return this.#db.transaction().execute(async (trx) => {
      const old = await trx
        .deleteFrom('browser_session')
        .where('token_hash', '=', hash(token))
        .where('kind', '=', kind)
        .where(
          sql<boolean>`last_seen_at > now() - make_interval(secs => idle_ms / 1000.0)
            AND created_at > now() - make_interval(secs => absolute_ms / 1000.0)`,
        )
        .returning(['doc', 'created_at', 'last_seen_at'])
        .executeTakeFirst();
      if (!old) return null;
      const row = next({
        doc: old.doc as T,
        createdAt: old.created_at.getTime(),
        lastSeenBefore: old.last_seen_at.getTime(),
      });
      if (!row) throw new Declined();
      const fresh = newSessionToken();
      await trx
        .insertInto('browser_session')
        .values({
          token_hash: hash(fresh),
          kind: row.kind,
          doc: JSON.stringify(row.doc),
          issuer: row.issuer ?? null,
          sid: row.sid ?? null,
          subject: row.subject ?? null,
          idle_ms: row.idleMs,
          absolute_ms: row.absoluteMs,
          ...(row.createdAt ? { created_at: new Date(row.createdAt) } : {}),
          ...(row.lastSeenAt ? { last_seen_at: new Date(row.lastSeenAt) } : {}),
        })
        .execute();
      return fresh;
    });
  }

  async remove(token: string): Promise<void> {
    await this.#db.deleteFrom('browser_session').where('token_hash', '=', hash(token)).execute();
  }

  /** Back-channel logout: every session of this issuer with the sid, or else the subject. */
  async removeMatching(issuer: string, match: { sid?: string; sub?: string }): Promise<number> {
    if (match.sid === undefined && match.sub === undefined) return 0;
    const q = this.#db.deleteFrom('browser_session').where('issuer', '=', issuer);
    const r = await (
      match.sid !== undefined
        ? q.where('sid', '=', match.sid)
        : q.where('subject', '=', match.sub ?? '')
    ).executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** Removes expired sessions (a periodic housekeeping call); returns how many. */
  async sweep(): Promise<number> {
    const r = await this.#db
      .deleteFrom('browser_session')
      .where(
        sql<boolean>`last_seen_at <= now() - make_interval(secs => idle_ms / 1000.0)
          OR created_at <= now() - make_interval(secs => absolute_ms / 1000.0)`,
      )
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}
