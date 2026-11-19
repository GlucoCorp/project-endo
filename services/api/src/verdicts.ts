import { createHash } from 'node:crypto';
import { AuditEventInput } from '@endo/audit';
import type { EpisodeEvidence, VerdictStore } from '@endo/clinical-store';
import { uuidv7 } from '@endo/domain';
import {
  SnapshotError,
  evaluate,
  parseRuleset,
  verifyRuleset,
  type Ruleset,
  type Snapshot,
  type WeekAnswers,
} from '@endo/verdict';
import type { JsonWebKey } from 'node:crypto';

/**
 * Verdict generation in shadow mode (M3: REQ-004; spec 7, 18.5). Verdicts are generated on the
 * schedule (3 days before the review date) and on a clinician's request, stored with the rule set
 * version and digest, the instrument version, the input hash and the trace, and shown to no one in
 * the care path until they are cleared for use. While the rule set is incomplete (any
 * TODO_CLINICAL) nothing is generated and the attempt records why.
 */
export interface LoadedRuleset {
  readonly version: string;
  /** SHA-256 of the file as read. */
  readonly digest: string;
  /** The complete rule set, or the list of what is missing. */
  readonly check: ReturnType<typeof parseRuleset>;
  /** Signature status: verified with a pinned key, or not signed (allowed outside deployment). */
  readonly signature: 'verified' | 'unsigned';
}

export class RulesetRejectedError extends Error {
  constructor(reason: string) {
    super(`Refusing to start: the rule set ${reason} (spec 18.5).`);
    this.name = 'RulesetRejectedError';
  }
}

/**
 * Loads the rule set file and its signature. Deployed environments must have a signature that
 * verifies against a pinned key; elsewhere an absent signature is allowed and recorded as such.
 */
export function loadRuleset(
  text: string,
  signatureText: string | null,
  trusted: ReadonlyMap<string, JsonWebKey>,
  deployed: boolean,
): LoadedRuleset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RulesetRejectedError('is not valid JSON');
  }
  let signature: LoadedRuleset['signature'] = 'unsigned';
  if (signatureText !== null) {
    let sig: unknown = null;
    try {
      sig = JSON.parse(signatureText);
    } catch {
      sig = null;
    }
    const v = verifyRuleset(parsed, sig, trusted);
    if (!v.ok) throw new RulesetRejectedError(`signature is not valid (${v.reason})`);
    signature = 'verified';
  } else if (deployed) {
    throw new RulesetRejectedError('is not signed');
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  return {
    version:
      typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? version : '0.0.0',
    digest: createHash('sha256').update(text).digest('hex'),
    check: parseRuleset(parsed),
    signature,
  };
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Her answers week by week; a week without a check-in is null (missing), never filled in. */
export function snapshotOf(
  e: EpisodeEvidence,
  today: string,
): { snapshot: Snapshot; openWeeks: number } {
  const byWeek = new Map(e.checkIns.map((c) => [c.weekIndex, c.answers as WeekAnswers]));
  let openWeeks = 0;
  const weeks = Array.from({ length: e.reviewIntervalWeeks }, (_, i) => {
    const k = i + 1;
    const answers = byWeek.get(k);
    if (answers) return answers;
    // Not yet past its 7-day window: counted as missing, and reported in the explanation.
    if (today < addDays(e.startDate, k * 7 + 7)) openWeeks++;
    return null;
  });
  return {
    snapshot: {
      episodeId: e.episodeId,
      reviewIntervalWeeks: e.reviewIntervalWeeks,
      adherenceMode: e.adherenceMode,
      weeks,
      redFlagEvents: e.redFlagEvents,
    },
    openWeeks,
  };
}

export interface GenerateRequest {
  readonly orgId: string;
  readonly episodeId: string;
  /** For on-demand requests: the patient named in the path; the episode must be hers. */
  readonly patientId?: string;
  readonly by: 'system' | 'on_demand';
  /** The clinician (clinical-store id) for on-demand generation. */
  readonly requestedBy: string | null;
  readonly actor: { readonly id: string | null; readonly role: string };
  readonly requestId: string;
}

export type GenerateOutcome =
  | {
      readonly kind: 'recorded';
      readonly id: string;
      readonly outcome: 'generated' | 'not_generated';
    }
  | { readonly kind: 'already' }
  | { readonly kind: 'not_found' };

export class VerdictService {
  readonly #store: VerdictStore;
  readonly #ruleset: LoadedRuleset;
  readonly #now: () => Date;

  constructor(store: VerdictStore, ruleset: LoadedRuleset, now: () => Date) {
    this.#store = store;
    this.#ruleset = ruleset;
    this.#now = now;
  }

  get rulesetVersion(): string {
    return this.#ruleset.version;
  }

  async generate(r: GenerateRequest): Promise<GenerateOutcome> {
    const evidence = await this.#store.evidence(r.orgId, r.episodeId);
    if (
      !evidence ||
      evidence.status === 'draft' ||
      (r.patientId !== undefined && evidence.patientId !== r.patientId)
    )
      return { kind: 'not_found' };
    const today = this.#now().toISOString().slice(0, 10);
    const id = uuidv7();
    let result:
      | {
          outcome: 'generated';
          code: string;
          secondary: string | null;
          modifiers: readonly string[];
          inputHash: string;
          explanation: Record<string, unknown>;
        }
      | { outcome: 'not_generated'; reason: string };
    const check = this.#ruleset.check;
    if (!check.ok) {
      result = { outcome: 'not_generated', reason: 'ruleset_incomplete' };
    } else {
      const { snapshot, openWeeks } = snapshotOf(evidence, today);
      result = this.#evaluate(snapshot, check.ruleset, openWeeks, today);
    }
    const recorded = await this.#store.record({
      id,
      orgId: r.orgId,
      patientId: evidence.patientId,
      episodeId: r.episodeId,
      result,
      rulesetVersion: this.#ruleset.version,
      rulesetDigest: this.#ruleset.digest,
      instrumentVersion: evidence.instrumentVersion,
      generatedBy: r.by,
      requestedBy: r.requestedBy,
      auditEvent: {
        id: uuidv7(),
        ...AuditEventInput.parse({
          actor: r.actor,
          action: 'verdict.generated',
          resource: { type: 'verdict', id },
          org_id: r.orgId,
          purpose_of_use: r.by === 'system' ? 'operations' : 'treatment',
          outcome: 'success',
          reason: result.outcome === 'not_generated' ? `verdict.${result.reason}` : null,
          request_id: r.requestId,
        }),
      },
    });
    return recorded ? { kind: 'recorded', id, outcome: result.outcome } : { kind: 'already' };
  }

  #evaluate(snapshot: Snapshot, ruleset: Ruleset, openWeeks: number, today: string) {
    try {
      const v = evaluate(snapshot, ruleset);
      return {
        outcome: 'generated' as const,
        code: v.code,
        secondary: v.secondary,
        modifiers: v.modifiers,
        inputHash: v.inputHash,
        explanation: {
          trace: v.trace,
          as_of: today,
          open_weeks: openWeeks,
          ruleset_signature: this.#ruleset.signature,
        },
      };
    } catch (error) {
      if (error instanceof SnapshotError)
        return { outcome: 'not_generated' as const, reason: 'snapshot_invalid' };
      throw error;
    }
  }

  /** The schedule (REQ-004): every episode due 3 days before its review, once per rule set version. */
  async runSchedule(requestId: () => string): Promise<number> {
    const today = this.#now().toISOString().slice(0, 10);
    let n = 0;
    for (const d of await this.#store.due(today, this.#ruleset.version)) {
      const r = await this.generate({
        orgId: d.orgId,
        episodeId: d.episodeId,
        by: 'system',
        requestedBy: null,
        actor: { id: null, role: 'system' },
        requestId: requestId(),
      });
      if (r.kind === 'recorded') n++;
    }
    return n;
  }
}
