// Compile fixture for the v0.6.2 PR-1 test gate (BC-5 loudness).
//
// This file is NOT part of the package build (it lives outside the
// tsconfig include set) and it is EXPECTED TO FAIL COMPILATION.
// It is a v0.6.1-shaped consumer: an exhaustive switch over
// ReconciliationResult that handles only the two v0.6.1 variants
// and relies on an assertNever default to prove exhaustiveness.
// Against the v0.6.2 union (which adds UNVERIFIED), the default
// branch's argument is no longer `never`, so tsc rejects the call
// — the intended loud failure: an unverified commit can never be
// silently misclassified by an exhaustive consumer that predates
// the variant. test14 compiles this fixture programmatically and
// asserts that the failure names UNVERIFIED.

import type { ReconciliationResult } from "../src/core/types.js";

function assertNever(x: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(x)}`);
}

export function describeReconciliation(result: ReconciliationResult): string {
  switch (result.status) {
    case "OK":
      return "verified within envelope";
    case "VIOLATED":
      return `verified outside envelope: ${result.reason}`;
    default:
      return assertNever(result);
  }
}
