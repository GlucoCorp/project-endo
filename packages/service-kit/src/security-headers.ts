/** Headers for JSON APIs. Responses may contain PHI, so nothing is cached anywhere. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

/**
 * Headers for browser-facing BFFs (spec 12.2). The script nonce is added per HTML response when the
 * frontends are served (M1); JSON responses use this static set.
 */
export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'strict-dynamic'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
    "require-trusted-types-for 'script'",
  ].join('; '),
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'cache-control': 'no-store',
});
