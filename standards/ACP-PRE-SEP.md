# ACP Pre-SEP Discussion Draft: Agent-Safe Subscription Change Quotes

**Status:** Pre-SEP / request for maintainer feedback  
**Proposed name:** Subscription Change Quote (SCQ)  
**Author:** TBD before posting  
**Target:** Agentic Commerce Protocol community discussion  

> This is intentionally **not yet a formal SEP**. The goal is to determine whether the problem belongs in ACP, and if so whether it should become a new capability/lifecycle, an extension, or something outside ACP.

## Abstract

Autonomous agents increasingly need to manage subscriptions after checkout: increase seat quantity, change plan, change billing cadence, or cancel. Existing billing providers expose these operations, but they disagree materially on preview semantics, effective timing, term consequences, concurrency guarantees, and whether multiple changes can be applied safely as one operation.

This draft proposes a narrow interoperability model for an agent to:

1. inspect an existing subscription,
2. propose one or more subscription changes,
3. receive a non-mutating machine-readable quote describing the commercial consequences and guarantee strength,
4. approve those consequences within an explicit acceptance envelope,
5. commit the quote safely or fail explicitly,
6. receive a receipt distinguishing quoted from committed effects and reporting post-commit reconciliation.

The proposal does **not** define identity, authorization, payment authorization, checkout, subscription creation, or negotiation. It is intended to complement those concerns.

The open question for ACP maintainers is whether this post-purchase commercial-mutation lifecycle belongs in ACP at all, and if it does, what the smallest ACP-native surface should be.

## Why raise this with ACP?

ACP describes itself as an open protocol for programmatic commerce between buyers, agents, and businesses and explicitly supports commerce including subscriptions. Its current public API, however, is centered on creating, updating, completing, and canceling **checkout sessions**. ACP's extension framework adds optional fields to that checkout schema through capability negotiation.

Subscription lifecycle mutation is a different interaction boundary:

```text
checkout completed
      |
      v
existing long-lived subscription
      |
      +--> increase quantity
      +--> change plan
      +--> change cadence
      +--> cancel
```

These operations can create charges, credits, new recurring amounts, timing changes, and contractual effects without creating a new checkout.

The proposal is therefore being brought first as a pre-SEP question rather than presented as a straightforward ACP extension.

## Motivation

Consider an agent managing a 100-seat SaaS subscription.

The user asks:

> Increase us to 120 seats, but don't spend more than $250 immediately or raise the monthly bill above $2,200.

A provider-specific SDK can perform the mutation. What the agent lacks is a portable contract for answering, before mutation:

- What is due immediately?
- What will the recurring amount become?
- When does the change take effect?
- Does it change a commitment or term?
- Is the preview exact or only revalidated at commit time?
- Can several requested changes be committed together?
- Can a concurrent write invalidate the decision between preview and mutation?
- Did the final committed effect remain within the agent's approved policy?

The difficulty is not simply field naming. Provider semantics differ.

Research prototypes across Stripe-, Paddle-, Zuora-, and Chargebee-shaped billing systems found examples of:

- wall-clock-sensitive preview drift,
- providers with and without explicit future-effective changes,
- providers with richer contract-term models,
- native version fields that improve stale-state detection but do not provide atomic compare-and-swap,
- providers that can bundle cancellation with another change and providers that cannot,
- and live Chargebee behavior where malformed attempts to combine cancellation with another mutation can succeed at the HTTP layer while only the recognized part of the request is applied.

A protocol-level safety layer can make these differences explicit instead of requiring each agent to encode billing-provider-specific knowledge.

## Existing ACP mechanisms considered

### Checkout session update

ACP's checkout update operation changes the state of an active checkout session. SCQ operates on an already-existing subscription after checkout is over. Modeling subscription mutation as a checkout-session update would conflate two lifecycles and require inventing or recreating checkout state solely to modify an existing commercial relationship.

### ACP extensions

ACP extensions are advertised through capability negotiation and add optional fields to the checkout schema. This is attractive for discovery and namespacing, but SCQ is not only additional data on a checkout object. It has its own read → quote → commit lifecycle, quote lifetime, stale-state behavior, idempotent commit semantics, and receipt.

A third-party ACP extension could potentially advertise support for SCQ, but the current extension model does not obviously provide the lifecycle itself.

### Order lifecycle

ACP order objects describe post-checkout order state and webhooks synchronize order lifecycle events. A subscription mutation may create billing artifacts, but the object being intentionally changed is the ongoing subscription/commercial agreement, not merely an existing fulfillment order.

### Authorization and payment handling

SCQ intentionally does not replace ACP authentication, payment handlers, delegated payments, or any external authorization/mandate system. Those mechanisms determine whether an actor may perform an operation and how payment credentials are handled. SCQ describes the commercial consequence and commit contract for a subscription mutation.

## Proposed minimal lifecycle

The current protocol-neutral model has four operations:

```text
getSubscription(id)
createChangeQuote(id, proposal)
commitChangeQuote(quoteId)
getCapabilities()
```

The conceptual lifecycle is:

```text
SubscriptionSnapshot
        |
        v
SubscriptionChangeProposal
        |
        v
SubscriptionChangeQuote
        |
        v
agent evaluates commercial effect / policy
        |
        v
commitChangeQuote
        |
        v
SubscriptionChangeReceipt
```

This pre-SEP does **not** ask ACP to adopt these endpoint names verbatim. They are presented as the smallest behavior that interoperable implementations need to preserve.

## Change scope

The frozen research profile supports exactly four actions:

```text
CHANGE_QUANTITY
CHANGE_PLAN
CHANGE_CADENCE
CANCEL
```

Subscription creation, pause/resume, usage billing, negotiation, procurement, renewal negotiation, and arbitrary contract amendment are intentionally outside scope.

## Proposal shape

A proposal contains one or more changes plus one effective-time intent:

```json
{
  "changes": [
    {
      "action": "CHANGE_QUANTITY",
      "itemId": "seat",
      "quantity": 120
    }
  ],
  "effectiveIntent": {
    "type": "IMMEDIATE"
  },
  "guaranteeMode": "REVALIDATE",
  "acceptanceEnvelope": {
    "maxImmediateNetIncrease": 25000,
    "maxRecurringIncrease": 30000
  }
}
```

Effective timing is explicit:

```text
IMMEDIATE
TERM_END
DATE(at)
```

An implementation must refuse an effective intent it cannot honor rather than substitute another timing policy.

## Quote semantics

A quote must communicate both the normalized commercial effect and the strength of the guarantee behind it.

Illustrative shape:

```json
{
  "id": "scq_123",
  "subscriptionRef": "sub_123",
  "guaranteeMode": "REVALIDATE",
  "guaranteeCoverage": {
    "immediateFinancialEffect": "REVALIDATE",
    "recurringFinancialEffect": "REVALIDATE",
    "termEffect": "UNKNOWN",
    "effectiveAt": "EXACT"
  },
  "multiChangeConsistency": "ATOMIC",
  "commercialEffect": {
    "immediate": {
      "net": 20000
    },
    "recurring": {
      "resultingAmount": 216000,
      "currency": "usd"
    },
    "effectiveAt": "2026-09-01T00:00:00Z"
  },
  "validUntil": "2026-08-27T21:30:00Z"
}
```

The quote-level guarantee is authoritative for the specific subscription state and proposal. Provider-level capability discovery is intentionally coarser.

## Guarantee semantics

### REVALIDATE

`REVALIDATE` is the default.

Immediately before mutation, the implementation obtains a fresh non-mutating preview and evaluates the result against the caller's explicit `AcceptanceEnvelope`.

If the preview exceeds the approved bounds:

```text
QUOTE_DRIFTED
```

must be returned and no mutation may occur.

Where the underlying provider has no server-enforced state-precondition + mutation primitive, this check still leaves a TOCTOU window. The receipt therefore reports:

```text
ConsistencyGuarantee: BEST_EFFORT
```

rather than implying atomicity.

### EXACT

`EXACT` is available only when the adapter can guarantee the dimensions marked `EXACT` in `GuaranteeCoverage`.

It does not imply exactness for effects outside the normalized commercial-effect model, such as provider-specific tax, discount, or currency-conversion behavior that the implementation does not model.

An implementation must refuse an `EXACT` request when any required guarantee dimension is not exact. It may not silently downgrade the request.

## Acceptance envelope

The acceptance envelope is the caller's machine-readable approval boundary.

For example:

```json
{
  "maxImmediateNetIncrease": 25000,
  "maxRecurringIncrease": 30000
}
```

The point is not to make the billing provider authoritative for agent policy. The provider supplies a fresh commercial consequence; the agent declares what drift it is willing to accept.

## Multi-change safety

A proposal may contain several changes.

The quote reports whether that set is:

```text
ATOMIC
BEST_EFFORT
UNSUPPORTED
```

A conforming implementation must refuse a change set before mutation if the underlying provider may silently apply only a subset while still reporting success.

This requirement is motivated by observed live behavior, not only a theoretical concern. During Chargebee test-site validation, attempts to mix cancellation parameters with unrelated item-change parameters could return HTTP 200 while only the semantics recognized by the selected endpoint took effect.

The intent of this rule is simple:

> A successful agent-facing commit must never knowingly mean "some unknown subset of what you asked for happened."

## Staleness and concurrency

A quote captures a subscription version/fingerprint precondition.

Before mutating, the implementation must compare that precondition with current subscription state and reject a stale quote with:

```text
QUOTE_STALE
```

This improves safety but does not create atomicity when the provider exposes no compare-and-swap primitive.

The research found examples of both:

- synthetic state fingerprints, and
- a real provider version field,

but neither is sufficient by itself if the provider cannot condition the mutation on that same version atomically.

## Quote expiration and commit idempotency

A quote carries `validUntil`.

- An uncommitted quote used after expiration must fail with `QUOTE_EXPIRED` and perform no mutation.
- Repeating the commit of an already-successfully-committed quote must return the original receipt and must not apply the underlying change twice.

The current research profile provides idempotency at the quote level. Cross-quote semantic deduplication is not proposed.

## Receipt and reconciliation

A successful receipt includes both:

```text
quotedEffect
committedEffect
```

For `REVALIDATE`, they may differ by design.

v0.6.1 also requires post-commit reconciliation against the caller's acceptance envelope:

```json
{ "reconciliation": { "status": "OK" } }
```

or:

```json
{
  "reconciliation": {
    "status": "VIOLATED",
    "reason": "..."
  }
}
```

This is a reporting obligation, not a second authorization step. If the underlying provider has only `BEST_EFFORT` consistency, a race can change the final outcome after the last safe pre-mutation preview. Reconciliation makes that outcome explicit but cannot retroactively prevent or roll back the already-executed provider mutation.

## Capability discovery

Provider-level discovery answers questions such as:

- Which actions are supported?
- Which effective intents are available for each action?
- Which guarantee dimensions may be exact?
- Is state-precondition + mutation atomic or best-effort?

The specific quote remains authoritative because capability strength may depend on the actual subscription state.

This distinction has proven important for contract-term behavior, where a provider can know a consequence for an evergreen subscription but not for the same action against a committed-term subscription.

## Error model

The protocol-neutral prototype currently distinguishes errors including:

```text
UNSUPPORTED_CHANGE
UNSUPPORTED_CHANGE_SET
INVALID_PROPOSAL
QUOTE_EXPIRED
QUOTE_STALE
QUOTE_DRIFTED
CHANGE_CONFLICT
PROVIDER_ERROR
```

The exact ACP mapping of these codes is deliberately left open for discussion rather than asserting new ACP message codes prematurely.

## Security and safety implications

### TOCTOU

If the billing provider lacks a server-enforced compare-and-swap mutation, there is an unavoidable window between state validation / preview and mutation. The proposal requires implementations to disclose `BEST_EFFORT` rather than manufacture atomicity locally.

### Replay

Quote-scoped commit idempotency prevents retry loops from applying the same successful quote twice.

### Stale approvals

Quote expiration plus subscription preconditions limit use of old commercial approvals against changed state.

### Commercial-policy bypass

An adapter must not silently ignore an acceptance envelope, substitute an unsupported effective time, or downgrade an exact guarantee request.

### Partial execution

An adapter must refuse a multi-change set that may silently execute only a subset.

### Malicious or incorrect adapters

As with any merchant-implemented commerce protocol, a malicious adapter can misreport its own capabilities or effects. SCQ's conformance rules can make incorrect behavior testable; they cannot make an untrusted merchant implementation honest. Authentication, trust, dispute handling, and external auditing remain separate concerns.

## Evidence / implementation status

There is a working TypeScript research prototype with provider-neutral core types, a shared engine, reference adapters, and a conformance-oriented test suite.

The model has been exercised across four different provider shapes:

- Stripe
- Paddle
- Zuora
- Chargebee

The v0.6.1 hardening report contained 66 passing tests; the suite has since grown to 84 with the mocked-transport Chargebee live-validation tests (none of them a live API test).

Evidence quality differs by provider and should remain explicit:

- **Chargebee:** limited historical live test-site observations were made in a prior cycle for some scenarios (see research/EVIDENCE.md, including its Phase 2A correction note); this is not a validation of the current adapters, and no live testing was performed in the most recent cycles.
- **Stripe / Paddle / Zuora:** documentation-backed simulator/reference-adapter research; not represented as live API validation.

One Chargebee scenario — cancellation under an enabled Contract Terms feature — remains `UNVERIFIED` because the available test site did not have that feature enabled.

The most important live safety result was that malformed cancellation + mutation attempts could succeed at the HTTP layer while silently ignoring the unrecognized half of the intended operation. This directly motivated the normative no-partial-execution rule.

## Backward compatibility

This draft does not propose modifying existing ACP checkout request or response semantics.

If the concept is accepted into ACP, the preferred design should be opt-in and discoverable so existing ACP checkout implementations remain conformant without implementing subscription change management.

Whether this is represented as:

- a new ACP capability/service,
- a new endpoint family,
- an extension that advertises a separate lifecycle,
- or an external protocol with an ACP binding,

is intentionally left open for maintainer feedback.

## Alternatives considered

### 1. Treat billing-provider previews as sufficient

Rejected for the research prototype because providers disagree on guarantee strength, timing, concurrency, term semantics, and multi-change behavior. A preview call alone does not give an agent a portable policy/commit contract.

### 2. Model this as checkout update

This would reuse an existing ACP endpoint but conflates active checkout state with mutation of an already-existing long-lived subscription.

### 3. Implement only as an ACP checkout extension

Capability negotiation and extension discovery are useful, but current ACP extensions add optional checkout-schema fields. SCQ requires a lifecycle and commit semantics rather than only additional checkout data.

### 4. Standardize provider APIs directly

The research does not attempt to erase provider-specific semantics. SCQ instead standardizes how those differences are reported and safely acted upon.

### 5. Fold authorization / mandates into the proposal

Rejected as unnecessary coupling. Authorization answers whether the agent may act. This proposal answers what the commercial change will do and what guarantee backs that consequence.

## Open questions for ACP maintainers

This pre-SEP is primarily asking for guidance on these questions:

1. **Does post-purchase subscription mutation belong within ACP's intended scope?**
2. If yes, should it be a **new ACP capability / endpoint lifecycle** rather than a checkout-schema extension?
3. Is there an existing ACP object that should identify the subscription/commercial relationship, or should this proposal define its own opaque `subscriptionRef`?
4. Should ACP reuse its existing idempotency conventions for quote commits rather than keep quote-scoped idempotency entirely internal to the SCQ lifecycle?
5. Should SCQ-style guarantee discovery reuse ACP's `capabilities` object, even if the actual quote/commit lifecycle is separate from checkout?
6. Is `CommercialEffect` the right abstraction boundary for ACP, or should an ACP version reuse existing money / totals types while retaining the guarantee semantics?
7. Would maintainers prefer an initial protocol-neutral reference implementation plus an ACP binding, or an ACP-native SEP from the start?

## Smallest proposal worth considering

If maintainers believe this belongs in ACP, the smallest proposal that preserves the research value is **not** "standardize every subscription feature."

It is:

> Define an opt-in, discoverable lifecycle for obtaining and committing a machine-readable quote for a bounded subscription mutation, with explicit guarantee coverage, effective timing, stale-state detection, acceptance-envelope revalidation, idempotent commit, multi-change safety, and receipt reconciliation.

Everything else can remain outside the initial proposal.

## Why this appears SEP-sized

ACP's SEP guidelines say the SEP process is appropriate for substantial new protocol features, new API endpoints/methods, changes to data/message semantics, or new interoperability standards between ACP-compatible tools.

If ACP decides subscription-change quote/commit belongs in the core ecosystem, this proposal likely crosses that threshold because it introduces a new interaction lifecycle rather than a small documentation or schema patch.

The prototype already provides the evidence normally expected before formal review:

- a focused motivation,
- a normative protocol draft,
- a reference implementation,
- provider-specific adapters,
- conformance tests,
- security considerations,
- and live provider evidence for one integration.

## Requested feedback

Before turning this into a formal SEP, feedback is requested on only two decisions:

1. **Is this problem in ACP scope?**
2. **If it is, should the first formal proposal be a new ACP subscription-change capability/lifecycle, or an ACP binding to a protocol-neutral SCQ specification?**

The implementation and schema are intentionally frozen while this architectural question is reviewed.

## Current ACP references consulted

- ACP introduction and checkout documentation: https://www.agenticcommerce.dev/docs
- ACP checkout reference: https://www.agenticcommerce.dev/docs/reference/checkout
- ACP extensions framework: https://www.agenticcommerce.dev/docs/concepts/extensions
- ACP checkout lifecycle: https://www.agenticcommerce.dev/docs/concepts/lifecycle
- ACP SEP guidelines: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/docs/sep-guidelines.md

