# API Reference — @agorail-labs/scq-reference (stable-core candidate)

This reference covers the **proposed stable core** defined in
`docs/STABLE-RELEASE-READINESS.md` §2. Until a 1.0 release is
approved, the published artifact remains
`0.6.2-experimental.1` and this reference describes the contract the
candidate is qualified against (see `docs/API-INVENTORY.md` for the
full export list and classifications).

## The lifecycle

```
snapshot ──► proposal ──► quote ──► acceptance envelope check ──► commit ──► receipt
                              │                                        │
                              └── determinacy gate (BC-1)              └── replay / reconciliation
```

1. **Quote.** An adapter's `createChangeQuote(subscriptionId, spec)`
   computes a `SubscriptionChangeQuote`: the predicted
   `CommercialEffect` (immediate + recurring, integer minor units,
   explicit currency), a `determinacy` record, and the quote's
   expiry. Quoting never mutates the subscription.
2. **Accept.** The caller supplies an `AcceptanceEnvelope`
   (`maxImmediateNetIncrease`, `maxImmediateNetDecrease` —
   published spelling: `maxImmediateCreditDecrease`, see the
   migration guide — `maxRecurringIncrease`). At commit, the
   envelope is checked arithmetically against the quote. Violations,
   expired quotes, and non-deterministic quotes are refused **before
   any dispatch**.
3. **Commit.** `DurableMutationCoordinator.execute(intent, dispatch)`
   (or the adapter's durable commit path) claims the attempt in the
   `DurableQuoteStore`, dispatches exactly once, and records the
   receipt durably.
4. **Replay / reconcile.** Re-executing a settled intent returns the
   original recorded receipt (`{ type: "replay" }`) with no second
   dispatch. A dispatch whose outcome cannot be established settles
   **INDETERMINATE** and blocks until resolved with trusted provider
   evidence — see `docs/IDEMPOTENCY-AND-RECONCILIATION.md` and
   `docs/RECOVERY-RUNBOOK.md`.

## Principal exports

| Export | Role |
|---|---|
| `DurableQuoteStore` | SQLite (WAL) store for quotes, attempts, receipts, evidence. Fails closed on corruption or a missing SQLite binding. |
| `DurableMutationCoordinator` | Write-ahead commit path with lifecycle hooks (`afterIntentPersisted`, `afterDispatchBeforePersist`). |
| `createProviderEvidenceVerifier` | Builds the verifier that can establish INDETERMINATE resolutions from provider records (freshness bound: `RESOLUTION_EVIDENCE_MAX_AGE_MS`). |
| `QuoteStore` | In-memory store with the same quote semantics; no durability. |
| `verifyPostCommitState` | Compares observed state to the expected target state. Conformance only — see Limitations. |
| `ChargebeeAdapter` / `StripeAdapter` / `PaddleAdapter` / `ZuoraAdapter` | Translate provider-shaped records to and from the provider-neutral core over caller-supplied transports (the simulators in-tree, or a caller's own read/write wiring). |
| `ChargebeeSim` / `StripeSim` / `PaddleSim` / `ZuoraSim` | Deterministic simulators. Behavior parity with real providers is not claimed. |
| Errors | `SCQError` (base, with `SCQErrorCode`), `DurableStoreError`, `DurableRecoveryError`, `DispatchBlockedError`, `ResolutionEvidenceError`. Error **codes** are contract; messages are not. |

## Semantics that are contract

- Money is integer minor units; currency is explicit; no floats.
- `UNKNOWN` is a first-class financial state, distinct from zero in
  every comparison and report.
- The four supported mutation categories are **quantity, plan,
  cadence, cancellation**.
- A receipt's recorded identity is immutable; later actuals live in
  the append-only evidence trail, never by rewriting the receipt.
- `verifyPostCommitState` verdicts assert target-state conformance
  of an observation. They do not assert that a specific operation
  executed, nor that authorization was preserved.

## Limitations (contract, not fine print)

- The core trusts adapter-established classification and does not
  independently authenticate provider events (G-01).
- No live provider dispatch is supported; no exactly-once provider
  execution, atomic cross-provider, or production-certified billing
  guarantee exists. See the readiness document §2.3–2.4.
