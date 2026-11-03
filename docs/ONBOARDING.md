# SCQ developer onboarding

Subscription Change Quote (SCQ) is a protocol-neutral contract for changing an
**existing subscription** — quantity, plan, cadence, or cancellation — safely
enough for autonomous agents and careful integrators to reason about across
heterogeneous billing systems.

SCQ standardizes one lifecycle:

```text
SubscriptionSnapshot -> SubscriptionChangeProposal -> SubscriptionChangeQuote
                     -> commit -> SubscriptionChangeReceipt
```

The problem it solves: a request as simple as "increase this workspace from
100 to 120 seats" has materially different consequences depending on the
billing provider — a charge or credit now, a different future recurring
amount, a contractual consequence, a race between preview and mutation, or a
multi-change request that silently applies only part of what was asked. SCQ
makes those differences **machine-readable before mutation**: what will this
do, how strongly is that guaranteed, and did the committed outcome actually
stay within what was approved?

SCQ is explicitly **not** a protocol for subscription creation,
payments/refunds, payment authorization, identity, delegation, negotiation,
procurement, or usage billing. The normative text is
[`spec/scq-v0.6.2-spec.md`](../spec/scq-v0.6.2-spec.md); this document is the
post-publication developer entry point for the experimental npm package.

## Install

```bash
npm install @agorail-labs/scq-reference@experimental
# or pin the exact audited version:
npm install @agorail-labs/scq-reference@0.6.2-experimental.1
```

Node 20 or 22. The package is ESM; import from the package root:

```js
import { ChargebeeAdapter, ChargebeeSim, QuoteStore } from "@agorail-labs/scq-reference";
```

### A note on dist-tags (Phase 1 rationale)

npm requires every package to keep a `latest` dist-tag; removing it was
attempted on 2026-11-02 and rejected by the registry (400). `latest`
therefore points at the current experimental version; the `0.0.0-stage`
placeholder exists but is untagged and is never a resolution fallback.
Always install with `@experimental` or an exact version.

## Getting started

The repository ships runnable consumer examples under
[`examples/consumer/`](../examples/consumer/). They run against the
**published** package — install it as above, then:

```bash
node examples/consumer/seat-expansion.mjs
```

The example seeds a simulated subscription (seats 100), quotes an expansion
to 120 seats, evaluates acceptance, commits once against the simulator, and
inspects the receipt. **Simulator only:** `ChargebeeSim` is an in-memory,
provider-shaped model. No real billing API is called, and the adapters in
this package are not production billing SDK integrations.

Expected output (the quote id differs per run):

```text
Quote: scq_chargebee_dc5109a3ee979faa
Guarantee mode: REVALIDATE
Proposed immediate net (minor units): 20000
Proposed recurring amount (minor units): 120000
Currency: usd
Determinacy: {"immediateFinancialEffect":"DETERMINED","recurringFinancialEffect":"DETERMINED"}
Guarantee coverage: {"immediateFinancialEffect":"REVALIDATE","recurringFinancialEffect":"REVALIDATE","termEffect":"UNKNOWN","effectiveAt":"REVALIDATE"}
Accepted under the example approval policy (absolute caps, separate from the SCQ envelope).
Receipt status: COMMITTED
Receipt outcome: COMMITTED_AND_VERIFIED
Reconciliation: OK
Committed immediate net (minor units): 20000
Committed determinacy: {"immediateFinancialEffect":"DETERMINED","recurringFinancialEffect":"DETERMINED"}
Resulting quantity: 120
Provider dispatches: 1
Done: seat expansion committed and verified against the simulator.
```

The package itself also ships three scenario examples
(`examples/scenario-a-verified.mjs`, `scenario-b-divergence.mjs`,
`scenario-c-indeterminate.mjs` inside the installed package) covering a
verified commit, an established-but-wrong landing, and a lost-response
outcome. This repository's
[`docs/SCQ-V062-ADOPTER-QUICKSTART.md`](SCQ-V062-ADOPTER-QUICKSTART.md) and
[`docs/QUICKSTART.md`](QUICKSTART.md) go deeper into the repository's own
simulator demo.

## How outcomes are represented

A commit never collapses to a bare success flag. The receipt records a
status, an outcome, and a reconciliation verdict, and each has a distinct
safe interpretation:

| Receipt reading | Meaning | Safe next step |
| --- | --- | --- |
| `COMMITTED` / outcome `COMMITTED_AND_VERIFIED`, reconciliation `OK` | The landing is established from operation-bound evidence and agrees with the quoted change | Treat as success — within the evidence limits below |
| Reconciliation `VIOLATED` | The landed effect is established **and attributable**, and it is not what was quoted (e.g. wrong quantity or price) | A verified violation: do not present as success; escalate with the receipt as evidence |
| Status `COMMITTED_UNVERIFIED`, reconciliation `UNVERIFIED` | Something landed, but the effect cannot be attributed to this operation (e.g. the figure is a third party's netted change); any figure present is a §3.10 **candidate**, not an established actual | Reconcile from independently observed provider state |
| Outcome `INDETERMINATE` | The mutation was dispatched but its response was lost; it may or may not have landed | **Never blind-retry.** Re-committing the same quote is refused and dispatches nothing; reconcile by observation first |

Two further rules shape every flow:

- **Determinacy gate.** A quote dimension is `DETERMINED` only when its
  value is established with provenance. `UNKNOWN` means "no established
  value" — it is never a synonym for zero, and a quote whose participating
  dimensions are not determinable is refused before mutation
  (`QUOTE_NOT_DETERMINISTIC`).
- **Durable replay.** The recorded receipt is immutable. With
  `DurableQuoteStore` (SQLite) and `DurableMutationCoordinator`, re-committing
  or re-executing an already-settled intent after a restart replays the
  **original** receipt and dispatches nothing (spec §6.10). Later
  verification is append-only evidence; the presented view is derived from
  it.

## Guarantees given — and not given

Given, within the simulator-backed reference implementation:

- Quotes state their guarantee strength per dimension (`EXACT` /
  `REVALIDATE` / `UNKNOWN`) and their determinacy, before any mutation.
- Post-commit verification binds financial actuals to the artifact the
  operation itself created — never to an unqualified "latest mutation"
  pointer or a pre-mutation estimate.
- Indeterminate outcomes block blind retry deterministically, and durable
  dispatch protection prevents a duplicate intent from re-executing.

**Not** given — read this before relying on the package:

- **No authorization grant.** A passing quote, an accepted envelope, or a
  verified receipt does not mean a change was *authorized*. Admission,
  authorization, execution, reconciliation, and finality are separate
  questions. Identity, approval, absolute budget, and entitlements are the
  integrator's business policy, enforced outside SCQ.
- **The acceptance envelope is not a spending cap.** It bounds
  quote-relative *drift* between the quote and the refreshed preview at
  commit time — not total spend.
- **No atomicity or exactly-once claims.** Check-plus-mutation is not
  atomic without server-enforced proof, and an in-memory store cannot prove
  durable exactly-once. The durable store and coordinator provide
  write-ahead dispatch protection and replay, not provider-side atomicity.
- **Verification is target-state conformance.** A `VERIFIED` verdict
  establishes that the resulting state conforms to the quoted target state
  under the specified evidence limits; it does not certify preservation of
  unrelated state, and provider-origin authenticity is bounded by the
  adapter boundary (the core trusts adapter-established classification; it
  does not independently authenticate provider events).
- **Simulators only.** Stripe, Paddle, Zuora, and Chargebee behaviors here
  are documentation-backed simulations. No live provider commit is
  validated, and live mutations are out of scope for this package.

## Using MSE and SCQ together

[MSE (Mutation Safety Envelope)](https://github.com/agorail-labs/mutation-safety-envelope)
is the companion specification. The two are separate because they answer
different questions:

- **MSE** is a domain-blind, read-only **admission** gate over multi-unit
  changes: are all dependent units present and are the declared relations
  satisfied, with evidence — before anything is dispatched?
- **SCQ** governs the **financial lifecycle** of a subscription change:
  quote, acceptance evaluation, commit, receipt, reconciliation.

[`examples/consumer/mse-plus-scq.mjs`](../examples/consumer/mse-plus-scq.mjs)
wires them together in user code: a seat change whose dependent add-on is
missing is refused by the MSE gate and never reaches SCQ; the complete
change passes admission, is quoted and committed by SCQ under a durable
store, and a duplicate dispatch of the same intent replays instead of
re-executing. Expected output (quote id differs per run):

```text
MSE gate, incomplete change: ADMISSION_REFUSED
  witness names the missing unit: addon-analytics
  -> refused before quoting or dispatch; the SCQ steps below never run for this change
MSE gate, complete change: ADMISSION_PASSED
SCQ quote: scq_chargebee_216f3741d44b08da
Quoted immediate net (minor units): 20000
Quoted recurring amount (minor units): 120000
Determinacy: {"immediateFinancialEffect":"DETERMINED","recurringFinancialEffect":"DETERMINED"}
Accepted under the example approval policy (separate from SCQ's drift envelope).
Receipt status: COMMITTED | reconciliation: OK
Provider dispatches after commit: 1
Second dispatch of the same intent: replay
Replayed receipt status: COMMITTED
Dispatch callback invocations: 0
Provider dispatches still: 1
Unresolved attempts in recovery report: 0
Done: MSE admitted the complete change; SCQ committed it once; the duplicate intent replayed, not re-executed.
```

That integration is **experimental example source code**, not an API
exported by either published package. Neither package grants authorization;
the pipeline above decides admissibility (MSE) and governs commitment
(SCQ) — whether the change may happen at all remains the integrator's
decision.

## Filing bugs and feedback

- **Bugs / spec inconsistencies / conformance gaps:**
  [GitHub Issues](https://github.com/agorail-labs/subscription-change-quote/issues).
  A reproducible report names the package version, the Node version, the
  adapter/simulator used, the proposal and quote involved, and the receipt
  or error observed — simulator transcripts are ideal; never post real
  billing account data, customer data, or secrets.
- **Adoption feedback and integration questions:**
  [GitHub Discussions](https://github.com/agorail-labs/subscription-change-quote/discussions),
  or an issue labeled as feedback. Independent consumer reproductions —
  install results, example runs, code review findings — are recorded in
  [`docs/ADOPTION-TRACKER.md`](ADOPTION-TRACKER.md) once verified.
- **Security-sensitive concerns:** see [`SECURITY.md`](../SECURITY.md);
  report privately rather than in a public issue.
