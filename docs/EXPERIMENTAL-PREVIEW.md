# SCQ v0.6.1 — Experimental developer-preview notes (superseded)

**Superseded.** SCQ v0.6.2 is now the project's current experimental specification
([specification](../spec/scq-v0.6.2-spec.md); [release notes](../research/v0.6.2-release-notes.md);
[migration guide](../research/v0.6.2-migration-guide.md)). This document is retained unchanged
below as the v0.6.1-era preview record: its version-specific statements (including test counts
and the frozen-contract note) describe the v0.6.1 publication state, not the current one.

**Status:** Published as a public experimental repository for external review. **Not endorsed as a standard**, not an adopted specification of any provider or standards body, and the reference package is **not published to npm** (the repository is public; the npm package is not).

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
- [Draft conformance map](../conformance/conformance.md) and automated research test suite (**115 cases** on main: 66 simulator/engine cases plus test13's 49 mocked-transport cases for the experimental Chargebee live adapter, merged as Change B in PR #4; no test in the suite is a live API test — the live runs are recorded as research evidence, not executed by the suite).
- [Developer quickstart](QUICKSTART.md) using an in-memory, Stripe-shaped example.
- Simulator-backed reference adapters shaped after Stripe, Paddle, Zuora and Chargebee; TypeScript ESM and declaration exports and a local tarball consumer test.
- [Research evidence and limitations](../research/EVIDENCE.md).

## Critical limitations

**The simulator-backed reference adapters never call a live billing provider.** Prior research included *limited* real Chargebee test-site observations (historical, prior cycle). The repository also ships an **experimental** Chargebee live adapter (Change B, merged in PR #4) that was exercised against a real Chargebee **test site** for retrieval and quote generation only (read/estimate); its commit path is disabled by default and has **not** been live-validated, and it is a validation tool, not a Chargebee production API integration. The Stripe, Paddle and Zuora models were documentation-backed simulations only.

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
