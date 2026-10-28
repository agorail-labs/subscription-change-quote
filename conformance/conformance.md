# SCQ v0.6.1 — Draft Conformance Suite

This document maps the existing test suite (`tests/*.test.ts`, 66 executed test cases across 11
files, all passing as of the Phase 2A correction; no case in the suite is a live API test) onto
the normative rules in `scq-v0.6.1-spec.md` §6. (The unpublished combined branch adds the
experimental live adapter's 18 mocked-transport cases in `test13-chargebee-http.test.ts` —
84 cases there; test13 belongs to the pending Change B and is not executed by this change.)

> **Phase 2B note (2026-10-27):** the dated v0.6.1 errata package
> (`spec/ERRATA-v0.6.1.md`, entries ER-1…ER-4) corrects the spec's
> Chargebee factual attributions (EXACT pinning, DATE "verified-once",
> §3.1 rationale) and adds the §6.10 durability conformance note —
> factual corrections only; no MUST/MUST NOT, type, definition, or
> supported action changed, and the published spec file itself is
> unchanged in this phase (freeze-guard process documented in the
> errata package §7). The Chargebee scheduling taxonomy table in the
> errata package §6 is the canonical classification for every
> scheduling capability advertised in this repository; the §6.10
> section below carries the corresponding durability note.

> **Phase 2A note (2026-10-27):** the Chargebee rows below were updated for the
> claim corrections in `research/chargebee-live-v1/CLAIM-CORRECTION-MATRIX.md`:
> the simulator-backed Chargebee adapter now reports REVALIDATE financial
> coverage (EXACT refused), UNKNOWN termEffect at the coarse level (the one
> quote-level exception — evergreen CANCEL `termEffect` EXACT — is covered in
> §6.5/§6.9), REVALIDATE effectiveAt, and
> refuses DATE (all actions) and TERM_END (update-backed actions). Tests 11a,
> 11b, 11d, 11g, 11h, and 11j were rewritten accordingly; their pre-correction
> assertions are preserved in git history at commit 5dbb9c7. It is
a **draft** conformance suite: the tests were originally written cycle-by-cycle to validate
research hypotheses against specific providers, not authored from scratch as a conformance
matrix. This document is the first pass at treating them as one, with gaps between
"what an assertion happens to check" and "what full conformance would require" called out
explicitly rather than glossed over.

A conforming SCQ provider adapter is expected to satisfy every rule below against its own
provider. Where a rule is currently validated only against a subset of the four reference
providers, that is noted — it is a suite-coverage gap, not evidence the rule is
provider-specific.

---

## How to run

```bash
cd reference
npm ci
npm test
```

Compiles via `tsc` then runs `node --test dist/tests/*.test.js`. All 66 test cases currently
pass. There is no separate "conformance" npm script — this document is a curated view over the
same suite, not a different one.

---

## Rule → Test Mapping

### 6.1 — No mutation from `getSubscription` / `createChangeQuote`

| Provider | Test(s) |
|---|---|
| Stripe | Test 5 (Stripe), implicit in every quote-then-assert-unchanged pattern |
| Paddle | Test 5 (Paddle) |
| Zuora | Test 9c (`afterQuote.items[0].quantity` unchanged after quote) |
| Chargebee | Test 11a (`afterQuote.items[0].quantity` unchanged after quote) |

**Coverage: full (all 4 providers).**

### 6.2 — Stale-quote detection via version/fingerprint precondition

| Provider | Test |
|---|---|
| Stripe | Test 5 (Stripe): `QUOTE_STALE`, no mutation |
| Paddle | Test 5 (Paddle): `QUOTE_STALE`, no mutation |
| Zuora | Test 9h: native version field catches out-of-band order |
| Chargebee | Test 11i: content-hash fingerprint catches out-of-band mutation |

**Coverage: full (all 4 providers).**

### 6.3 — No adapter-local lock hides the TOCTOU race

| Provider | Test |
|---|---|
| Stripe, Paddle, Zuora, Chargebee | Test 7c (v0.6.1 EXTENDED): source-level check — greps ALL FOUR adapter source files for `Mutex\|Semaphore\|.lock(\|AsyncLock\|withLock` |
| Stripe | Test 7 (Stripe): demonstrates the race lands and silently clobbers |
| Paddle | Test 7 (Paddle): same |
| Zuora | Test 9i: same technique against `createOrder` |
| Chargebee | Test 11j: same technique against `updateForItems` |

**Coverage: full (all 4 providers), both for the behavioral demonstration and — as of v0.6.1 —
the source-level "no lock" grep check. This closes conformance-suite gap G-1 from the v0.6
review: Test 7c previously scanned only `stripe-adapter.ts` and `paddle-adapter.ts`; it now
scans `zuora-adapter.ts` and `chargebee-adapter.ts` too. No lock construct was found in either
file — the gap being closed was in AUTOMATED verification, not in an actual defect.**

### 6.4 — Per-dimension EXACT enforcement, naming the failing dimension

| Provider | Test |
|---|---|
| Stripe | Test 8c2 (`CHANGE_CADENCE`, fails on `termEffect` despite financial EXACT) |
| Paddle | Test 8c (`CHANGE_QUANTITY`, fails on `immediateFinancialEffect` and `termEffect`) |
| Zuora | Test 9d (`CHANGE_CADENCE`, `failingDimension: "termEffect"`) |
| Chargebee | Test 11b (`CHANGE_CADENCE`, `failingDimension: "immediateFinancialEffect"` after Phase 2A — financials are REVALIDATE, so they fail before termEffect); Test 11g (Phase 2A: committed-term and evergreen `CANCEL` EXACT requests both refuse on `immediateFinancialEffect`; termEffect UNKNOWN for committed-term is asserted on the REVALIDATE quote) |

**Phase 2A change:** Chargebee previously appeared in this row as an EXACT-capable provider
whose only EXACT-refusal was termEffect. After the correction, NO Chargebee action in the
simulator-backed adapter backs an overall EXACT request; refusals name
`immediateFinancialEffect` first. The experimental live adapter in the
unpublished Change B refuses identically in its mocked-transport tests (test13, T11);
test13 is not part of this change.

**Coverage: full (all 4 providers), including the v0.6-added committed-term CANCEL refusal.**

### 6.5 — `getCapabilities()` cannot overstate enforcement

| Provider | Test |
|---|---|
| Stripe + Paddle | Test 8h: cross-checks coarse coverage against actual EXACT enforcement for CHANGE_QUANTITY/CHANGE_CADENCE/CANCEL |
| Zuora | Test 9j: same, plus explicitly validates the CANCEL quote-level/coarse-level DIVERGENCE is intentional (Test 9e's evergreen case), not drift |
| Chargebee | Test 11h (v0.6 corrected, Phase 2A re-corrected): coarse coverage is REVALIDATE/UNKNOWN for every action; the quote-level/coarse divergence survives on the termEffect dimension alone (evergreen CANCEL `EXACT`, committed-term `UNKNOWN`) |

**Coverage: full (all 4 providers).**

### 6.6 — Receipt always carries `guaranteeMode` and `consistencyGuarantee`; old field names absent

| Provider | Test |
|---|---|
| Stripe | Test 8f: asserts presence of `quotedEffect`/`committedEffect`/`guaranteeMode`/`consistencyGuarantee`; asserts absence of `commercialEffect`/`revalidatedEffect` on the receipt type |
| Paddle | Test 8g (consistencyGuarantee only, not the full field-presence check) |
| Zuora | Test 9c, Test 9e (`committedEffect`/`quotedEffect` present and compared) |
| Chargebee | Test 11a (same pattern) |

**Coverage: the full "no old field names" negative check (Test 8f) is Stripe-only. GAP: this
negative assertion should conceptually apply to every adapter's receipt type — it currently
does because all four adapters share the same `SubscriptionChangeReceipt` type from
`types.ts` (a structural, not per-instance, guarantee), but there is no test that would catch a
hypothetical FUTURE adapter-specific receipt subtype smuggling the old field names back in.
Low-priority given the shared-type structure, noted for completeness.**

### 6.7 (v0.6, NEW) — `EffectiveIntent` validated against `supportedEffectiveIntents`

| Provider | Test |
|---|---|
| Stripe | Test 10a: `effectiveIntent: {type:"DATE"}` refused with `UNSUPPORTED_CHANGE` |
| Paddle | Test 10b: same |
| Zuora | Test 10d: `DATE` honored (native future-dating) |
| Chargebee | Test 11d (Phase 2A CORRECTED): `DATE` REFUSED, and `TERM_END` refused for update-backed actions — the previously claimed `effective_from`-on-update mechanism is not established in current docs; documented scheduling paths are deprecated toward Early-Access Ramps, which no adapter here implements. `TERM_END` remains honored for CANCEL only (separate endpoint, deprecated-but-documented, historically observed). Experimental live adapter (unpublished Change B): its mocked-transport test T14 refuses both — not part of this change. |

**Coverage: full for the DATE-refusal / DATE-acceptance split (DATE is now refused by
Stripe, Paddle, AND Chargebee, and honored only by Zuora). GAP: no test explicitly
exercises `TERM_END` being refused on a provider that doesn't support it — currently ALL four
reference providers support `TERM_END` for at least CANCEL, so there is no real provider
counter-example to test against yet. This is a suite-coverage gap caused by the reference set,
not a spec ambiguity — flagged as unresolved issue below rather than worked around with a
synthetic/fake provider (per this research's standing discipline against inventing scenarios
no real provider exhibits).**

### 6.8 (v0.6, NEW) — No silent partial execution risk

**Coverage: NONE of the four adapters can currently reach the failure mode this rule guards
against** (each either genuinely bundles atomically or refuses the combination outright via
`MultiChangeConsistency: "UNSUPPORTED"` before calling the provider — see spec §6.8). There is
therefore still no positive test that exercises `UNSUPPORTED_CHANGE_SET` actually being thrown
through a real adapter's `createChangeQuote`, because no real adapter code path constructs a
request that would trigger it — this is a property of the four reference providers' real APIs,
not a suite gap that can be closed without a fifth, synthetic provider (which remains out of
scope for v0.6.1 too, per its own "do not add providers" instruction).

**What v0.6.1 DOES close** (was G-3 / spec U-6): a direct unit test against
`enforceNoPartialExecutionRisk` in isolation — Test 12h — calls the engine function directly
with `mayPartiallyApply: true` and asserts it throws `UNSUPPORTED_CHANGE_SET` naming the at-risk
changes, and with `mayPartiallyApply: false` and asserts it does not throw. This validates the
ENGINE-level enforcement primitive works correctly, bypassing the adapters entirely, without
requiring a provider that actually exhibits the underlying silent-partial-application behavior.
Each adapter's own call site was, as before, manually verified (not via an end-to-end automated
test) to confirm `mayPartiallyApply: false` is passed only after confirming the actual call
construction cannot silently drop a change — that manual-verification gap remains and is
recorded as unresolved (see below).

### 6.9 (v0.6) — Chargebee committed-term CANCEL reports UNKNOWN, not EXACT

| Test |
|---|
| Test 11g (v0.6 CORRECTED, Phase 2A re-corrected): asserts `UNSUPPORTED_CHANGE` with `failingDimension: "immediateFinancialEffect"` on an overall EXACT request against a committed-term fixture (the financial dimensions are REVALIDATE and fail first — the refusal does NOT name `termEffect`), and, as a separate assertion, `guaranteeCoverage.termEffect === "UNKNOWN"` on a REVALIDATE quote against the same committed-term fixture |
| Test 11h (v0.6 CORRECTED): cross-checks the same across both evergreen and committed-term fixtures |

**Coverage: full — and these two tests previously asserted the OPPOSITE (that committed-term
CANCEL resolves EXACT) before this cycle's correction. Their prior form is preserved in git
history / `research-findings.md`'s per-cycle sections as the record of what was retracted and
why.**

### 6.10 (v0.6.1, NEW) — Quote expiration and commit idempotency

| Sub-rule | Test |
|---|---|
| Commit after `validUntil` fails `QUOTE_EXPIRED`, no mutation | Test 12d: direct unit test against `validateCommit` with an injected clock (adapters use real wall-clock TTL, making a real-time end-to-end test impractical) |
| Contrast: commit before `validUntil` succeeds the expiry check | Test 12e |
| Repeated commit of an already-committed quote returns the ORIGINAL receipt, no second mutation | Test 12f (Stripe): `deepEqual` of both receipts; quantity confirmed unchanged between the two commits |
| Idempotent replay succeeds even if the subscription drifted out-of-band AFTER the first commit | Test 12g (Paddle): drift injected between the two commit calls; replay still returns the original receipt unaffected |

**Durability note (errata ER-4, 2026-10-27):** §6.10's replay rule presumes a conforming
live deployment persists quote, request identity, outcome, and receipt durably, and
reconciles provider state after an indeterminate outcome before attempting any further
mutation. The reference implementation's in-memory `QuoteStore` does NOT establish the
rule across crashes — after a restart adapters fail closed (safe, but not replay
conformance); that fail-closed behavior (rather than replay) is what the experimental
live adapter's mocked-transport test demonstrates in the unpublished Change B
(test13 T13) — no test in this change executes it. Provider-native idempotency is not indefinite: Chargebee's documented native
window is 30 minutes. Nothing in this suite's passing replay tests should be read as
evidence of durable exactly-once behavior.

**Coverage: full for the engine-level mechanism (`validateCommit`'s expiry branch,
`checkIdempotentReplay`), exercised both as a direct unit test (expiration, since real-time
testing of a 5-minute TTL is impractical) and end-to-end through real adapters (idempotency,
Stripe and Paddle). GAP: idempotent replay is not separately exercised end-to-end through Zuora
or Chargebee — the underlying `checkIdempotentReplay`/`recordCommitReceipt` mechanism is
identical (shared engine/store code) across all four adapters, so this is a suite-coverage gap
analogous to G-4 below, not a known per-provider behavioral difference.**

### 6.11 (v0.6.1, NEW) — Post-commit reconciliation

| Scenario | Test |
|---|---|
| `reconcileCommittedEffect` reports OK when committed effect stays within envelope | Test 12a |
| `reconcileCommittedEffect` reports VIOLATED, naming why (BEST_EFFORT race), when it does not | Test 12b |
| `reconcileCommittedEffect` reports OK (not a fabricated violation) with no envelope | Test 12c |
| Real REVALIDATE receipts (Stripe, Paddle) carry `reconciliation: {status:"OK"}` end-to-end | Test 12k |
| Real EXACT receipt (Stripe) carries `reconciliation: {status:"OK"}` — field never omitted | Test 12l |

**Coverage: full for the engine-level function in isolation (Test 12a–12c) and for the
happy-path end-to-end wiring on Stripe/Paddle (Test 12k–12l). GAP: no test drives an ACTUAL
`{status:"VIOLATED"}` result through a real adapter's `commitChangeQuote` — doing so requires
injecting a concurrent write into the specific window between the last pre-mutation preview and
the mutating call in a way that changes the post-mutation state enough to violate the envelope
(similar in spirit to the Test 7/9i/11j TOCTOU injection technique, but targeting the
reconciliation check specifically rather than the fingerprint check). This is a suite-coverage
gap, not a known defect — Test 12b already confirms the underlying reconciliation LOGIC detects
the violation correctly in isolation.**

### 7 — Multi-change consistency (ATOMIC / BEST_EFFORT / UNSUPPORTED)

| Scenario | Test |
|---|---|
| Stripe: quantity+plan bundle, ATOMIC | Test 10e |
| Stripe: CANCEL+quantity, UNSUPPORTED, refused pre-call | Test 10f |
| Paddle: quantity+plan bundle, ATOMIC | Test 12i (v0.6.1 NEW) |
| Paddle: CANCEL+quantity, UNSUPPORTED, refused pre-call | Test 12j (v0.6.1 NEW) |
| Zuora: quantity+CANCEL bundle, ATOMIC (real capability gap vs. others) | Test 10g |
| Chargebee: quantity+plan bundle, ATOMIC | Test 11e |
| Chargebee: CANCEL+quantity, UNSUPPORTED | Test 11f |
| Single-change always trivially ATOMIC | Test 10h, and asserted inline in most single-change tests across all providers |

**Coverage: full for the ATOMIC/UNSUPPORTED split across all four providers, as of v0.6.1. This
closes conformance-suite gap G-4 from the v0.6 review — Paddle previously had no dedicated
multi-change test despite its multi-change folding logic being fixed alongside Stripe's and
Chargebee's during the v0.5 "working-items fold" bug fix.**

---

## Unresolved / Known Gaps (conformance-suite specific)

These are gaps in the SUITE's ability to detect a conformance violation, distinct from the
protocol-level unresolved issues in `scq-v0.6.1-spec.md` §9. G-1, G-3, and G-4 from the v0.6
review are CLOSED this cycle (see above); their entries are kept below, marked closed, for
continuity with the prior cycle's record.

- **G-1 (CLOSED, v0.6.1)**: Test 7c's no-adapter-lock source scan now covers all four adapters.
- **G-2 (open, unchanged)**: No test exercises `EffectiveIntent.TERM_END` being refused, because
  no reference provider currently refuses it. Still a suite-coverage gap caused by the reference
  set, not a spec ambiguity.
- **G-3 (CLOSED, v0.6.1, = spec U-6)**: `enforceNoPartialExecutionRisk`'s `UNSUPPORTED_CHANGE_SET`
  path now has a direct unit test (Test 12h) validating the engine-level primitive in isolation.
  The absence of an END-TO-END adapter test remains (see §6.8 above) — that part of the original
  gap is a property of the four real reference providers' APIs, not something closeable without
  a fifth, synthetic provider.
- **G-4 (CLOSED, v0.6.1)**: Paddle now has dedicated multi-change positive (Test 12i) and
  negative (Test 12j) tests, matching Stripe/Zuora/Chargebee.
- **G-5 (NEW, v0.6.1; partially narrowed since)**: Idempotent commit replay (§6.10) is exercised
  end-to-end through Stripe and Paddle, and — on the unpublished combined branch only —
  through the live-shaped Chargebee adapter (test13 T06, mocked transport; test13 belongs
  to the pending Change B and is not executed by this change) — but not through Zuora or
  the simulator-backed Chargebee adapter. The underlying mechanism is shared engine/store
  code identical across all adapters,
  so this remains analogous in shape to the now-closed G-4, not a known per-provider behavioral
  difference. Separately, replay's durability limit (in-memory store; restart fails closed)
  is exercised by test13 T13 in the unpublished Change B.
- **G-6 (NEW, v0.6.1)**: No test drives an actual `reconciliation: {status:"VIOLATED"}` result
  through a real adapter's end-to-end `commitChangeQuote` call (only through the isolated engine
  function, Test 12b). Doing so requires a TOCTOU-style concurrent-write injection targeting the
  specific window the reconciliation check covers, distinct from the existing TOCTOU tests
  (Test 7/9i/11j), which target the fingerprint/staleness check instead.

None of G-1 through G-6 represent a known FAILING behavior in any adapter — each closed gap
was an absence of a test that has now been added, and each still-open gap is an absence of a
positive/negative test, not a defect discovered and left unfixed. They are listed here so an
external reviewer can distinguish "this was tested and passed" from "this was asserted true in
the spec but never mechanically checked."
