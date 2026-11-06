# Your AI Agent Can Change a Subscription. But Can It Explain What Actually Happened?

*DRAFT — practitioner article, not published.*

An AI agent gets a routine instruction: "Increase the workspace from
100 to 120 seats." A human operator making that change in an admin
console would see the price difference, click confirm, and — if
anything looked wrong afterwards — open the subscription and look.
The agent has none of those affordances. It has an API. And the API's
answer to "did it work?" is usually a status code that collapses at
least four different questions into one:

1. Was the change **admissible as a set** — did it include everything
   it depended on?
2. What was it **supposed to cost** — immediately, and recurring?
3. **Did it actually happen** — fully, partially, or not at all?
4. If the response never arrived, **is it safe to retry?**

Those questions have different answers, different evidence, and
different failure modes. Treating them as one boolean is how agents
double-apply changes, silently drop dependent entitlements, and
report success for changes that drifted away from what was approved.

## Three failure modes that a success flag hides

**The incomplete set.** The seat increase is only valid if a
dependent entitlement — say, an analytics add-on the new tier
requires — is added in the same change. Submitted alone, the seat
change can succeed on its own terms while leaving the account in a
state nobody intended. Nothing "failed." The change was simply never
checked as a set.

**The ambiguous timeout.** The provider call times out. The change
may have executed, or not. A blind retry risks applying it twice; not
retrying risks reporting failure for a change that went through. The
honest state here is *indeterminate* — and most systems have no way
to say that, so they guess.

**The quiet drift.** The change executes, but the committed outcome
differs from what was quoted — a different recurring amount, a term
consequence nobody surfaced. If the quote was never recorded as a
commitment, there is nothing to compare the outcome against, and the
drift is discovered on an invoice.

## Two small contracts, one for each half of the problem

Agorail is an experimental, open-source attempt to make those
questions separately answerable, using two protocols that compose
but do not depend on each other.

**MSE (Mutation Safety Envelope)** handles the pre-dispatch half. A
change is modeled as a set of units with declared dependency
relations between them. Before anything is dispatched, admission
evaluates the whole set read-only: either it passes, with
per-relation coverage evidence, or it is refused with a *witness*
that names exactly what is missing — in the seat example, the add-on
unit that must be co-included. Admission is not authorization; it
decides admissibility, not permission.

**SCQ (Subscription Change Quote)** handles the financial half for
subscriptions. A change is quoted before mutation: immediate and
recurring financial effects, how strongly each is guaranteed, and an
explicit UNKNOWN where an effect cannot be established. The caller
states an acceptance envelope — how much drift relative to the quote
is tolerable — and separately decides, in its own policy, whether the
spend is approved at all. (Confusing those two is its own failure
mode: the envelope governs drift, never approval.) After commit, the
receipt records what actually happened, reconciles it against the
quote, and stays immutable; evidence that arrives later is appended,
never rewritten into history. And if the same mutation intent is
executed again — after a restart, say — a durable coordinator replays
the recorded receipt instead of dispatching the change a second time.

You can run the whole story today, against a simulator, in about
five minutes:

```bash
npm install --save-exact @agorail-labs/mse-reference@0.4.0-experimental.1 @agorail-labs/scq-reference@0.6.2-experimental.1
```

The combined example refuses the incomplete seat change, admits the
complete one, quotes it (200.00 immediate, 1,200.00 recurring, in
minor units), commits it under a separate approval policy, and then
demonstrates the restart/replay behavior with exactly one provider
dispatch throughout. The walkthrough is at
[Try Agorail in Five Minutes](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/TRY-AGORAIL-IN-FIVE-MINUTES.md).

## What this deliberately does not claim

These are experimental reference implementations, tested against
simulators — not production billing integrations. MSE and SCQ do not
provide authorization, exactly-once execution at a real provider,
atomic cross-provider updates, or certified billing safety. The
timeout case is the clearest example: no client-side protocol can
prove what a provider did with a request whose response was lost.
What SCQ offers there is not a guarantee but a discipline — record
the intent durably, mark the outcome indeterminate, reconcile against
independently established evidence, and never let a retry guess.

The most useful response to work like this is not adoption; it is
falsification. The projects maintain an
[independent review package](https://github.com/agorail-labs/subscription-change-quote/blob/main/docs/INDEPENDENT-MSE-SCQ-REVIEW.md)
with concrete counterexample questions — concurrent changes that
overwrite each other, two-ledger gaps, forged admission evidence —
and an adoption tracker that records only publicly verifiable
evidence. If you run the packages and find a place where the recorded
receipt and reality can diverge, that finding is the contribution.

An agent that changes commercial state should be able to answer, for
every change: what was allowed, what was quoted, what was approved,
and what actually happened — with evidence attached to each answer,
and an honest "unknown" where the evidence runs out. That is a
modest requirement. It is also, today, mostly unmet.
