# Independent technical review — MSE + SCQ (November 2026)

**Status: Review invitation package, not a completed external evaluation or endorsement.**  
**Scope: simulator-only published packages plus source-only v0.7 bridge.**
No Chargebee keys, live subscriptions, production writes, or credentials are
needed or requested. This document does not grant a reviewer repository
permissions, co-maintainer rights, compensation, or authority to represent
any vendor. Findings should be attributed only with the reviewer's consent.

## Why these are two protocols

- **MSE:** read-only admission for an interdependent set of changes, coverage,
  satisfactions, and repair witnesses. An admitted pass is not execution or
  authorization.
- **SCQ:** subscription quote, deterministic/revalidated financial effects,
  acceptance, durable dispatch boundary, immutable receipt and reconciliation.
  An SCQ VERIFIED receipt is only as strong as the established provider
  evidence, and the published implementation is **simulator-backed**.
- **Bridge:** the repository-internal experimental v0.7
  `MseScqIntentBridge` adds a durable *business-intent fence*, with a distinct
  SQLite database from SCQ's attempt ledger. It is not yet part of the npm
  consumer API. The two database commits are **not atomic together**.
- Neither project claims exactly-once execution at a billing provider.
  Chargebee Issue #30 remains an unresolved provider limitation and its
  live OPERATION-authorized mutation dispatch remains NO-GO.

## Review route A — exact published-package consumer

Node 20 or 22. Use a clean disposable directory, with no billing
credentials and **exact versions** rather than dist-tags.

```sh
git clone https://github.com/agorail-labs/subscription-change-quote.git
mkdir -p agorail-clean-consumer
cd agorail-clean-consumer
npm init -y
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
cp ../subscription-change-quote/examples/consumer/mse-plus-scq.mjs .
node mse-plus-scq.mjs
```

Expect a refusal for an incomplete seat-plus-add-on request, admission of
the complete request, a simulated SCQ quote and approved commit, and a
replayed durable receipt with no second dispatch. Do **not** interpret
that demonstration as production authorization or a live provider call.
Record your Node version, npm package versions, full console transcript,
and any unexpected behavior. This example does **not** exercise the
v0.7 bridge directly; the example itself composes public package APIs.

For independent single-package reproduction, see the respective
[SCQ onboarding](../docs/ONBOARDING.md) and
[MSE onboarding](https://github.com/agorail-labs/mutation-safety-envelope/blob/main/docs/ONBOARDING.md).

## Review route B — source-only combined-bridge counterexamples

```sh
cd subscription-change-quote/reference
npm ci
npm test
# targeted after compilation:
node --test dist/tests/test62-business-intent-bridge.test.js
node --test dist/tests/test67-mse-scq-bridge-process-kill.test.js
```

The full suite tests simulated durable SCQ execution; tests 62 and 67
specifically cover business-intent reuse, independent processes, process
kills, crash gaps and uncertain provider outcomes. On Windows, the
SIGKILL-specific test67 cases are skipped; Linux CI is authoritative for
those failure modes. Record the checked-out SCQ `git rev-parse HEAD`,
test results, platform, and any divergences.

To reproduce the **actual pinned MSE source** + SCQ bridge integration,
follow `.github/workflows/agorail-integration.yml` as executable
instructions. That workflow checks out MSE at commit
`06568ed36c1471b6825ec38e67b75ac9d6ac3956`, installs/builds both
projects, and invokes these fixtures with MSE's own `tsx`:

```sh
./mse-dependency/node_modules/.bin/tsx reference/integration/mse-scq-cross-repo.ts
./mse-dependency/node_modules/.bin/tsx reference/integration/mse-multi-unit-negative.ts
```

The fixture `mse-multi-unit-negative.ts` demonstrates mixed
APPLIED/REFUSED/INDETERMINATE outcomes, effect finality PENDING/UNKNOWN,
and reconciliation that never dispatches a retry. This is not a
multi-provider transaction implementation or a finality guarantee.

## Falsification questions (please prioritize finding counterexamples)

1. **Independent actor after preflight.** Can an authorized seat update
   overwrite a concurrent addon, same-item quantity, scheduled change,
   coupon or term even though the final items appear correct? Use the
   prior [G-17 prototype and test57](../research/G17-AUTHORIZATION-PRESERVING-PROTOTYPE.md)
   and [Cashier source audit](../research/G17-CASHIER-QUANTITY-SOURCE-AUDIT.md);
   keep DOCUMENTED vs SIMULATED vs UNKNOWN distinct.
2. **Two-ledger orphan gap.** Can an intent claim exist with no SCQ attempt,
   and can a reviewer safely distinguish “not executed” from “no record”?
   The current implementation blocks indefinitely rather than silently
   clearing the claim. Suggest *additional evidence requirements* before
   any future manual recovery rule.
3. **Same intent, new quote/key, separate process.** Can duplicate
   execution occur across two workers sharing the same SQLite files?
   Try crashing immediately before and after write-ahead, and after a
   synthetic effect but before receipt persistence.
4. **Authority and tenant boundaries.** Could an untrusted caller mint a
   second `businessIntentId`, forge an authorization reference or supply
   fabricated MSE `PASSED` evidence? The bridge intentionally delegates
   authenticating authorization and admission validation to the
   deployment. Is that boundary adequately disclosed and enforceable?
5. **Partial multi-unit outcomes.** Does any path transform a partial or
   INDETERMINATE change into globally VERIFIED, or PENDING/UNKNOWN
   downstream effects into FINAL, without sufficient evidence?
6. **Observational ambiguity.** Can an independent actor produce a
   subscription state identical to the target while the original attempt
   remains unknown? Does any receipt or reconciliation incorrectly use
   matching state as proof of this attempt's execution?

## How to return findings

Open a GitHub issue, a PR, or reply to the existing
[external-review Discussion #2](https://github.com/agorail-labs/subscription-change-quote/discussions/2)
with:

- Severity and exact invariant allegedly violated.
- Test environment, source commit(s), package version(s).
- Minimal setup, input, event interleaving, and observed output.
- Whether evidence is actual **published-package** behavior, source
  behavior, simulated provider behavior, official vendor documentation,
  or a live provider observation.
- An executable failing-first reproduction, if feasible.
- A proposed narrower claim or fix, with tests that would falsify it.

**Do not** disclose live subscription/customer identifiers, private
credentials, unpublished vendor details or employer data. A thoughtful
counterexample is more valuable here than a positive assessment without
reproduction. An unsolicited GitHub mention or an invitation alone is
not adoption; any independent review will be recorded accurately in
[the evidence tracker](../docs/ADOPTION-TRACKER.md) only after it occurs.
