<p align="center">
  <a href="https://github.com/agorail-labs"><img src="https://raw.githubusercontent.com/agorail-labs/.github/main/assets/agorail-mark.svg" width="76" alt="Agorail Labs logo"></a>
</p>

# Subscription Change Quote (SCQ)

**Quote a subscription change. Apply a separate approval policy. Execute through a durable coordinator. Reconcile what actually happened.**

[![Release candidate](https://img.shields.io/badge/release-1.0.0--rc.2-orange)](https://www.npmjs.com/package/@agorail-labs/scq-reference) [![CI](https://github.com/agorail-labs/subscription-change-quote/actions/workflows/ci.yml/badge.svg)](https://github.com/agorail-labs/subscription-change-quote/actions/workflows/ci.yml) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d)](https://github.com/agorail-labs/subscription-change-quote) [![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/agorail-labs/subscription-change-quote/blob/main/LICENSE)

Part of **[Agorail Labs](https://github.com/agorail-labs)** · [MSE companion package](https://www.npmjs.com/package/@agorail-labs/mse-reference) · [Five-minute walkthrough](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md)

> **Experimental, simulator-backed release candidate — not for production billing.** No live-provider commit is included. This is not an authorization system, a payment SDK, provider certification, or an exactly-once provider execution guarantee.

## See it in 92 seconds

<a href="https://github.com/agorail-labs/.github/blob/main/assets/demo/agorail-demo-90s.mp4"><img src="https://raw.githubusercontent.com/agorail-labs/.github/main/assets/demo/poster.png" width="680" alt="Agorail demo: an AI agent requests a subscription change, MSE checks dependencies, SCQ quotes and reconciles the simulated outcome"></a>

[Watch the narrated demo](https://github.com/agorail-labs/.github/blob/main/assets/demo/agorail-demo-90s.mp4) · [Captions and transcript](https://github.com/agorail-labs/.github/blob/main/assets/demo/TRANSCRIPT.md)

All demonstrated billing-provider behavior is simulated. The approval decision is made by separate caller code, not by SCQ or MSE.

## What problem does SCQ solve?

A request such as **"increase this subscription from 100 to 120 seats"** can create a charge or credit now, change the recurring amount, race with another update, or leave an unknown outcome if a response is lost.

SCQ gives an integrator a structured lifecycle:

```text
Read subscription → Quote change → Independent business approval
                                          |
                                Pre-dispatch envelope check
                                          |
                              Durable attempt + one dispatch
                                          |
                                Receipt + reconciliation
```

| Reported outcome | How an integrator should read it |
| :-- | :-- |
| `COMMITTED_AND_VERIFIED` + reconciliation `OK` | The **simulated** committed effect has attributable evidence and agrees with the accepted quote |
| `VIOLATED` | The established, attributable result differs from the authorized envelope |
| `UNVERIFIED` | Evidence is insufficient or attribution is broken; apparent values do not establish compliance |
| `INDETERMINATE` | Dispatch may have executed but the result is unknown; **do not blindly retry** |

Money uses integer minor units, explicit currency/cadence when established, and distinct `DETERMINED`, `UNKNOWN`, and `NOT_APPLICABLE` states. **UNKNOWN is never zero.**

## Install and run

**Node.js 22+, ESM.** Install the release candidate from `next`:

```bash
npm install --save-exact @agorail-labs/scq-reference@next
```

Run the three simulator scenarios included in the npm package:

```bash
node node_modules/@agorail-labs/scq-reference/examples/scenario-a-verified.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-b-divergence.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-c-indeterminate.mjs
```

| Scenario | What to expect |
| :-- | :-- |
| A: verified | A simulated authorized change commits and reconciles as `OK` |
| B: divergence | A demonstrably wrong result is `VIOLATED`; unattributable data remains `UNVERIFIED` |
| C: lost response | `INDETERMINATE` is fail-closed; later observation and durable replay do not blindly redispatch |

The `better-sqlite3` optional dependency supports the local durable SQLite store. If its native binding is unavailable, durable storage fails explicitly instead of silently becoming in-memory storage.

**For annotated integration guidance:** [Developer guide](https://github.com/agorail-labs/subscription-change-quote/blob/main/reference/DEVELOPER-GUIDE.md) · [Five-minute MSE + SCQ example](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md).

## Two complementary contracts

| MSE · pre-dispatch admission | SCQ · subscription lifecycle |
| :-- | :-- |
| Is the **whole proposed set** complete, including required dependent units? | What will the change cost, how strong is the quote, and what do later observations establish? |
| Returns an admission pass or refusal witness | Returns structured quotes, receipts, reconciliation, and durable replay |
| Neither checks permission nor dispatches a live provider mutation | Does not grant permission or guarantee provider-side exactly-once execution |

The combined MSE–SCQ business-intent bridge remains experimental **source-only** and is not exported by either npm package.

## Safety boundaries

- **Authorization is external.** An `acceptanceEnvelope` bounds *relative* drift from a quote; it is neither permission to act nor an absolute spending cap. Identity, entitlements, contractual rights, approval and spending limits must be checked separately.
- **Simulator-backed evidence, not live-provider certification.** Stripe-, Chargebee-, Paddle- and Zuora-shaped adapters/simulators in this package do not execute real provider commits. No Chargebee or other production provider commit was validated by this package.
- **Durability is narrower than exactly once.** `DurableQuoteStore` / `DurableMutationCoordinator` fence local attempts and replay settled receipts. They do not establish provider-side idempotency, authorization-preserving full-list writes or cross-ledger atomicity.
- **Evidence provenance matters.** The core trusts adapter classifications; it does not authenticate every provider-origin event. A state that merely looks correct does not prove that the authorized operation happened.
- **Specification and package are separate.** This package candidate implements the experimental **SCQ v0.6.2** protocol surface with enumerated source hardening. The npm version `1.0.0-rc.2` does not rename the specification or imply complete conformance. Three conformance rules remain partial in the [audit](https://github.com/agorail-labs/subscription-change-quote/blob/main/conformance/v0.6.2-traceability.md).

## Learn more / contribute

[Protocol specification](https://github.com/agorail-labs/subscription-change-quote/blob/main/spec/scq-v0.6.2-spec.md) · [API reference](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/API-REFERENCE.md) · [Security policy](https://github.com/agorail-labs/subscription-change-quote/blob/main/SECURITY.md) · [Independent evaluation package](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/STABLE-CANDIDATE-REVIEW.md) · [Report an issue](https://github.com/agorail-labs/subscription-change-quote/issues)

Independent, reproducible counterexamples are welcome. Agorail Labs is not affiliated with or endorsed by any billing provider, employer, or standards body.
