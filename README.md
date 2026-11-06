# Subscription Change Quote (SCQ)

```text
Status: Experimental protocol
Version: SCQ v0.6.2 (experimental specification)
```

**Part of [Agorail](https://github.com/agorail-labs) — safety contracts for AI-driven commerce changes.**

An AI agent is asked to increase a SaaS subscription from 100 to 120 seats. Depending on the
billing provider, that one request can mean a charge or credit now, a different future
recurring amount, a contractual consequence, a race between preview and mutation, or a
multi-change request that silently applies only part of what was asked — and if the provider
call times out after executing, the agent cannot tell whether the change happened at all.

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

## What SCQ does and does not do

**Does**

- Quotes a subscription change before mutation: immediate and recurring financial effects,
  guarantee strength per dimension, and an explicit `UNKNOWN` where an effect cannot be
  established — never an invented answer.
- Checks committed outcomes against the acceptance envelope the caller approved (drift
  relative to the quote) and reconciles receipts against independently established actuals;
  the historical receipt is immutable and later evidence is append-only.
- Provides durable replay: re-executing the same mutation intent returns the recorded receipt
  instead of dispatching the change again.

**Does not**

- **Grant authorization.** Whether a change may happen is the caller's decision; an approval
  policy lives outside the protocol (the quickstart below shows one, deliberately separate
  from SCQ's drift envelope).
- Provide exactly-once provider execution, atomic cross-provider updates, or
  production-certified billing safety.
- Cover subscription creation, payments/refunds, payment authorization, identity, delegation,
  negotiation, procurement, or usage billing.

> **Disclaimer:** SCQ is an independent research proposal and is not an official specification
> of Stripe, Paddle, Zuora, Chargebee, ACP, UCP, or any other organization.

---

## Get the package

Published experimentally on npm:
[**`@agorail-labs/scq-reference`**](https://www.npmjs.com/package/@agorail-labs/scq-reference)

```bash
npm install @agorail-labs/scq-reference@0.6.2-experimental.1
```

Node 20 or 22, ESM. The package is a simulator-backed reference implementation — not a
production billing SDK.

## Try Agorail in five minutes

[**Try Agorail in Five Minutes**](docs/TRY-AGORAIL-IN-FIVE-MINUTES.md) runs the published SCQ
and MSE packages together in a clean project — no billing credentials, no real provider:

```bash
git clone https://github.com/agorail-labs/subscription-change-quote.git
mkdir agorail-quickstart && cd agorail-quickstart
npm init -y
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
cp ../subscription-change-quote/examples/consumer/mse-plus-scq.mjs .
node mse-plus-scq.mjs
```

Expected output (verified against the published packages on Node 20.19.5 and 22.14.0; the
quote ID differs on every run):

```text
MSE gate, incomplete change: ADMISSION_REFUSED
  witness names the missing unit: addon-analytics
MSE gate, complete change: ADMISSION_PASSED
SCQ quote: scq_chargebee_af32a638dc8f757d
Quoted immediate net (minor units): 20000
Quoted recurring amount (minor units): 120000
Accepted under the example approval policy (separate from SCQ's drift envelope).
Receipt status: COMMITTED | reconciliation: OK
Provider dispatches after commit: 1
Second dispatch of the same intent: replay
Dispatch callback invocations: 0
Done: MSE admitted the complete change; SCQ committed it once; the duplicate intent replayed, not re-executed.
```

## How SCQ and MSE complement each other

[**MSE (Mutation Safety Envelope)**](https://github.com/agorail-labs/mutation-safety-envelope)
answers the question *before* SCQ: is this set of changes admissible as a whole — are all
required dependent units present? SCQ then answers the financial question: what will this
subscription change cost, how strongly is that guaranteed, and did the committed outcome stay
within what was approved? The quickstart composes the two published packages in user code;
neither package's API depends on the other, and each can be adopted independently.
MSE on npm: [`@agorail-labs/mse-reference`](https://www.npmjs.com/package/@agorail-labs/mse-reference).

## Documentation

- [Developer onboarding](docs/ONBOARDING.md) — single-package examples and outcome semantics.
- [Normative specification](spec/scq-v0.6.2-spec.md) — the SCQ v0.6.2 contract.
- [Current status and known limitations](#current-status-and-known-limitations-v062) — read
  before relying on any capability claim, together with the
  [evidence register](research/EVIDENCE.md).
- [Independent review package](docs/INDEPENDENT-MSE-SCQ-REVIEW.md) — reproduce, falsify, and
  report findings.
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

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
maintainer, PR #21). Specification publication asserts its semantics only; the experimental
reference npm package was released separately. Neither publication is a conformance
certification for a live-provider implementation or an authorization to execute subscription
changes against any provider.

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
- **G-21 residual:** independently reviewed INDETERMINATE-attempt resolution evidence is
  now persisted in the experimental reference implementation (issue #43, closed); durable
  dispatch exclusion is scoped by provider/site/subscription, failing closed whenever a
  row's namespace cannot be established (issue #45, closed). The separate
  residual investigations in issues #44 and #46 are closed.
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
- **The simulator-backed reference package is published experimentally on npm** as
  `@agorail-labs/scq-reference@0.6.2-experimental.1` (install with `@experimental`).
  This is not a production billing SDK or a validation of live-provider commit safety.

Full disclosures are in the [v0.6.2 release notes](research/v0.6.2-release-notes.md) and the
[gap register](research/v0.6.2-release-gaps.md).

## Repository structure

```text
spec/                       Normative protocol specification and security considerations
examples/                   Concrete normalized proposal/quote/receipt/failure examples
conformance/                Draft conformance suite — maps tests to normative rules
research/                   Evidence register and full multi-cycle research findings
standards/                  Fit analysis against ACP and UCP, and a discussion-draft pre-SEP
reference/                  TypeScript reference implementation and full test suite
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

New to Agorail? Start with [Try Agorail in Five Minutes](docs/TRY-AGORAIL-IN-FIVE-MINUTES.md) — the published MSE and SCQ packages composed in one clean consumer project. For SCQ alone from this repository's sources, see the [simulator-only seat-expansion walkthrough](docs/QUICKSTART.md): quote inspection, separate business spending caps, a default no-mutation path, and an explicitly simulated commit. The reference package is **published experimentally on npm**, but its adapters are not production billing SDK integrations.

For the published experimental npm package (`npm install @agorail-labs/scq-reference@experimental`), see the [developer onboarding guide](docs/ONBOARDING.md) — install, runnable consumer examples, outcome semantics, and the guarantees the package does and does not provide.


## Experimental reference package

The simulator-backed TypeScript reference package is published on npm as
`@agorail-labs/scq-reference@0.6.2-experimental.1` with ESM exports, TypeScript
declarations, and an external-consumer smoke test. It is **not** a production billing integration.

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

Compiles with `tsc` and runs the automated suite via Node's built-in test runner. No
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
