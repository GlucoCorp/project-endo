/** Roles from spec 3.1. Order is not significant. */
export const ROLES = [
  'patient',
  'clinician',
  'org_admin',
  'glucorp_support',
  'glucorp_platform_admin',
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
