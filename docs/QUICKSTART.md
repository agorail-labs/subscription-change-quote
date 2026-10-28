# SCQ developer quickstart (simulator only)

This guide exercises the **SCQ v0.6.1 contract** with an in-memory, Stripe-shaped billing simulator. It does not call Stripe or any other live provider and is not an installable or production-certified SDK.

## Requirements

- Node.js 20 or 22 and npm.
- No provider account, API key, or external billing system.

## Run the example

```bash
git clone https://github.com/arjun2075/subscription-change-quote.git
cd subscription-change-quote/reference
npm ci
npm run demo
```

The default demo creates a quote for increasing a synthetic subscription from 100 to 120 seats. It prints quote metadata and financial effects, compares those effects to **separate absolute business spending caps**, and refuses to mutate when contractual/term consequences have not been independently approved.

To exercise the simulated commit path after an explicitly modeled *outside-the-protocol* approval:

```bash
npm run demo:commit
npm test
```

The commit demo operates **only** on the in-memory fixture. Its flag is a teaching aid, **not** an authorization mechanism or consent signal for production use. It prints the resulting receipt and reconciliation status. Do not copy the demo's approval flag into a real payment or subscription system.

## What to examine

1. `getSubscription`: observe the current subscription and opaque version/fingerprint.
2. `createChangeQuote`: preview the commercial effect without mutation; inspect `guaranteeCoverage`, `guaranteeMode`, `validUntil`, and `multiChangeConsistency`.
3. Check *absolute* business policy limits separately from the protocol's `acceptanceEnvelope`. The latter controls permitted **drift relative to the quote**, not a customer's overall spend allowance.
4. Treat `termEffect: UNKNOWN` or unmodeled taxes, discounts, contracts, and entitlements as requiring independent evaluation. A financial quote is **not** an authorization grant.
5. `commitChangeQuote`: after explicit external authorization in a real system, revalidate/commit; read `consistencyGuarantee` and post-commit `reconciliation`. A `VIOLATED` reconciliation is **post-mutation reporting**, not an automatic rollback.

## Current evidence limits

- The four reference adapters use **simulators**, not production billing SDKs.
- Chargebee has limited real test-site findings described in [the evidence register](../research/EVIDENCE.md), but that does **not** mean the repository's adapter is wired to a live Chargebee endpoint.
- Stripe, Paddle, and Zuora behavior in this repository is documentation-backed simulation only.
- No reference adapter claims a provider-enforced atomic compare-and-swap for the commit precondition.
- Conformance tests verify the model and selected rules. They do not prove production interoperability.

For the contract, read [the SCQ v0.6.1 specification](../spec/scq-v0.6.1-spec.md) and [security considerations](../spec/security-considerations.md).
