/**
 * `/.well-known/security.txt` (RFC 9116; spec 12.7: a public vulnerability disclosure route from
 * launch). The contact comes from configuration; without one the route answers 404 rather than
 * publish a placeholder.
 */
export interface SecurityTxtOptions {
  /** `mailto:` or `https:` URI where reports go. */
  readonly contact: string;
  /** The disclosure policy page, if published. */
  readonly policy?: string | null;
  readonly now: Date;
}

const URI = /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/;

export function isSecurityContact(value: string): boolean {
  return URI.test(value);
}

/** The file's text; `Expires` is 180 days ahead (RFC 9116 asks for less than a year). */
export function securityTxt(o: SecurityTxtOptions): string {
  if (!isSecurityContact(o.contact)) throw new TypeError('contact must be a mailto: or https: URI');
  if (o.policy && !/^https:\/\/[^\s]+$/.test(o.policy))
    throw new TypeError('policy must be an https: URL');
  const expires = new Date(o.now.getTime() + 180 * 86_400_000).toISOString();
  return [
    `Contact: ${o.contact}`,
    `Expires: ${expires}`,
    ...(o.policy ? [`Policy: ${o.policy}`] : []),
    'Preferred-Languages: en',
    '',
  ].join('\n');
}
