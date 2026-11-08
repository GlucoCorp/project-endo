import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLINICAL_MIGRATIONS_DIR,
  CONSENT_PURPOSES,
  InMemoryIdempotentInvitationStore,
  InMemoryInvitationStore,
  InMemoryMembershipStore,
} from './index.ts';

describe('spec 13.1 consent purposes', () => {
  it('match the database CHECK constraint exactly', () => {
    const migration = readFileSync(
      join(CLINICAL_MIGRATIONS_DIR, '0001_enrolment_consent.sql'),
      'utf8',
    );
    const check = /purpose\s+text\s+NOT NULL CHECK \(purpose IN \(([^)]*)\)\)/.exec(migration);
    const inDb = (check?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1));
    expect(inDb).toEqual([...CONSENT_PURPOSES]);
  });
});

describe('InMemoryInvitationStore (dev and tests)', () => {
  it('keeps what it is given', async () => {
    const store = new InMemoryInvitationStore(() => new Date(0));
    const inv = {
      id: '01900000-0000-7000-8000-000000000001',
      orgId: '01900000-0000-7000-8000-00000000000a',
      createdBy: '01900000-0000-7000-8000-0000000000c1',
      tokenHash: 'a'.repeat(64),
    };
    const { expiresAt } = await store.create(inv);
    expect(expiresAt.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(store.invitations).toEqual([{ ...inv, expiresAt }]);
    expect(new InMemoryInvitationStore().invitations).toEqual([]);
  });

  it('InMemoryMembershipStore finds only what was added', async () => {
    const m = { clinicianId: 'c', role: 'clinician' as const, active: true };
    const store = new InMemoryMembershipStore().add('org', 'ref', m);
    expect(await store.find('org', 'ref')).toEqual(m);
    expect(await store.find('org', 'other')).toBeNull();
  });
});

describe('InMemoryIdempotentInvitationStore (dev and tests)', () => {
  const req = (key: string, requestHash = 'b'.repeat(64)) => ({
    invitation: { id: 'i', orgId: 'o', createdBy: 'c', tokenHash: 'a'.repeat(64) },
    idempotency: { actorRef: 'c', key, requestHash },
    auditEvent: { id: 'e' },
    sealResponse: () => Promise.resolve({ wrappedKey: 'w', envelope: 'v' }),
  });

  it('creates once, replays the same key and request, and flags a changed request', async () => {
    const store = new InMemoryIdempotentInvitationStore(() => new Date(0));
    expect(await store.createOnce(req('k'))).toEqual({
      kind: 'created',
      expiresAt: new Date(7 * 24 * 3600 * 1000),
    });
    expect(await store.createOnce(req('k'))).toEqual({
      kind: 'replay',
      statusCode: 201,
      sealed: { wrappedKey: 'w', envelope: 'v' },
    });
    expect(await store.createOnce(req('k', 'c'.repeat(64)))).toEqual({ kind: 'conflict' });
    expect(store.invitations).toHaveLength(1);
    expect(store.outbox).toEqual([{ id: 'e' }]);
    expect(new InMemoryIdempotentInvitationStore().invitations).toEqual([]);
  });
});

describe('InMemoryIdempotentInvitationStore concurrency and expiry', () => {
  const req = (key: string, seal = () => Promise.resolve({ wrappedKey: 'w', envelope: 'v' })) => ({
    invitation: { id: 'i', orgId: 'o', createdBy: 'c', tokenHash: 'a'.repeat(64) },
    idempotency: { actorRef: 'c', key, requestHash: 'b'.repeat(64) },
    auditEvent: { id: 'e' },
    sealResponse: seal,
  });

  it('creates once when two requests with the same key arrive together', async () => {
    const store = new InMemoryIdempotentInvitationStore();
    const results = await Promise.all([store.createOnce(req('k')), store.createOnce(req('k'))]);
    expect(results.map((r) => r.kind).sort()).toEqual(['created', 'replay']);
    expect(store.invitations).toHaveLength(1);
  });

  it('reports expiry after 24 hours, and forgets a key whose sealing failed', async () => {
    let now = 0;
    const store = new InMemoryIdempotentInvitationStore(() => new Date(now));
    await store.createOnce(req('k'));
    now = 24 * 3600 * 1000;
    expect((await store.createOnce(req('k'))).kind).toBe('expired');
    await expect(
      store.createOnce(req('f', () => Promise.reject(new Error('kms')))),
    ).rejects.toThrow('kms');
    expect((await store.createOnce(req('f'))).kind).toBe('created');
  });
});
