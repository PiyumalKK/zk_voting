/**
 * Rules for a password an officer chooses for themselves.
 *
 * A separate module from `accounts.ts` on purpose: that file imports `node:fs`
 * and bcrypt, so a client component asking "how long must my password be?"
 * would drag the whole account store — and its crypto — into the browser
 * bundle. Everything here is pure, which is what lets the change-password form
 * and the route that enforces it share one definition instead of two that
 * quietly drift apart.
 */

/**
 * Minimum length for an officer-chosen password.
 *
 * Length alone, with no composition rules: NIST SP 800-63B dropped the
 * character-class requirements because they push people towards `Password1!`
 * without adding real entropy. The generated password this replaces is 20
 * characters, so 12 is a floor for what a human types, not a target.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Upper bound.
 *
 * bcrypt only reads the first 72 bytes, so nothing above that adds strength,
 * and a cap stops a multi-megabyte body from turning one request into a long
 * CPU burn at cost factor 12.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Validates a candidate password.
 *
 * Returns the problem as a sentence, or `null` when it is acceptable — the
 * route sends the string straight back to the form, so each one is written to
 * be read by the officer standing at the screen.
 */
export const passwordProblem = (password: unknown): string | null => {
  if (typeof password !== "string" || password.length === 0) return "Enter a new password.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Your password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim().length !== password.length) {
    // Leading and trailing spaces survive into the hash and are invisible when
    // retyped — a password that fails to work for a reason nobody can see.
    return "Your password must not start or end with a space.";
  }
  return null;
};
