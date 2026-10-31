# SCQ developer quick start — v0.6.2 (simulator only)

Status: **adopter documentation for SCQ v0.6.2, published as an experimental specification.** The v0.6.2 specification was ratified and merged (PR #21) and is published as the project's current experimental specification by the publication change carrying this header; the `spec-v0.6.2` tag and GitHub Release are created by the maintainer at activation. SCQ v0.6.1 is the previous specification. The reference package is `private: true` and **not published on npm**; no live commit is authorized.

## Run without real billing credentials

From a clone of [agorail-labs/subscription-change-quote](https://github.com/agorail-labs/subscription-change-quote):

```bash
cd reference
npm ci
npm run build
npm run test
npm run demo
```

`npm run demo` executes the [simulated Stripe-backed seat-expansion demo](../reference/demo/seat-expansion.ts). It **quotes by default** and makes no real provider call. The simulator is an in-memory research model, not a Stripe SDK. Amounts are minor currency units; the example uses an illustrative absolute budget separate from SCQ's quote-relative drift envelope.

To exercise an **in-memory simulated commit only**:

```bash
npm run demo:commit
```

This passes a **hypothetical external-approval flag for synthetic fixture data only**. The flag is not identity verification, consent for real subscriptions, or authorization to use any provider API.

To validate that the package can be packed and consumed locally *without publishing it*:

```bash
npm run smoke:pack
```

The script builds a local tarball, installs it into an isolated temporary consumer, imports the package entry point, and type-checks. It **does not** run `npm publish`.

## Read a quote before any commit

The demo creates an illustrative `CHANGE_QUANTITY` proposal and inspects `quote.commercialEffect`. An integrator must separately evaluate:

- Financial determinacy for both participating dimensions: `DETERMINED`, `NOT_APPLICABLE` (only when licensed), and `UNKNOWN` are distinct. Missing is never verified zero.
- Provenance and unit/currency comparability, not just numeric equality.
- `guaranteeMode` EXACT or REVALIDATE; a revalidated estimate is not necessarily an actual charged amount.
- Whether term consequences are `UNKNOWN`. The demo refuses them absent an explicit synthetic override.
- A **separate business authorization** for the absolute spending amount, identity, contractual terms, scheduled changes and external entitlements. `acceptanceEnvelope` controls **relative quote drift only**, not total spend or approval.
- Concurrency limits: a `BEST_EFFORT` quote and last-moment read are not an atomic conditional write.

## Interpret a commit outcome

| Outcome | Safe interpretation / next step |
| --- | --- |
| CONFIRMED_NON_EXECUTION | No effect took place; retry rules are strictly bounded by §6.16 and require independently confirmed pre-effect rejection when any dispatch occurred |
| INDETERMINATE | The mutation may have landed; do **not** retry blindly; provider-state reconciliation and human intervention come first |
| COMMITTED_UNVERIFIED | Landing established but financial or state verification incomplete; any candidate figure under UNKNOWN is **not an established actual** |
| COMMITTED_AND_VERIFIED | Landing, target-state and financial verification established under the specified evidence limits; does **not** certify preservation of unrelated state or guarantee compliance with the acceptance envelope (a measured VIOLATED verdict is possible) |

The recorded receipt remains immutable. Later verification is an **append-only evidence** record; the presented current view is derived from those records. An initially EXACT contract-established `defined_equal_exact` fact is not independently provider-authenticated merely because it is classified EXACT.

## Upgrade/migration documentation

- [v0.6.2 specification](../spec/scq-v0.6.2-spec.md)
- [BC-1…BC-6 migration guide](../research/v0.6.2-migration-guide.md)
- [75-rule traceability and PARTIAL rows](../conformance/v0.6.2-traceability.md)
- [Release gaps and limitations](../research/v0.6.2-release-gaps.md)
- [Publication and package decision gates](../research/v0.6.2-publication-decision.md)
- [Reference package README](../reference/README.md)

Existing v0.6.1 serialized quotes with absent determinacy are read as UNKNOWN for enforcement and must not be converted to DETERMINED by default. Do not treat the current 803 simulated tests as provider-backed conformance certification.

## Provider safety is separate

This preview is useful for independently experimenting with semantics and writing simulator-backed adapters. The Chargebee live adapter's current full-list update is **refused** for OPERATION-scoped update commits because it cannot atomically preserve unrelated changes; see [G-17](../research/v0.6.2-release-gaps.md) and [provider mechanism research](https://github.com/agorail-labs/subscription-change-quote/issues/30). No live Chargebee commit, production integration, published npm package or independent provider adoption is claimed.
