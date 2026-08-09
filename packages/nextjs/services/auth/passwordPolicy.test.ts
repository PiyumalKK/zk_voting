import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "./passwordPolicy";
import { describe, expect, it } from "vitest";

/**
 * The rules an officer's own password must satisfy.
 *
 * Pure by design — the change-password form and the route that enforces it both
 * import this, so a rule that held in one and not the other would show up as a
 * form that accepts a password the server then rejects.
 */

describe("passwordProblem", () => {
  it("accepts an ordinary passphrase", () => {
    expect(passwordProblem("correct horse battery")).toBeNull();
  });

  it("rejects anything missing or not a string", () => {
    expect(passwordProblem("")).toMatch(/enter a new password/i);
    expect(passwordProblem(undefined)).toMatch(/enter a new password/i);
    // A JSON body can carry any type; the route hands it straight here.
    expect(passwordProblem(12345678901234)).toMatch(/enter a new password/i);
    expect(passwordProblem({ toString: () => "long-enough-password" })).toMatch(/enter a new password/i);
  });

  it("enforces the length floor", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least 12/);
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("caps the length so one request cannot become a long bcrypt burn", () => {
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
  });

  it("rejects leading or trailing spaces", () => {
    // These survive into the hash and are invisible when retyped, so the
    // password stops working for a reason the officer cannot see.
    expect(passwordProblem(" leading-space-here")).toMatch(/space/);
    expect(passwordProblem("trailing-space-here ")).toMatch(/space/);
    // Spaces *inside* a passphrase are fine and should stay that way.
    expect(passwordProblem("spaces in the middle are fine")).toBeNull();
  });
});
