/**
 * Post-login redirect safety.
 *
 * The middleware appends `?next=<pathname>` when it bounces an unauthenticated
 * operator to `/login`, and the login page sends them there afterwards. That
 * makes `next` an attacker-controllable redirect target: a link to
 * `/login?next=https://evil.example/` would otherwise take an admin straight
 * off-site immediately after they typed their password — the classic setup for
 * a convincing credential-replay page.
 *
 * So the value is accepted only when it is unambiguously a path on this origin.
 */

/** Rejected outright: protocol-relative (`//host`), backslash variants, and anything with a scheme. */
const looksAbsolute = (value: string): boolean =>
  value.startsWith("//") ||
  value.startsWith("/\\") ||
  value.startsWith("\\") ||
  /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);

/**
 * A control character or raw newline in a redirect target is never legitimate,
 * and is how header-splitting tricks get through. Checked by code point rather
 * than a regex so the guard survives any source re-encoding.
 */
const hasControlCharacter = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

export const safeNextPath = (raw: string | null | undefined, fallback: string): string => {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (looksAbsolute(value)) return fallback;
  if (hasControlCharacter(value)) return fallback;
  return value;
};
