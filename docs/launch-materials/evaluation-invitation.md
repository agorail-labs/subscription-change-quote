# External evaluation invitation — DRAFT, NOT SENT

**For:** practitioners in billing, platform, and agent infrastructure.
**Ask:** run two small experimental packages and try to break them.

Agorail publishes two experimental reference implementations for
AI-driven commerce changes:

- `@agorail-labs/mse-reference@0.4.0-experimental.1` — read-only
  admission for multi-unit changes with declared dependencies.
- `@agorail-labs/scq-reference@0.6.2-experimental.1` —
  quote → commit → receipt for subscription changes, with drift
  envelopes, reconciliation, and durable replay.

No billing credentials, accounts, or live providers are involved;
the SCQ examples run against an in-memory simulator. On Node 20 or
22, the combined example takes about five minutes:

https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md

What would be most useful is not a thumbs-up but a falsifiable
finding: a scenario where the recorded receipt and reality can
diverge, an incomplete change that passes admission, a replay that
dispatches twice, a claim in the documentation the code does not
support. The independent review package lists the sharpest open
questions we know of:

https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/INDEPENDENT-MSE-SCQ-REVIEW.md

Report through the *Independent evaluation* issue template in either
repository (a transcript and a minimal reproduction are enough;
"it worked as documented" is also a useful report). Verified external
results — positive or negative — are recorded in the project's
adoption tracker with credit, exactly as evidenced. Nothing will be
characterized as adoption or endorsement beyond the evidence you
publish.

This is experimental research software, not a production billing
product, and it claims neither authorization nor exactly-once
provider execution. The invitation is to evaluate it on exactly
those terms.
