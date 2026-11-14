# Try Agorail in Five Minutes

**An agent changes a subscription. What did the caller accept, and what happened?**

An AI agent is asked to increase a subscription from 100 to 120 seats.
The calling application needs to inspect the financial effects before
allowing the change and understand the result afterward. If the provider
response is lost, it must preserve that uncertainty when deciding what
to do next.

Agorail is an open-source developer preview for representing the proposed
subscription change, its financial bounds and its recorded outcome.
These simulator examples let billing and agent engineers review that
contract without a billing account or credentials.

## Review the outcomes first

| Situation | What the example exposes | Caller action |
| --- | --- | --- |
| A declared dependent change is missing | `ADMISSION_REFUSED`, with the missing add-on named in the supplied dependency report | Revise the proposed change set before dispatch. |
| A seat increase is quoted | USD 200 immediate net effect and USD 1,200 resulting recurring amount; a separate example policy applies spending caps | Decide whether to approve those financial effects. |
| A receipt was recorded before a restart | The original receipt is replayed; the replay invokes no dispatch callback | Use the recorded result without issuing another mutation. |
| The provider response was lost and no receipt was recorded | `INDETERMINATE`; a blind repeat is refused | Investigate the unresolved operation before authorizing another attempt. |

The main example below shows admission, the financial quote and recorded
receipt replay. The lost-response example is a separate command below.
A useful first review is one workflow this model misses, or one field or
state a calling agent would need. You can assess the table and expected
output before installing anything.

## Run the combined example

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

### Prerequisites

- Node.js **22 or later** and npm.
- Git, to retrieve the pinned example source.
- About five minutes once the prerequisites are ready. The replay example
  uses a native SQLite dependency; installing its binding may require a
  supported prebuilt binary or local build tools.

### Run it

```bash
git clone https://github.com/agorail-labs/subscription-change-quote.git
git -C subscription-change-quote checkout --detach d8cd84e0bb8fe7f001fe5e477699b410ce6f614c
mkdir agorail-quickstart && cd agorail-quickstart
npm init -y
npm install --save-exact @agorail-labs/mse-reference@1.0.0-rc.2 @agorail-labs/scq-reference@1.0.0-rc.2
cp ../subscription-change-quote/examples/consumer/mse-plus-scq.mjs .
node mse-plus-scq.mjs
```

The example imports only the two published packages — no
repository-internal modules and no repository-relative imports. Its source
and both package versions are pinned so later repository changes do not
silently change this evaluation.

### Expected output

Expected simulator output (verify against your installed release candidates; the quote ID differs on every run):

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

## Run the lost-response example

From the same `agorail-quickstart` directory:

```bash
node node_modules/@agorail-labs/scq-reference/examples/scenario-c-indeterminate.mjs
```

Expected observations: the lost-response case reports `INDETERMINATE`,
records no receipt for that outcome, and refuses a blind retry while the
simulator's dispatch count stays at one. A separate settled case in the
same script reopens the durable store and replays its recorded receipt
without another dispatch. A recorded receipt and an unresolved provider
result are different recovery cases.

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

- **No automatic dependency discovery or add-on execution.** The MSE gate
  uses an example-supplied dependency relation and evaluator. SCQ then
  simulates the seat-quantity change; the script does not execute the add-on
  unit or demonstrate an atomic multi-unit billing update.
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
