# SCQ Developer Guide — @agorail-labs/scq-reference (experimental)

This guide ships with the experimental package. It explains what SCQ
does, how to install the locally built artifact, and how to read what
it tells you. It is deliberately precise about limits: several things
SCQ does **not** do are listed in section 13, and they matter.

**Status:** experimental, unpublished (`private: true`), simulator
only. Not a replacement billing API, not a production-certified
payment SDK, and not certified provider conformance of any kind.

## 1. What SCQ solves

Billing mutations are usually fire-and-hope: an API call returns
success, and the integrator assumes the intended change landed, at
the intended price. SCQ — the Subscription Change Quote protocol
(spec v0.6.2, published as an experimental specification) — inserts
three disciplines around that mutation:

1. **Quote before commit.** A change is first priced and bounded as a
   quote: the proposed commercial effect, the state it was computed
   from, an expiry, and an explicit record of what is and is not
   guaranteed.
2. **Bounded authorization.** The quote carries an acceptance
   envelope: how much drift between the quoted figures and the
   refreshed commit-time figures the *approver* tolerates. Commit
   revalidates against current state and refuses or reclassifies
   rather than silently landing something else.
3. **Receipts that say what is actually known.** After commit, the
   receipt reports the committed effect with per-dimension
   determinacy and provenance, and a reconciliation verdict —
   including the uncomfortable outcomes (`VIOLATED`, `UNVERIFIED`,
   `INDETERMINATE`) instead of collapsing everything into success or
   failure.

## 2. Supported experimental use cases

- Evaluating the SCQ protocol's quote/commit/receipt semantics
  against in-memory, provider-shaped simulators.
- Prototyping an integration's authorization and receipt-handling
  logic (including its failure branches) before any real provider is
  involved.
- Developing an independent adapter against the `SubscriptionProvider`
  interface.
- Studying uncertain-outcome handling: lost responses, concurrent
  third-party changes, wrong landings, and their classifications.

Not supported: connecting to a real billing provider, moving money,
or relying on any figure this package produces for accounting.

## 3. Installation from the generated package artifact

The package is not published to npm. From a repository checkout:

```bash
cd reference
npm ci
npm pack
# agorail-labs-scq-reference-0.6.2-experimental.1.tgz
```

In your own (separate) project:

```bash
npm install /path/to/agorail-labs-scq-reference-0.6.2-experimental.1.tgz
```

Node.js >= 20. The only runtime dependency is the optional
`better-sqlite3`, used solely by the durable store (section 11); npm
installs it automatically, and the package works without its native
binding for everything except durable persistence.

## 4. Quick-start commands

The package ships three runnable scenarios (simulator only):

```bash
node node_modules/@agorail-labs/scq-reference/examples/scenario-a-verified.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-b-divergence.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-c-indeterminate.mjs
```

Each exits non-zero if the classification it demonstrates is not the
one produced, so they double as smoke tests.

## 5. JavaScript example

```js
import { ChargebeeAdapter, ChargebeeSim, QuoteStore } from "@agorail-labs/scq-reference";

const sim = new ChargebeeSim(new Date("2026-08-01T00:00:00.000Z"));
sim.seedSubscription({
  id: "cb_demo",
  status: "active",
  subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
  currentTermStart: "2026-08-01T00:00:00.000Z",
  currentTermEnd: "2026-08-31T00:00:00.000Z",
  nextBillingAt: "2026-08-31T00:00:00.000Z",
});

const adapter = new ChargebeeAdapter(sim, new QuoteStore());
const quote = await adapter.createChangeQuote("cb_demo", {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
});

console.log(quote.commercialEffect.immediate.net);        // 20000 (minor units)
console.log(quote.commercialEffect.determinacy);          // { immediateFinancialEffect: "DETERMINED", ... }

// Your approval decision happens here — see section 7.
const receipt = await adapter.commitChangeQuote(quote.id);
console.log(receipt.outcome, receipt.reconciliation.status); // COMMITTED_AND_VERIFIED, OK
```

## 6. TypeScript example

The package ships declarations; the same flow is fully typed:

```ts
import {
  ChargebeeAdapter,
  ChargebeeSim,
  QuoteStore,
  type ChargebeeSubscription,
  type SubscriptionChangeQuote,
  type SubscriptionChangeReceipt,
  type SubscriptionProvider,
} from "@agorail-labs/scq-reference";

const sim = new ChargebeeSim(new Date("2026-08-01T00:00:00.000Z"));
const seed: ChargebeeSubscription = {
  id: "cb_demo",
  status: "active",
  subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat_basic_monthly", quantity: 100 }],
  currentTermStart: "2026-08-01T00:00:00.000Z",
  currentTermEnd: "2026-08-31T00:00:00.000Z",
  nextBillingAt: "2026-08-31T00:00:00.000Z",
};
sim.seedSubscription(seed);

const provider: SubscriptionProvider = new ChargebeeAdapter(sim, new QuoteStore());

const quote: SubscriptionChangeQuote = await provider.createChangeQuote("cb_demo", {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  acceptanceEnvelope: { maxRecurringIncrease: 0 },
});

const receipt: SubscriptionChangeReceipt = await provider.commitChangeQuote(quote.id);
if (receipt.reconciliation.status !== "OK") {
  // Handle VIOLATED / UNVERIFIED explicitly — do not treat as success.
}
```

(Seed the simulator as in the JavaScript example. The simulators'
subscription seed types — `StripeSubscription`, `PaddleSubscription`,
`ZuoraSubscription`, `ChargebeeSubscription`, with their item/price
component types — are exported as types from the package root, so
fixtures can be named and checked statically.)

## 7. Quote and authorization-envelope concepts

A **quote** (`SubscriptionChangeQuote`) records: the proposed
changes; the subscription state they were priced from (a fingerprint
the commit later checks); the **commercial effect** (immediate and
recurring figures with determinacy and provenance); **guarantee
coverage** (which dimensions are `EXACT`, which are estimates, which
are `UNKNOWN` — notably term effects); an expiry (`validUntil`); and
a **guarantee mode** (`REVALIDATE` re-checks state at commit).

The **acceptance envelope** bounds *quote-relative drift*: how far
the refreshed commit-time figures may move from the quoted figures
before the commit refuses or reclassifies. Read this carefully:

> The envelope is drift tolerance, **not** a spending cap and **not**
> an authorization grant. Whether a change may happen at all — who
> approved it, absolute budget, entitlements, tax and contractual
> consequences — is the integrator's separate responsibility. SCQ
> assumes that decision exists; it does not make it.

## 8. Financial determinacy: UNKNOWN versus zero

Every financial dimension of an effect carries one of three states:

- `DETERMINED` — a value is established, with provenance. A verified
  zero is `DETERMINED` with value `0`, emitted as present-with-0.
- `NOT_APPLICABLE` — the dimension does not arise for this action,
  licensed by the spec's applicability table with a citation.
- `UNKNOWN` — no established value. **UNKNOWN is not zero.** Code
  that coerces an absent or UNKNOWN figure to 0 manufactures a
  financial fact; SCQ's adapters refuse to dispatch when a required
  dimension is UNKNOWN rather than guess (the BC-1 gate), and
  reconciliation treats UNKNOWN dimensions as undetermined, never as
  satisfied.

Amounts are minor units (cents for USD). The `immediate` figure is
the net obligation the change itself incurs at its effective time —
not a next-invoice total and not an amount due.

## 9. Provider evidence and attribution limitations

A receipt's figures are only as good as the evidence behind them, and
v0.6.2 is explicit about the boundaries:

- **Attribution before classification.** A committed figure counts as
  this operation's actual only when it is bound to the operation —
  for the Chargebee simulator, the artifact's recorded request must
  be the dispatched request and the operation must have begun on the
  state the commit validated (the "begin binding"). Interference
  inside the validate → dispatch window breaks attribution even when
  the landed state looks plausible (scenario B, part 2).
- **Candidates are narrow.** A figure that cannot be established may
  be retained only as a *candidate*: the original figure a later
  verification judges. Per spec section 3.10, a committed candidate
  may be sourced **only** from the mutating call's own response (or,
  for cancellations, the stored quote) — never from a further
  provider read performed after the mutation landed.
- **Trust limitation (register G-01).** The protocol core trusts the
  adapter's provenance classification; it does not independently
  authenticate provider events. A fabricated observation carrying
  establishing labels and intent-matching state is an adapter-layer
  forgery problem, not something the core detects.
- Simulator evidence is **simulated**. The adapters' mechanics are
  documentation-backed models, not observations of real providers.

## 10. Receipt interpretation

`commitChangeQuote` either returns a `SubscriptionChangeReceipt` or
throws an `SCQError`. Read both channels:

| Signal | Meaning | Integrator response |
| --- | --- | --- |
| outcome `COMMITTED_AND_VERIFIED`, reconciliation `OK` | Landed effect established and within authorization | Proceed |
| reconciliation `VIOLATED` | Landed effect established, attributable, and outside the authorized envelope/state | Alert; remediate the actual obligation; do not retry blindly |
| outcome `COMMITTED_UNVERIFIED`, reconciliation `UNVERIFIED` | The mutation landed but its effect cannot be attributed/established | Investigate from provider state; figures present are candidates only |
| `SCQError` with `details.outcome === "INDETERMINATE"` | Outcome unknown (e.g. response lost after dispatch) | **Do not retry.** Reconcile by independent observation (section 11) |
| `SCQError` refusal (e.g. `QUOTE_STALE`, `QUOTE_NOT_DETERMINISTIC`) | Refused before dispatch; nothing was mutated | Re-quote from current state if still desired |

Receipts are records: a recorded receipt is never rewritten by later
verification. Later evidence is appended and read through the derived
view (`establishVerification`), keeping the original and the current
assessment distinguishable.

## 11. Idempotency and uncertain-outcome recovery

- **Same quote, same outcome.** Re-committing a quote that already
  has a recorded receipt returns the original receipt without a
  second dispatch (spec section 6.10) — *if* the record survives.
  With the in-memory `QuoteStore` it survives only for the process
  lifetime; use `DurableQuoteStore` (SQLite, via the optional
  `better-sqlite3`) for cross-restart durability, as scenario C
  part 2 demonstrates.
- **Indeterminate is sticky.** Once an attempt's outcome is
  INDETERMINATE, the same quote refuses further commits and nothing
  re-dispatches. Resolution is an operator act based on independent
  evidence (observing the provider's actual state), never an
  automatic retry and never a fresh quote quietly reusing the
  attempt.
- **Durable path.** `DurableQuoteStore` + `DurableMutationCoordinator`
  implement a write-ahead ledger: dispatch intent is persisted before
  dispatch, an unresolved attempt blocks further dispatch for the
  subscription, and resolving an attempt requires independently
  reviewed resolution evidence (`resolveAttempt` with a provider
  evidence verifier). Durable storage makes the *record* survive; it
  does not by itself create exactly-once provider execution.
- Provider-native idempotency windows are finite (Chargebee documents
  30 minutes); do not treat them as a substitute for your own record.

## 12. Supported simulator adapters

Four simulator-backed adapters are exported, each with its in-memory
simulator: `StripeAdapter`/`StripeSim`, `PaddleAdapter`/`PaddleSim`,
`ZuoraAdapter`/`ZuoraSim`, `ChargebeeAdapter`/`ChargebeeSim`. All
implement `SubscriptionProvider`, report `BEST_EFFORT` consistency,
and support the v0.6.2 determinacy, attribution, and reconciliation
semantics. Their catalogs and pricing are small modeled fixtures, not
mirrors of the real providers' full catalogs.

## 13. Unsupported real-provider guarantees

- **No live commits.** Live Chargebee commit functionality is
  disabled and is not part of this artifact: the env-gated live pilot
  code is excluded from the tarball and remains repository-only
  research tooling. Nothing exported here opens a network connection
  to a billing provider.
- **No atomicity guarantee.** A precondition check followed by a
  mutation is not atomic without server-enforced proof; SCQ reports
  `BEST_EFFORT` and classifies the fallout honestly instead of
  claiming atomicity.
- **No certification.** No provider has certified this implementation;
  no conformance claim beyond the repository's own evidence register
  is made, and package smoke tests are not conformance evidence.
- **No production readiness.** Error surfaces, catalogs, and edge
  cases are experimental. Do not bill anyone with this.

## 14. Compatibility and migration notes

- The package implements the **v0.6.2** specification. v0.6.1
  payloads (no determinacy record) read every dimension as UNKNOWN
  for enforcement and reconciliation (spec section 10); the spec's
  migration guide lives in the repository (`docs/` and
  `spec/scq-v0.6.2-spec.md`).
- The specification is published; this package is a **separate
  artifact** with its own release decision. Spec publication is not
  package approval, and this package's version is not a promise of
  API stability: experimental releases may change the surface with
  the spec.
- Repository, issues, and the evidence register:
  https://github.com/agorail-labs/subscription-change-quote

## 15. Contribution and issue reporting

Contributions and issue reports go through the repository:
https://github.com/agorail-labs/subscription-change-quote/issues —
see `CONTRIBUTING.md`, `SUPPORT.md`, and `SECURITY.md` there. When
reporting a classification bug, include the quote, the receipt
(including determinacy and provenance), and the simulator scenario
that produced them; classification claims without the underlying
records cannot be evaluated. Do not include real provider
credentials or live account data in any report.
