# Agorail external evaluation kit

**For engineers who have never encountered Agorail. Status: ready to
share; no reviewer has been contacted with it yet.**

Agorail publishes two experimental safety contracts for AI-driven
commerce changes. This kit is everything an independent evaluator
needs to run them, try to break them, and report what happened.

## Start here

- **Watch (90 seconds):** "Agorail: What Happens When an AI Agent
  Changes a Subscription?" — linked from the
  [Agorail Labs organization homepage](https://github.com/agorail-labs)
  ("Watch the demo"). Every output shown is a real run of the
  published packages against simulators.
- **Run (five minutes):**
  [Try Agorail in Five Minutes](../TRY-AGORAIL-IN-FIVE-MINUTES.md) —
  a clean consumer project, no billing credentials, no real provider.

## Exact published versions

```bash
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
```

Node 20 or 22. These are the only versions this kit covers; the
repositories' source trees contain later, unreleased work that is
**not** part of the evaluation surface.

## Three reproducible negative safety scenarios

1. **The incomplete change set.** Run the combined example
   (`examples/consumer/mse-plus-scq.mjs`): the seat increase without
   its required analytics add-on is refused by MSE —
   `ADMISSION_REFUSED` — with a witness naming the missing unit,
   before anything is quoted or dispatched.
2. **The lost response.** Run `scenario-c-indeterminate.mjs` (shipped
   in the SCQ package's `examples/`): the commit's response is lost,
   the outcome is recorded `INDETERMINATE`, a blind retry is refused,
   and reconciliation happens by independent observation — which shows
   the change did land; only its response was lost.
3. **The diverged outcome.** Run `scenario-b-divergence.mjs` (same
   location): when established actuals contradict the quote, the
   receipt classifies `VIOLATED`; when actuals cannot be attributed,
   it classifies `UNVERIFIED`. Neither is ever silently reported as
   OK.

## What to try to falsify

- Make MSE admit a change set whose declared dependency is unmet.
- Make the SCQ determinacy gate commit a quote whose financial effect
  is `UNKNOWN`.
- Make a restarted process dispatch an already-settled intent twice.
- Make a receipt or reconciliation claim more than its evidence
  establishes — a partial or indeterminate outcome reported as
  verified, or a later actual rewritten into the historical receipt.
- The [independent review package](../INDEPENDENT-MSE-SCQ-REVIEW.md)
  lists sharper questions (concurrent overwrites, two-ledger gaps,
  forged admission evidence).

## How to report

Use the **Independent evaluation** issue template:
[SCQ repository](https://github.com/agorail-labs/subscription-change-quote/issues/new/choose)
· [MSE repository](https://github.com/agorail-labs/mutation-safety-envelope/issues/new/choose).
A console transcript and a minimal reproduction are enough;
"it worked as documented" is also a useful report. Verified external
results — positive or negative — are recorded in the
[adoption tracker](../ADOPTION-TRACKER.md) with credit, exactly as
evidenced; an invitation or a mention is never recorded as adoption.

## What is experimental

Both packages are experimental reference implementations tested
against simulators. They provide **no** authorization, **no**
exactly-once execution at a real provider, **no** atomic
cross-provider updates, and **no** production-certified billing
safety. Findings should be reported against exactly those terms.
