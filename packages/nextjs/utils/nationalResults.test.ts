import { aggregateNationalResults, candidateKey } from "./nationalResults";
import { describe, expect, it } from "vitest";

/**
 * The national tally is the number the public sees, so the cases that matter
 * are the ones where divisions do NOT agree on the ballot — index-based
 * aggregation silently mixed those up.
 */

describe("aggregateNationalResults", () => {
  it("sums by name when a division lists the same candidates in a different order", () => {
    const totals = aggregateNationalResults([
      { candidates: ["Alice", "Bob"], counts: [10, 3], treeSize: 20 },
      { candidates: ["Bob", "Alice"], counts: [7, 5], treeSize: 20 },
    ]);

    expect(totals.candidates).toEqual([
      { name: "Alice", votes: 15, divisions: 2 },
      { name: "Bob", votes: 10, divisions: 2 },
    ]);
    expect(totals.ballotsDiverge).toBe(false);
  });

  it("keeps a candidate who only stands in some divisions separate from the rest", () => {
    const totals = aggregateNationalResults([
      { candidates: ["Alice", "Bob"], counts: [10, 3], treeSize: 20 },
      { candidates: ["Alice", "Carol"], counts: [4, 9], treeSize: 20 },
    ]);

    expect(totals.candidates).toEqual([
      { name: "Alice", votes: 14, divisions: 2 },
      { name: "Bob", votes: 3, divisions: 1 },
      { name: "Carol", votes: 9, divisions: 1 },
    ]);
    // Carol's 9 votes must never land on Bob just because both sit at index 1.
    expect(totals.ballotsDiverge).toBe(true);
  });

  it("treats hand-typed spelling differences as one candidate, displaying the first spelling", () => {
    const totals = aggregateNationalResults([
      { candidates: ["Alice Perera"], counts: [10], treeSize: 20 },
      { candidates: ["  alice   perera "], counts: [5], treeSize: 20 },
    ]);

    expect(totals.candidates).toEqual([{ name: "Alice Perera", votes: 15, divisions: 2 }]);
    expect(totals.ballotsDiverge).toBe(false);
  });

  it("adds turnout across every division, including ones with no ballot yet", () => {
    const totals = aggregateNationalResults([
      { candidates: ["Alice"], counts: [10], treeSize: 30 },
      { candidates: [], counts: [], treeSize: 12 },
    ]);

    expect(totals.totalVotes).toBe(10);
    expect(totals.totalRegistered).toBe(42);
    // An unconfigured division is not a disagreement about the ballot.
    expect(totals.ballotsDiverge).toBe(false);
  });

  it("keeps per-candidate votes adding up to the national total", () => {
    const totals = aggregateNationalResults([
      { candidates: ["Alice", "Bob"], counts: [10, 3], treeSize: 20 },
      { candidates: ["Carol"], counts: [9], treeSize: 20 },
    ]);

    const summed = totals.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    expect(summed).toBe(totals.totalVotes);
  });

  it("ignores a stray count that has no candidate to attribute it to", () => {
    const totals = aggregateNationalResults([{ candidates: ["Alice"], counts: [10, 4], treeSize: 20 }]);

    expect(totals.totalVotes).toBe(10);
    expect(totals.candidates).toEqual([{ name: "Alice", votes: 10, divisions: 1 }]);
  });

  it("treats a missing count as zero rather than NaN", () => {
    const totals = aggregateNationalResults([{ candidates: ["Alice", "Bob"], counts: [10], treeSize: 20 }]);

    expect(totals.candidates).toEqual([
      { name: "Alice", votes: 10, divisions: 1 },
      { name: "Bob", votes: 0, divisions: 1 },
    ]);
    expect(totals.totalVotes).toBe(10);
  });

  it("counts a duplicated name within one division once, but keeps both tallies", () => {
    const totals = aggregateNationalResults([{ candidates: ["Alice", "Alice"], counts: [10, 4], treeSize: 20 }]);

    expect(totals.candidates).toEqual([{ name: "Alice", votes: 14, divisions: 1 }]);
  });

  it("returns empty totals for no divisions", () => {
    expect(aggregateNationalResults([])).toEqual({
      candidates: [],
      totalVotes: 0,
      totalRegistered: 0,
      ballotsDiverge: false,
    });
  });
});

describe("candidateKey", () => {
  it("normalises case and internal whitespace", () => {
    expect(candidateKey("  Alice   Perera ")).toBe("alice perera");
  });

  it("keeps genuinely different names apart", () => {
    expect(candidateKey("Alice Perera")).not.toBe(candidateKey("Alicia Perera"));
  });
});
