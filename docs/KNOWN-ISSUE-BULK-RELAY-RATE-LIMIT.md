# Known issue: bulk "apply to all divisions" mis-reports rate-limited rows

**Status:** Not fixed. Documented here so it isn't lost.

## What happens

Admin → Ballot → "Apply question/candidates to all N divisions" sends one
`POST /api/relay` call per division, sequentially. `/api/relay` rate-limits
each admin session to **30 calls per minute** (`app/api/relay/route.ts`,
`RELAY_RATE_LIMIT`) — a deliberate throttle, unrelated to this bug.

Past the first ~30 divisions in any given minute, every further call gets a
`429`. The client loop (`runAll` in `AdminElectionProvider.tsx`) catches
*any* failure the same way:

```ts
try {
  await writeToDivision(d.votingContract, functionName, args);
  ok += 1;
} catch {
  skipped += 1; // wrong phase for this division — skip it
}
```

So a `429` (rate limited) and a real `Voting__WrongPhase` revert (division
already past Setup) both land in the same `skipped` bucket, and the final
toast — `"Applied on X division(s) · Y skipped (wrong phase)"` — reports the
429s as "wrong phase" even though the division was perfectly eligible and
just never got tried again.

## Impact

For a small number of divisions this never triggers (well under 30 calls).
For hundreds or thousands (e.g. the 1000+ division bulk-import test), most
rows will be genuinely rate-limited rather than skipped for being in the
wrong phase, and the operator has no way to tell the two apart from the UI —
or to know which specific divisions still need the question applied.

## Why it wasn't fixed here

Fixing it properly means either the client backing off and retrying on
`429` (using the `Retry-After` header already returned), or `runAll`
tracking rate-limited rows separately from phase-mismatch rows and
reporting each accurately. Both are client-side behavior changes to a
working flow, not a bounded bug fix — riskier to make under time pressure
than the fixes already applied this session.

## Related, already fixed

The `/api/relay` handler used to re-derive the *entire* division list (with
a live on-chain read per division) on every single call — O(N²) reads for an
N-division broadcast, which is what actually overwhelmed the chain and made
the whole app unresponsive. That's fixed (a short cache in
`services/auth/relayContracts.ts`'s `loadDivisions()`). This document is
about a separate, smaller correctness issue: an accurate count, not a
crash.

## Suggested fix (for later)

In `runAll` (`AdminElectionProvider.tsx`), distinguish a `429` response from
a normal revert — `writeToDivision`/`write` would need to surface the HTTP
status or a typed error, not just throw. On a `429`, either:

- wait for `Retry-After` and retry that division before moving on, or
- keep a `rateLimited` count separate from `skipped` and report both, so the
  operator at least knows the true reason and can re-run the broadcast to
  pick up the rest.
