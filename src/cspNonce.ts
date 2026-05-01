import { randomBytes } from 'node:crypto';

/**
 * Cryptographically random nonce for the webview CSP `script-src 'nonce-...'`.
 * Replaces the Math.random-based ULID nonce that tripped a defense-in-depth
 * concern in the Plan 2a final review.
 */
export function cspNonce(): string {
  return randomBytes(16).toString('base64');
}
