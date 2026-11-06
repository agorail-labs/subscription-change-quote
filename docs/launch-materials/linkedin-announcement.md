# LinkedIn announcement — DRAFT, NOT POSTED

We are giving AI agents the ability to change commercial state:
upgrade the plan, add seats, amend the contract. What we have not
given them is a disciplined way to answer the questions a careful
human operator answers instinctively:

Was this change complete — did it include everything it depended on?
What was it supposed to cost? Who approved that spend? And when the
API call timed out… did it actually happen?

A single SUCCESS flag collapses all four. That's how automated
changes get double-applied, dependent entitlements get silently
dropped, and drift from the approved quote is discovered on an
invoice instead of at commit time.

Agorail is an experimental open-source project I've been building to
make those questions separately answerable, as two small safety
contracts:

→ MSE (Mutation Safety Envelope) — a read-only admission gate for
multi-unit changes. It checks declared dependencies before anything
is dispatched and refuses an incomplete change with a witness naming
exactly what's missing.

→ SCQ (Subscription Change Quote) — a quote → commit → receipt
lifecycle for subscription changes: financial consequences and their
guarantee strength up front, drift checked against the approved
quote, an immutable receipt reconciled against what actually
happened, and durable replay so a retried intent returns the
recorded receipt instead of dispatching twice.

Both are published as experimental npm packages and run end-to-end
against simulators in about five minutes — no billing credentials
required. They are deliberately honest about their limits: no
authorization (approval stays in your policy code, where it
belongs), no exactly-once claims at a real provider, no production
certification. Where evidence runs out, the protocols say UNKNOWN or
INDETERMINATE rather than guessing.

The most valuable contribution at this stage isn't adoption — it's
falsification. The repos include an independent review package with
concrete counterexample questions, and external findings are
recorded only when they're publicly reproducible.

Try it: https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md
MSE: https://github.com/agorail-labs/mutation-safety-envelope
SCQ: https://github.com/agorail-labs/subscription-change-quote

#AIagents #PlatformEngineering #BillingSystems #OpenSource
