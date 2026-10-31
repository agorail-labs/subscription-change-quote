# Subscription Change Quote (SCQ)

```text
Status: Experimental protocol
Version: SCQ v0.6.2 (experimental specification)
```

SCQ is a protocol-neutral contract for making changes to an **existing subscription** —
quantity, plan, cadence, or cancellation — safely enough for autonomous agents to reason about
and execute across heterogeneous billing systems (Stripe-, Paddle-, Zuora-, and
Chargebee-shaped APIs, in this research).

It standardizes one lifecycle:

```text
SubscriptionSnapshot -> SubscriptionChangeProposal -> SubscriptionChangeQuote
                      -> commit -> SubscriptionChangeReceipt
```

SCQ does not try to make billing providers behave identically. It makes their differences in
price certainty, term consequences, effective timing, batching, and concurrency
**machine-readable** — so a caller can quote a change, evaluate its guaranteed strength against
an explicit tolerance envelope, commit it, and receive a receipt that honestly distinguishes
what was quoted from what actually happened.

> **Disclaimer:** SCQ is an independent research proposal and is not an official specification
> of Stripe, Paddle, Zuora, Chargebee, ACP, UCP, or any other organization.

---

## Why this exists

A request as simple as "increase this workspace from 100 to 120 seats" can have materially
different consequences depending on the billing provider: a charge or credit now, a different
future recurring amount, a contractual consequence, a race between preview and mutation, or a
multi-change request that silently applies only part of what was asked. SCQ gives a caller a
single, honest vocabulary for asking, before mutation: *what will this do, how strongly is that
guaranteed, and did the committed outcome actually stay within what I approved?*

SCQ is explicitly **not** a protocol for subscription creation, payments/refunds, payment
authorization, identity, delegation, negotiation, procurement, or usage billing.

## Frozen scope (v0.6.1)

Four change actions only:

```text
CHANGE_QUANTITY
CHANGE_PLAN
CHANGE_CADENCE
CANCEL
```

v0.6.1 is a **standards-hardening cycle** over the v0.6 protocol freeze candidate — no
providers, actions, or major schema concepts were added. It narrows EXACT's semantics, requires
post-commit reconciliation, and makes quote expiration and commit idempotency explicit
normative rules. See [`spec/scq-v0.6.1-spec.md`](spec/scq-v0.6.1-spec.md) for the full
normative diff from v0.6. The same frozen scope carries into v0.6.2 unchanged — v0.6.2 is a
semantics cycle and adds no providers, actions, or guarantee modes.

## Evidence levels — read this before trusting any capability claim

This research explicitly separates what was **observed against a real provider** from what was
**modeled in a simulator**. Only one provider (Chargebee) has any live API observations in
this project, and they come in two distinct kinds that must not be conflated:

- **Limited historical observations** — a prior research cycle (v0.5-LIVE, Experiments 1–2)
  observed a real Chargebee test site directly. Those observations are historical evidence
  about the provider, not validation of any adapter in this repository.
- **Live-validated retrieval and quote generation (Phase 3/4, 2026-10-27/28)** — the
  experimental Chargebee live adapter in this repository was exercised end-to-end against a
  real Chargebee **test site**: subscription retrieval (**L-GET: LIVE_PASS**) and SCQ quote
  generation from non-mutating update estimates (**L-QUOTE: LIVE_PASS**), including
  live-verified refusal of quantity changes on `flat_fee` items. **Live commit has NOT been
  validated (L-COMMIT: BLOCKED)** — the commit path is mock-tested only and is disabled by
  default. See `research/chargebee-live-v1/evidence/PHASE3-EVIDENCE-SUMMARY.md` and
  `research/chargebee-live-v1/TEST-RESULTS.md` for the full record.

See `research/EVIDENCE.md` for exactly what was and was not observed.

```text
LIVE_API_VALIDATED           — observed against a real provider test-site API
DOCUMENTATION_BACKED_SIMULATION — implemented per documented provider mechanisms and
                                   tested against SCQ, but not exercised live
INFERRED                     — architectural conclusion derived from documented/observed
                                   behavior, not directly exercised end-to-end
UNVERIFIED                   — intentionally left open; SCQ reports UNKNOWN rather than
                                   inventing an answer
```

| Provider | Evidence level |
|---|---|
| **Chargebee** | **Limited historical live test-site observations** (prior cycle), plus simulator; **plus live-validated retrieval and quote generation** via the experimental live adapter (Phase 3/4, test site) — live commit **not** validated |
| Stripe | Documentation-backed simulation only |
| Paddle | Documentation-backed simulation only |
| Zuora | Documentation-backed simulation only |

**Stripe, Paddle, and Zuora were never live-tested in this research.** Do not read any claim in
this repository as implying otherwise. Full detail, including exactly which Chargebee findings
are live-confirmed versus simulated, is in [`research/EVIDENCE.md`](research/EVIDENCE.md).

## Current status and known limitations (v0.6.2)

SCQ v0.6.2 is published as an **experimental** normative specification (ratified by the
maintainer, PR #21). Publication asserts the specification's semantics only. It is **not** a
conformance certification for any implementation, **not** a release of the reference package,
and **not** an authorization to execute subscription changes against any provider.

- **Three conformance rows are PARTIAL** (of 75 rules; see
  [`conformance/v0.6.2-traceability.md`](conformance/v0.6.2-traceability.md)): snapshot
  determinacy is emitted but consumed by no enforcement path (V62-DET-08, G-07); the core
  trusts adapter-established EXACT source classification and does not independently
  authenticate provider events (V62-EVD-01, G-01 — a forged-label contradiction against the
  record's own figures is now refused, but observation origin is not authenticated); and
  three state-establishment paths remain adapter-owned rather than consuming the shared
  verification hook (V62-SV-02, G-08 — the Chargebee-simulator update path was migrated to
  the hook; Chargebee-simulator cancel, Paddle cancel, and Zuora remain adapter-owned).
- **G-09 is closed** — the inherited v0.6.1 test-path gaps are closed at simulation level
  (PR #36).
- **G-20:** the research suite stands at 11 pass / 7 fail **by design** — seven harnesses
  are refused pre-dispatch by the authorization-preservation gate. Their intended properties
  are accounted for by converted regression evidence (test47, test49, test50, test55).
- **G-21 remains open:** durable-recovery limitations include INDETERMINATE-attempt
  resolution evidence not being persisted (issue #43, P0) and dispatch exclusion not scoped
  by provider/site (issue #45); issues #44 and #46 track further residuals.
- **G-17:** the Chargebee live adapter's only update mechanism is full-list replacement
  (`FULL_REPLACEMENT_ONLY`), so OPERATION-authorized updates are **refused before dispatch**
  (`AUTHORIZATION_PRESERVATION_UNENFORCEABLE`). The G-17 mechanism research and prototype
  (PR #38) are **mock-only** — not a live Chargebee mutation capability; no documented
  conditional write exists. A Chargebee test-site commit remains **NO-GO** (issue #12).
- **No complete independent provider-backed commit validation exists.** No live
  provider-backed commit has ever been executed; the evidence classes above (simulated
  tests, provider documentation, historical live read/quote observations) remain distinct.
- **No production certification, no provider endorsement, and no blanket
  implementation-conformance claim** is made by this publication.
- **The reference package is not published to npm.** `reference/package.json` remains
  `private: true` with v0.6.1-asserting metadata, unchanged; package release is a separate
  gated decision (currently NO-GO).

Full disclosures are in the [v0.6.2 release notes](research/v0.6.2-release-notes.md) and the
[gap register](research/v0.6.2-release-gaps.md).

## Repository structure

```text
spec/                       Normative protocol specification and security considerations
examples/                   Concrete normalized proposal/quote/receipt/failure examples
conformance/                Draft conformance suite — maps tests to normative rules
research/                   Evidence register and full multi-cycle research findings
standards/                  Fit analysis against ACP and UCP, and a discussion-draft pre-SEP
reference/                  TypeScript reference implementation and full test suite (803 tests)
```

- [`spec/scq-v0.6.2-spec.md`](spec/scq-v0.6.2-spec.md) — **current standard:** the normative
  specification, published as an experimental specification. Start here for the actual
  protocol.
- [`spec/scq-v0.6.1-spec.md`](spec/scq-v0.6.1-spec.md) — the previous specification, retained
  unchanged.
- [`research/v0.6.2-migration-guide.md`](research/v0.6.2-migration-guide.md) — the adopter
  migration path from v0.6.1 (BC-1…BC-6 breaking changes and fail-closed behaviour).
- [`research/v0.6.2-release-notes.md`](research/v0.6.2-release-notes.md) — the v0.6.2 release
  notes, including the known-limitations disclosures.
- [`conformance/v0.6.2-traceability.md`](conformance/v0.6.2-traceability.md) — clause-by-clause
  mapping of the 75 v0.6.2 rules to implementation and tests, including the three PARTIAL
  rows.
- [`spec/security-considerations.md`](spec/security-considerations.md) — threat model: TOCTOU,
  stale quotes, replay, envelope bypass, silent partial execution, malicious adapters, and more.
- [`examples/SCQ-EXAMPLES.md`](examples/SCQ-EXAMPLES.md) — worked proposal/quote/receipt
  examples, including `QUOTE_DRIFTED`, `UNSUPPORTED_CHANGE_SET`, and a reconciliation failure.
- [`conformance/conformance.md`](conformance/conformance.md) — maps every normative rule to the
  specific test(s) that validate it, and honestly lists suite-coverage gaps.
- [`research/EVIDENCE.md`](research/EVIDENCE.md) — the evidence register described above.
- [`research/research-findings.md`](research/research-findings.md) — the full multi-cycle
  research log (v0.1 through v0.6.1), including rejected designs and retracted claims.
- [`standards/`](standards/) — fit analysis against the Agentic Commerce Protocol (ACP) and
  Universal Commerce Protocol (UCP), a recommended publication path, and a **discussion-draft**
  ACP pre-SEP write-up (see note below).
- [`reference/`](reference/) — the TypeScript reference implementation (provider-neutral core
  types and engine, plus four simulator-backed reference adapters and the experimental
  Chargebee live adapter) and its full test suite.

## About `standards/ACP-PRE-SEP.md`

This document is a **discussion draft for community/maintainer feedback**, not a formal,
accepted Standards Enhancement Proposal (SEP). It has not been submitted to or endorsed by the
Agentic Commerce Protocol project. It exists to ask two open questions — does this problem
belong in ACP's scope, and if so, what shape should a formal proposal take — not to assert that
ACP has adopted or will adopt SCQ.

## Developer quickstart

For v0.6.2's scope and known limitations, see the [release notes](research/v0.6.2-release-notes.md). (The v0.6.1-era [preview notes](docs/EXPERIMENTAL-PREVIEW.md) are retained as a superseded historical record.) For responsible vulnerability reporting, see [Security](SECURITY.md).

Start with the [simulator-only seat-expansion walkthrough](docs/QUICKSTART.md). It shows quote inspection, separate business spending caps, a default no-mutation path, and an explicitly simulated commit. The reference project is **not yet published as an npm package** and its adapters are not production billing SDK integrations.


## Experimental reference package

The simulator-backed TypeScript reference package includes ESM exports, TypeScript declarations, and an external-consumer smoke test. It is not a production billing integration and is not published to npm.

```bash
cd reference
npm ci
npm run smoke:pack
```

## Running the reference implementation

```bash
cd reference
npm install
npm test
```

Compiles with `tsc` and runs the full suite (803 tests) via Node's built-in test runner. No
external test framework dependency.

## Community and feedback

SCQ v0.6.2 is open for **external technical review**, not yet a production-ready billing SDK or an adopted industry standard.

- [GitHub Issues](../../issues) — reproducible bugs, specification inconsistencies, documentation corrections, or conformance gaps.
- [GitHub Discussions](../../discussions) — integration questions, architectural tradeoffs, evidence requests, and feedback on possible future extensions. (Discussions is enabled on the public repository.)
- [Contribution guidelines](CONTRIBUTING.md) — how to document observations and distinguish live API evidence from simulator results.
- [Security policy](SECURITY.md) — how to report security-sensitive concerns privately.

Please avoid posting customer data, secrets, or real billing account information. A live-provider claim needs suitably redacted supporting evidence.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
