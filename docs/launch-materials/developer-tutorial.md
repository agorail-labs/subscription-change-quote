# Tutorial: Admission, Quote, Receipt, Replay — the Five-Minute Agorail Example, Explained

*DRAFT — developer tutorial, not published. The runnable version is
[Try Agorail in Five Minutes](../TRY-AGORAIL-IN-FIVE-MINUTES.md); this
tutorial explains the code behind it
([`examples/consumer/mse-plus-scq.mjs`](../../examples/consumer/mse-plus-scq.mjs)).
Everything runs against the published npm packages and an in-memory
simulator — no billing credentials, no real provider.*

The scenario: an agent must raise a subscription from 100 to 120
seats. The seat change *requires* an analytics add-on to be included
in the same change. We will refuse the incomplete version of that
change, admit the complete one, quote it, approve it under a business
policy that lives outside the protocols, commit it, and then prove
that re-running the same intent after a restart does not dispatch it
again.

## Setup

```bash
mkdir agorail-quickstart && cd agorail-quickstart
npm init -y
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
```

## Step 1 — Model the change as a set, and gate it with MSE

The change is two *units*: a seat-quantity transition and an add-on
transition, joined by a `REQUIRES_COINCLUSION` relation — if the seat
unit is in the change, the add-on unit must be too.

```js
import { evaluateAdmissionOnly } from "@agorail-labs/mse-reference";

const relations = [{
  relationId: "rel-seats-require-addon",
  type: "REQUIRES_COINCLUSION",
  triggerUnitRefs: ["unit-seats"],
  scopeRef: SUBSCRIPTION_ID,
}];
```

`evaluateAdmissionOnly` is exactly what it sounds like: a read-only
evaluation. It dispatches nothing. The third argument is *your*
evaluator — MSE is domain-blind, so your code reports whether each
declared relation is satisfied by the proposed set, and MSE validates
that the report covers every relation and correlates with the units
actually present.

Call it with only the seat unit and the answer is a refusal whose
witness names the missing transition:

```text
MSE gate, incomplete change: ADMISSION_REFUSED
  witness names the missing unit: addon-analytics
```

That witness is the point. A refusal that says "invalid" forces the
agent to guess; a witness that names the missing unit tells it
exactly how to repair the proposal. Add the add-on unit and the same
call returns `ADMISSION_PASSED`, with the coverage evidence attached.

Notice what admission did **not** do: it did not authorize anything.
Admissibility is a property of the change set. Permission is a
business decision that MSE deliberately never models.

## Step 2 — Quote the financial change with SCQ

The SCQ half runs against `ChargebeeSim`, an in-memory,
provider-shaped simulator seeded with the 100-seat subscription:

```js
import { ChargebeeAdapter, ChargebeeSim, DurableQuoteStore } from "@agorail-labs/scq-reference";

const quote = await adapter.createChangeQuote(SUBSCRIPTION_ID, {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  guaranteeMode: "REVALIDATE",
  acceptanceEnvelope: {
    maxImmediateNetIncrease: 0,
    maxImmediateCreditDecrease: 0,
    maxRecurringIncrease: 0,
  },
});
```

The quote reports the financial effect in minor units — 20,000
immediate (200.00), 120,000 recurring (1,200.00) — and, just as
important, a determinacy record: both effects are `DETERMINED`. When
an effect cannot be established, SCQ says `UNKNOWN` rather than
inventing a number, and callers are expected to refuse to proceed on
an undetermined effect they care about.

The `acceptanceEnvelope` deserves care, because it is the most
commonly misread part of the design. Those zeros are **drift
tolerances relative to the quote**: if the outcome at commit time has
moved beyond what was quoted, the change is refused or reconciles as
violated. The envelope is *not* a spending approval. It answers "did
reality stay within what was quoted?", never "may we spend this?"

## Step 3 — Approve under a separate policy, then commit

Approval is plain application code, outside both protocols:

```js
const approvalPolicy = { maxImmediateNetMinor: 25_000, maxResultingRecurringMinor: 125_000 };
// refuse unless determinacy is DETERMINED and both amounts are within policy
```

Only after that check does the example call
`adapter.commitChangeQuote(quote.id)`. The receipt comes back
`COMMITTED` with reconciliation `OK` — the committed outcome matched
the quote within the zero-tolerance envelope — and the simulator
shows exactly one dispatch.

Keeping the approval policy separate is not ceremony. Systems that
bake "approved" into the quote layer end up unable to say who allowed
a change; systems that bake it into the envelope end up approving
spend they only meant to bound. The example keeps the two in
different objects so the distinction survives code review.

## Step 4 — Restart, replay, and do not dispatch again

Now the timeout/restart case. The example closes the durable
(SQLite) quote store, opens a fresh one over the same database, and
asks a `DurableMutationCoordinator` to execute the *same* mutation
intent — same quote, same idempotency key. The dispatch callback is
rigged to throw if it is ever invoked:

```js
const result = await coordinator.execute(intent, async () => {
  dispatchInvocations += 1;
  throw new Error("dispatch must never run for an already-settled intent");
});
```

It is never invoked. The coordinator finds the intent already
settled and returns `{ type: "replay" }` with the originally recorded
receipt. Provider dispatches remain at one, and the recovery report
shows zero unresolved attempts.

Be precise about what this proves and what it does not. It proves
the *client-side dispatch boundary* is durable: a process that
recorded its intent before dispatching cannot be tricked by a
restart into dispatching the same intent twice. It does not prove
anything about a real provider's behavior mid-request — if a live
call times out after the provider executed, the honest outcome is
`INDETERMINATE` plus reconciliation against provider evidence, which
is a different code path (covered in the SCQ test suite) and the
reason the protocol refuses to let a receipt claim more than its
evidence establishes.

## Where to push next

- Change the evaluator so the add-on is missing and watch which
  layer refuses first — then remove the envelope's zero tolerances
  and see what the receipt reports when the simulator's price moves.
- Read the [independent review package](../INDEPENDENT-MSE-SCQ-REVIEW.md):
  it lists falsification questions (concurrent overwrites, two-ledger
  gaps, forged admission evidence) and how to report findings with a
  minimal reproduction.
- File what you find — including "it worked as documented" — through
  the *Independent evaluation* issue template. Verified external
  reports are the only rows the
  [adoption tracker](../ADOPTION-TRACKER.md) accepts.
