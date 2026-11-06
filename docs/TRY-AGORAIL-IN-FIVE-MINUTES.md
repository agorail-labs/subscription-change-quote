# Try Agorail in Five Minutes

**Agorail — safety contracts for AI-driven commerce changes.**

An AI agent is asked to increase a SaaS subscription from 100 to 120
seats. The change requires an additional entitlement (an analytics
add-on) to be included, it changes recurring billing, and the provider
call might time out after it executes — leaving the agent unsure
whether the change happened, and at risk of applying it twice if it
retries.

This quickstart runs the two published Agorail packages together and
shows, in one script:

1. **MSE refuses an incomplete change** — the seat increase without
   its required dependent add-on is stopped before anything is
   quoted or dispatched, with a witness naming what is missing.
2. **MSE admits the complete change** — seats plus add-on passes the
   admission gate.
3. **SCQ quotes the financial consequences** — immediate and
   recurring amounts, and whether each is *determined* or honestly
   unknown.
4. **A separate approval policy decides** — the example's business
   spending caps live outside SCQ; SCQ's own acceptance envelope
   governs drift relative to the quote, not whether the spend is
   allowed.
5. **A simulated commit produces a receipt**, and after a simulated
   restart, **re-executing the same intent replays the recorded
   receipt instead of dispatching again**.

Everything runs against an in-memory simulator. No billing account,
API key, or credentials are needed, and no real provider is called.

## Prerequisites

- Node.js **20 or 22** and npm.
- About five minutes.

## Run it

```bash
git clone https://github.com/agorail-labs/subscription-change-quote.git
mkdir agorail-quickstart && cd agorail-quickstart
npm init -y
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
cp ../subscription-change-quote/examples/consumer/mse-plus-scq.mjs .
node mse-plus-scq.mjs
```

The example imports only the two published packages — no
repository-internal modules and no repository-relative imports.

## Expected output

Verified against the published packages on Node 22.14.0 and
Node 20.19.5 (identical output; the quote ID differs on every run):

```text
MSE gate, incomplete change: ADMISSION_REFUSED
  witness names the missing unit: addon-analytics
  -> refused before quoting or dispatch; the SCQ steps below never run for this change
MSE gate, complete change: ADMISSION_PASSED
SCQ quote: scq_chargebee_af32a638dc8f757d
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

Amounts are minor units (for USD, cents): the seat increase costs
200.00 immediately and raises the recurring amount to 1,200.00.

## What just happened

- **Admission is not authorization.** MSE's gate decides whether the
  change *set* is complete and admissible. It grants no permission;
  whether the change may happen at all is the caller's decision —
  here, the example `approvalPolicy` object, deliberately separate
  code from SCQ's acceptance envelope.
- **The envelope is about drift, not approval.** The quote was created
  with zero-tolerance drift bounds (`maxImmediateNetIncrease: 0`,
  `maxRecurringIncrease: 0`): if the revalidated outcome had moved
  beyond the quote, the commit would have been refused or the receipt
  would have reconciled as violated. Approval to spend is a different
  question, answered by the separate policy check.
- **Replay is a recorded outcome, not a retry.** After the simulated
  restart, a durable coordinator over the same database recognized
  the already-settled intent and returned the recorded receipt. The
  dispatch callback was never invoked, and the simulator still shows
  exactly one mutation.

## What this does not show

- **No real provider.** The SCQ half runs against `ChargebeeSim`, an
  in-memory, provider-shaped model. Nothing here validates a live
  billing integration.
- **No exactly-once claim at a provider.** Durable replay protects
  the dispatch boundary modeled here; it cannot prove what a real
  provider did with a request that timed out mid-flight. SCQ's
  answer to that case is an honest `INDETERMINATE` outcome and
  reconciliation — never a blind retry.
- **No production certification.** Both packages are experimental
  reference implementations. Read each project's limitations before
  relying on any claim:
  [SCQ status and limitations](../README.md#current-status-and-known-limitations-v062) ·
  [MSE onboarding](https://github.com/agorail-labs/mutation-safety-envelope/blob/main/docs/ONBOARDING.md)

## Separate from the v0.7 bridge

This quickstart uses **only the published npm packages**. The
experimental, source-only v0.7 business-intent bridge
(`MseScqIntentBridge`) is a separate repository-internal integration
that is **not** part of either package's consumer API and is not
exercised here. Reviewers interested in the bridge should follow
Route B of the
[independent review package](INDEPENDENT-MSE-SCQ-REVIEW.md).

## Next steps

- [SCQ developer onboarding](ONBOARDING.md) — single-package SCQ
  examples and outcome semantics.
- [MSE developer onboarding](https://github.com/agorail-labs/mutation-safety-envelope/blob/main/docs/ONBOARDING.md)
  — single-package admission examples.
- [Independent review package](INDEPENDENT-MSE-SCQ-REVIEW.md) — run
  the packages adversarially and report falsifiable findings.
- Specifications:
  [SCQ v0.6.2](../spec/scq-v0.6.2-spec.md) ·
  [MSE normative spec](https://github.com/agorail-labs/mutation-safety-envelope/blob/main/spec/normative-spec.md)
