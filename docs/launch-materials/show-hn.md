# Show HN draft — NOT POSTED

**Title:** Show HN: Agorail – Experimental safety contracts for AI commerce changes

**Body:**

AI agents are starting to modify commercial state — raise a
subscription from 100 to 120 seats, change a plan, amend a contract.
The APIs they call answer with something like SUCCESS, which
collapses four different questions: was the change admissible as a
set (did it include everything it depended on), what was it supposed
to cost, did it actually happen, and if the response was lost, is a
retry safe?

Agorail is an experimental, open-source attempt to make those
questions separately answerable, as two small protocols that compose
but don't depend on each other:

- **MSE (Mutation Safety Envelope)** — a domain-blind, read-only
  admission gate for multi-unit changes. It checks declared
  dependency relations (e.g. this seat change requires that add-on to
  be co-included) and either passes the set with coverage evidence or
  refuses it with a witness naming what's missing.
- **SCQ (Subscription Change Quote)** — a quote → commit → receipt
  lifecycle for subscription changes: financial effects and their
  guarantee strength before mutation (UNKNOWN where an effect can't
  be established), a drift envelope relative to the quote, an
  immutable receipt reconciled against actuals, and durable replay so
  re-executing the same intent returns the recorded receipt instead
  of dispatching again.

What you can run today (about five minutes, Node 20/22, no billing
credentials — the SCQ half runs against an in-memory simulator):

```
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
```

Walkthrough: https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md

What's experimental, stated plainly: these are reference
implementations tested against simulators, not production billing
integrations. They don't provide authorization (approval policy is
deliberately your code, outside the protocols), exactly-once
execution at a real provider, atomic cross-provider updates, or
certified billing safety. For the timeout case the protocol's answer
is an explicit INDETERMINATE outcome plus reconciliation, not a
guarantee.

The feedback that would help most is falsification. There's an
independent review package with concrete counterexample questions —
concurrent changes overwriting each other, intent recorded but never
attempted, forged admission evidence — and findings (including "it
worked as documented") are recorded only when publicly verifiable:
https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/INDEPENDENT-MSE-SCQ-REVIEW.md

Repos: https://github.com/agorail-labs/subscription-change-quote ·
https://github.com/agorail-labs/mutation-safety-envelope
