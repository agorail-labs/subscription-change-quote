# Contributing to SCQ

SCQ v0.6.1 is a **frozen protocol version** under external review. The specification, reference
implementation, and test suite are not being actively redesigned while feedback is collected.

## How to give feedback

- **Open an [Issue](../../issues)** for a specific, actionable problem: a bug in the reference
  implementation, a factual error in the spec or research documents, a conformance-suite gap, or
  a concrete proposed change.
- **Use [Discussions](../../discussions)** for open-ended questions, integration experience, architectural feedback, and the draft ACP pre-SEP topic. No accepted standard or existing external standards discussion is implied.

Feedback is triaged as issues first. The protocol itself will not change in response to a single
comment or discussion post — any actual change to `spec/`, `reference/src/`, or
`reference/tests/` will be made deliberately, referencing the specific issue(s) it addresses.

## Evidence standards

If you're proposing a claim about provider behavior (Stripe, Paddle, Zuora, Chargebee, or any
other billing system), please be explicit about its evidence level, consistent with
[`research/EVIDENCE.md`](research/EVIDENCE.md):

```text
LIVE_API_VALIDATED
DOCUMENTATION_BACKED_SIMULATION
INFERRED
UNVERIFIED
```

Claims presented as live-validated without actual API evidence will be corrected.
