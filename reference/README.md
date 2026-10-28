# @arjun2075/scq-reference — experimental reference package

This is a **simulation-only developer preview** of the Subscription Change Quote (SCQ) v0.6.1 contract. The package version (0.1.0) is separate from the protocol version (0.6.1).

**Not published on npm. Not certified for production billing.** The four adapters are backed by in-memory Stripe-, Paddle-, Zuora-, and Chargebee-shaped simulators, not provider API SDKs.

To produce and test a local package from this repository:

```bash
cd reference
npm ci
npm run smoke:pack
```

The smoke test builds the package, creates a local tarball, installs it into an isolated temporary consumer directory in offline mode, imports the public entry point, and type-checks it with TypeScript.

The public package entry point exposes `SubscriptionProvider`, proposal/quote/receipt types, `SCQError`, `QuoteStore`, and simulator-backed reference adapters. It is intended for experimentation and independent adapter development. For the complete protocol and evidence levels, see the [repository](https://github.com/arjun2075/subscription-change-quote) and [evidence register](https://github.com/arjun2075/subscription-change-quote/blob/main/research/EVIDENCE.md).

**Security and consent:** An SCQ `acceptanceEnvelope` permits quote-relative variation; it is not a total spending limit or authorization grant. Real integrations must perform independent identity, approval, absolute budget and contractual/entitlement checks. All simulated adapters report best-effort precondition/commit concurrency; no atomic provider compare-and-swap guarantee is implied.

The npm package remains `private: true` and is not published to a registry. It can be built and tested locally as a simulator-backed reference package. Apache-2.0 licensed.
