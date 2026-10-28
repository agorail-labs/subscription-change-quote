# SCQ v0.6.1 — Experimental developer-preview notes

**Status:** Prepared for a possible first public release; **not yet published or endorsed as a standard**.

## What SCQ provides

Subscription Change Quote (SCQ) models changes to an *existing* subscription using a provider-neutral `snapshot → proposal → quote → commit → receipt` lifecycle. Its v0.6.1 contract covers four actions: `CHANGE_QUANTITY`, `CHANGE_PLAN`, `CHANGE_CADENCE`, and `CANCEL`.

The specification distinguishes:

- `EXACT` from `REVALIDATE` **per commercial-effect dimension**, without implying that unmodeled tax, discounts, contracts, entitlements or other financial effects are covered.
- Quote-relative `acceptanceEnvelope` drift checks from **separate absolute spending and authorization decisions**.
- Provider-dependent effective timing and multi-change consistency, including explicit refusal of unsupported or potentially partially applied change sets.
- Expiration, idempotent receipt replay, version/fingerprint staleness checks, and post-commit reconciliation.

## Included

- [Normative SCQ v0.6.1 specification](../spec/scq-v0.6.1-spec.md).
- [Security considerations](../spec/security-considerations.md).
- [Draft conformance map](../conformance/conformance.md) and automated research test suite (**66 cases**).
- [Developer quickstart](QUICKSTART.md) using an in-memory, Stripe-shaped example.
- Simulator-backed reference adapters shaped after Stripe, Paddle, Zuora and Chargebee; TypeScript ESM and declaration exports and a local tarball consumer test.
- [Research evidence and limitations](../research/EVIDENCE.md).

## Critical limitations

**No reference adapter calls a live billing provider.** Prior research included *limited* real Chargebee test-site observations, but this release does not ship a Chargebee production API integration. The Stripe, Paddle and Zuora models were documentation-backed simulations only.

No provider-backed atomic compare-and-swap on commit is claimed. Reconciliation may discover a problem **after** a mutation; it cannot automatically roll one back. Some term consequences are unknown, and the protocol does not authorize spending or contractual changes.

The TypeScript reference package is **not published to npm**. Its package version `0.1.0` is distinct from the SCQ protocol version `0.6.1`, and its package.json retains `private: true`. The local package archive is a test artifact, not a production SDK.

No adoption, official ACP/UCP integration, third-party certification, or industry endorsement is implied. The standards documents are discussion drafts only.

## Quick validation

```bash
cd reference
npm ci
npm test
npm run demo
npm run smoke:pack
```

No live provider credentials are needed.

## Feedback

Use [Contributing](../CONTRIBUTING.md) for non-sensitive feedback and [Security](../SECURITY.md) for vulnerability reporting. The v0.6.1 normative contract remains frozen during external review. Report a reproducible discrepancy with evidence level clearly identified, without claiming simulator observations are production findings.

This preview should not be relied on as billing, financial, security, or legal advice.
