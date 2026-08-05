/**
 * Fixed-window rate limiting and login lockout (M12).
 *
 * Both are process-local, exactly like the limiter already in
 * `app/api/nic/hash/route.ts`. That is correct for the single-server
 * deployment this system targets and wrong for a multi-instance one, where
 * counters must move to Redis/KV — see the TODO on {@link createRateLimiter}.
 *
 * Everything here takes an injectable clock so the tests can advance time
 * instead of sleeping through 15-minute lockout windows.
 */

export type Clock = () => number;

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window (0 once blocked). */
  remaining: number;
  /** Milliseconds until the window resets — the `Retry-After` value. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Maximum requests permitted per window. */
  limit: number;
  windowMs: number;
  now?: Clock;
}

interface Window {
  count: number;
  startedAt: number;
}

export interface RateLimiter {
  /** Records one attempt for `key` and reports whether it is permitted. */
  consume: (key: string) => RateLimitDecision;
  reset: (key: string) => void;
}

/**
 * A fixed-window counter.
 *
 * Fixed windows admit a burst of up to `2 × limit` across a window boundary.
 * For login (5/min) and relay (30/min) that is immaterial — both exist to stop
 * scripted abuse, not to shape traffic — and the alternative (sliding log)
 * costs memory per request for no benefit at this scale.
 *
 * TODO: move to Redis/KV before any multi-instance deployment; per-process
 * counters do not compose behind a load balancer.
 */
export const createRateLimiter = ({ limit, windowMs, now = Date.now }: RateLimiterOptions): RateLimiter => {
  const windows = new Map<string, Window>();

  /** Drops expired entries so a long-lived process does not accumulate keys. */
  const sweep = (currentTime: number) => {
    for (const [key, window] of windows) {
      if (currentTime - window.startedAt >= windowMs) windows.delete(key);
    }
  };

  return {
    consume(key) {
      const currentTime = now();
      if (windows.size > 1000) sweep(currentTime);
      const window = windows.get(key);
      if (!window || currentTime - window.startedAt >= windowMs) {
        windows.set(key, { count: 1, startedAt: currentTime });
        return { allowed: true, remaining: limit - 1, retryAfterMs: windowMs };
      }
      window.count += 1;
      const elapsed = currentTime - window.startedAt;
      return {
        allowed: window.count <= limit,
        remaining: Math.max(0, limit - window.count),
        retryAfterMs: Math.max(0, windowMs - elapsed),
      };
    },
    reset(key) {
      windows.delete(key);
    },
  };
};

export interface LoginGuardOptions {
  /** Consecutive failures before the account locks. */
  maxFailures: number;
  lockoutMs: number;
  now?: Clock;
}

export interface LockStatus {
  locked: boolean;
  /** Milliseconds until the lock expires; 0 when unlocked. */
  retryAfterMs: number;
}

export interface LoginGuard {
  status: (key: string) => LockStatus;
  /** Records a failure and returns the resulting lock status. */
  recordFailure: (key: string) => LockStatus;
  /** Clears the failure count after a successful login. */
  recordSuccess: (key: string) => void;
}

/**
 * Per-username lockout after repeated failures (`01-AUTH-DESIGN.md` §6: 5
 * failures → 15 minutes).
 *
 * Keyed by username rather than IP so an attacker rotating source addresses
 * still cannot grind a single account, at the cost of letting one attacker
 * lock a known officer out for 15 minutes. That trade is the right one here:
 * the officer has a physical fallback (the admin can re-issue credentials),
 * whereas a successful credential grind hands over a signing key.
 */
export const createLoginGuard = ({ maxFailures, lockoutMs, now = Date.now }: LoginGuardOptions): LoginGuard => {
  const failures = new Map<string, { count: number; lockedUntil: number }>();

  const statusFor = (key: string): LockStatus => {
    const record = failures.get(key);
    if (!record) return { locked: false, retryAfterMs: 0 };
    const remaining = record.lockedUntil - now();
    if (remaining <= 0) {
      // Lock expired: forget the failures too, so the next mistake starts a
      // fresh count rather than instantly re-locking the account.
      if (record.lockedUntil > 0) failures.delete(key);
      return { locked: false, retryAfterMs: 0 };
    }
    return { locked: true, retryAfterMs: remaining };
  };

  return {
    status: statusFor,
    recordFailure(key) {
      const current = statusFor(key);
      if (current.locked) return current;
      const record = failures.get(key) ?? { count: 0, lockedUntil: 0 };
      record.count += 1;
      if (record.count >= maxFailures) record.lockedUntil = now() + lockoutMs;
      failures.set(key, record);
      return statusFor(key);
    },
    recordSuccess(key) {
      failures.delete(key);
    },
  };
};

/**
 * Process-wide limiter and guard instances, keyed by name.
 *
 * Route handler modules are re-evaluated on every hot reload in dev, which
 * would otherwise reset counters and make the lockout impossible to test by
 * hand. Stashing them on `globalThis` survives that, and matches the existing
 * pattern in `app/api/nic/hash/route.ts`.
 */
type LimiterBag = typeof globalThis & {
  __slVoteLimiters?: Map<string, RateLimiter>;
  __slVoteGuards?: Map<string, LoginGuard>;
};

export const sharedRateLimiter = (name: string, options: RateLimiterOptions): RateLimiter => {
  const bag = globalThis as LimiterBag;
  bag.__slVoteLimiters ??= new Map();
  const existing = bag.__slVoteLimiters.get(name);
  if (existing) return existing;
  const created = createRateLimiter(options);
  bag.__slVoteLimiters.set(name, created);
  return created;
};

export const sharedLoginGuard = (name: string, options: LoginGuardOptions): LoginGuard => {
  const bag = globalThis as LimiterBag;
  bag.__slVoteGuards ??= new Map();
  const existing = bag.__slVoteGuards.get(name);
  if (existing) return existing;
  const created = createLoginGuard(options);
  bag.__slVoteGuards.set(name, created);
  return created;
};

/**
 * Best-effort client IP for rate-limit keys.
 *
 * Behind a proxy, `x-forwarded-for` is the only source available; it is
 * spoofable when the app is exposed directly, which is why IP limits here back
 * up the per-username lockout rather than standing alone.
 */
export const clientIpFrom = (headers: Headers): string => {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
};
