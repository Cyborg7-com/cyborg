// Shared email helpers for the invite/auth flows.
//
// Pragmatic, intentionally NOT RFC-5322-complete: the goal is to reject obvious
// junk before it becomes a row that can never receive mail — a comma from a
// multi-address paste ("user@gmail.com,"), stray whitespace, or a missing
// @/TLD. The invite handler stored `luischavezc2024@gmail.com,` once because it
// did no validation at all; this stops that class of bad data at the door.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Trim surrounding whitespace and lowercase — matches the auth/register path so
 *  the same address dedups consistently across signup and invite. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True only for a single, well-formed address. Rejects commas, spaces, and a
 *  missing local-part / domain / TLD. Expects an already-normalized value. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}
