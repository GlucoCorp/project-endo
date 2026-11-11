import { describe, expect, it } from 'vitest';
import { InMemoryIdempotentInvitationStore } from './idempotent.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const OTHER = '01900000-0000-7000-8000-00000000000b';
const NOW = new Date('2026-11-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

describe('REQ-001 the in-memory stand-in lists invitations like the database store', () => {
  it('lists accepted invitations of one organisation in the last 30 days, newest first', async () => {
    const store = new InMemoryIdempotentInvitationStore(() => NOW);
    store.accepted.push(
      { id: 'a', orgId: ORG, acceptedAt: daysAgo(3), sharing: 'shared' },
      { id: 'b', orgId: ORG, acceptedAt: daysAgo(1), sharing: 'declined' },
      { id: 'c', orgId: ORG, acceptedAt: daysAgo(31), sharing: 'shared' },
      { id: 'd', orgId: OTHER, acceptedAt: daysAgo(1), sharing: 'pending' },
    );
    expect(await store.listAccepted(ORG)).toEqual([
      { id: 'b', acceptedAt: daysAgo(1), sharing: 'declined' },
      { id: 'a', acceptedAt: daysAgo(3), sharing: 'shared' },
    ]);
  });

  it('lists only unexpired open invitations of one organisation, newest first', async () => {
    const store = new InMemoryIdempotentInvitationStore(() => NOW);
    const at = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);
    store.invitations.push(
      { id: 'x', orgId: ORG, createdBy: 'c', tokenHash: 't', expiresAt: at(1) },
      { id: 'y', orgId: ORG, createdBy: 'c', tokenHash: 't', expiresAt: at(-1) },
      { id: 'z', orgId: ORG, createdBy: 'c', tokenHash: 't', expiresAt: at(6) },
      { id: 'w', orgId: OTHER, createdBy: 'c', tokenHash: 't', expiresAt: at(6) },
    );
    expect((await store.listOpen(ORG)).map((i) => i.id)).toEqual(['z', 'x']);
  });
});
