# Subscription Change Quote (SCQ)

```text
Status: Experimental protocol / external review candidate
Version: SCQ v0.6.1
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
normative diff from v0.6.

## Evidence levels — read this before trusting any capability claim

This research explicitly separates what was **observed against a real provider** from what was
**modeled in a simulator**. Only one provider received live API validation in this project.

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
| **Chargebee** | **Live test-site API validation**, plus simulator |
| Stripe | Documentation-backed simulation only |
| Paddle | Documentation-backed simulation only |
| Zuora | Documentation-backed simulation only |

**Stripe, Paddle, and Zuora were never live-tested in this research.** Do not read any claim in
this repository as implying otherwise. Full detail, including exactly which Chargebee findings
are live-confirmed versus simulated, is in [`research/EVIDENCE.md`](research/EVIDENCE.md).

## Repository structure

```text
spec/                       Normative protocol specification and security considerations
examples/                   Concrete normalized proposal/quote/receipt/failure examples
conformance/                Draft conformance suite — maps tests to normative rules
research/                   Evidence register and full multi-cycle research findings
standards/                  Fit analysis against ACP and UCP, and a discussion-draft pre-SEP
reference/                  TypeScript reference implementation and full test suite (66 tests)
```

- [`spec/scq-v0.6.1-spec.md`](spec/scq-v0.6.1-spec.md) — the normative specification. Start here
  for the actual protocol.
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
  types and engine, plus four reference adapters) and its full test suite.

## About `standards/ACP-PRE-SEP.md`

This document is a **discussion draft for community/maintainer feedback**, not a formal,
accepted Standards Enhancement Proposal (SEP). It has not been submitted to or endorsed by the
Agentic Commerce Protocol project. It exists to ask two open questions — does this problem
belong in ACP's scope, and if so, what shape should a formal proposal take — not to assert that
ACP has adopted or will adopt SCQ.

## Developer quickstart

For the planned experimental preview's actual scope and limitations, see [preview notes](docs/EXPERIMENTAL-PREVIEW.md). For responsible vulnerability reporting, see [Security](SECURITY.md).

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

Compiles with `tsc` and runs the full suite (66 tests) via Node's built-in test runner. No
external test framework dependency.

## Community and feedback

SCQ v0.6.1 is open for **external technical review**, not yet a production-ready billing SDK or an adopted industry standard.

- [GitHub Issues](../../issues) — reproducible bugs, specification inconsistencies, documentation corrections, or conformance gaps.
- [GitHub Discussions](../../discussions) *(once enabled)* — integration questions, architectural tradeoffs, evidence requests, and feedback on possible future extensions.
- [Contribution guidelines](CONTRIBUTING.md) — how to document observations and distinguish live API evidence from simulator results.
- [Security policy](SECURITY.md) — how to report security-sensitive concerns privately.

Please avoid posting customer data, secrets, or real billing account information. A live-provider claim needs suitably redacted supporting evidence.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
