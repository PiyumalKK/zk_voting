import { clientIpFrom, createLoginGuard, createRateLimiter } from "./rateLimit";
import { describe, expect, it } from "vitest";

/** A clock the tests drive by hand, so no test sleeps through a 15-minute lockout. */
const fakeClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe("createRateLimiter", () => {
  it("allows exactly `limit` requests per window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: clock.now });

    for (let i = 0; i < 5; i++) {
      expect(limiter.consume("1.2.3.4").allowed).toBe(true);
    }
    expect(limiter.consume("1.2.3.4").allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: fakeClock().now });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("starts a fresh window once the old one elapses", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });

    limiter.consume("ip");
    limiter.consume("ip");
    expect(limiter.consume("ip").allowed).toBe(false);

    clock.advance(60_000);
    expect(limiter.consume("ip").allowed).toBe(true);
  });

  it("reports how long the caller must wait", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    limiter.consume("ip");
    clock.advance(20_000);
    expect(limiter.consume("ip").retryAfterMs).toBe(40_000);
  });

  it("forgets a key on reset, so a successful login clears the count", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: fakeClock().now });
    limiter.consume("ip");
    limiter.reset("ip");
    expect(limiter.consume("ip").allowed).toBe(true);
  });
});

describe("createLoginGuard", () => {
  const options = { maxFailures: 5, lockoutMs: 15 * 60_000 };

  it("locks the account on the fifth consecutive failure", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ ...options, now: clock.now });

    for (let i = 0; i < 4; i++) {
      expect(guard.recordFailure("gn-colombo").locked).toBe(false);
    }
    expect(guard.recordFailure("gn-colombo").locked).toBe(true);
    expect(guard.status("gn-colombo").retryAfterMs).toBe(15 * 60_000);
  });

  it("releases the lock when the window expires, with a fresh failure count", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ ...options, now: clock.now });

    for (let i = 0; i < 5; i++) guard.recordFailure("gn-colombo");
    clock.advance(15 * 60_000);

    expect(guard.status("gn-colombo").locked).toBe(false);
    // One post-expiry mistake must not instantly re-lock the account.
    expect(guard.recordFailure("gn-colombo").locked).toBe(false);
  });

  it("clears the count after a successful login", () => {
    const guard = createLoginGuard({ ...options, now: fakeClock().now });

    for (let i = 0; i < 4; i++) guard.recordFailure("admin");
    guard.recordSuccess("admin");

    expect(guard.recordFailure("admin").locked).toBe(false);
  });

  it("locks accounts independently", () => {
    const guard = createLoginGuard({ ...options, now: fakeClock().now });
    for (let i = 0; i < 5; i++) guard.recordFailure("gn-colombo");

    expect(guard.status("gn-colombo").locked).toBe(true);
    expect(guard.status("gn-kandy").locked).toBe(false);
  });

  it("does not extend an existing lock on further attempts", () => {
    const clock = fakeClock();
    const guard = createLoginGuard({ ...options, now: clock.now });
    for (let i = 0; i < 5; i++) guard.recordFailure("gn-colombo");

    clock.advance(10 * 60_000);
    guard.recordFailure("gn-colombo");
    // Still the original deadline: an attacker cannot keep an officer locked
    // out indefinitely by continuing to hammer the endpoint.
    expect(guard.status("gn-colombo").retryAfterMs).toBe(5 * 60_000);
  });
});

describe("clientIpFrom", () => {
  it("takes the first hop of x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIpFrom(headers)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to a constant", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});
