# SCQ v0.6.1 — Fit with Agentic Commerce Protocol (ACP)

**Assessment date:** 2026-08-27

## Conclusion

SCQ is a strong **ACP SEP candidate**, but it is **not naturally expressible as a normal ACP checkout extension today**.

ACP publicly positions itself as supporting physical goods, digital goods, subscriptions, and asynchronous purchases. However, the current operational core exposed to sellers is still centered on creating, updating, completing, retrieving, and canceling **checkout sessions**. ACP's extension framework adds optional fields to the checkout schema and negotiates those additions within a checkout session.

SCQ begins after a subscription already exists and defines a new mutation lifecycle: inspect -> quote -> evaluate -> commit -> reconcile. That is a protocol feature, not merely extra checkout metadata.

## Current ACP concepts SCQ can reuse

| ACP concept | SCQ fit |
|---|---|
| Capability negotiation | Strong reuse. Agents/sellers should be able to discover whether subscription-change quoting is supported before attempting it. |
| Extension naming/versioning | Useful for namespacing ancillary fields, but insufficient by itself because SCQ needs operations/lifecycle, not just fields. |
| Authentication/security patterns | Reuse host ACP authentication/signing rather than defining SCQ-specific identity. |
| Idempotency conventions | Strong conceptual fit with SCQ v0.6.1 quote-level commit idempotency. |
| Error/message conventions | Can be mapped to ACP error structures while preserving SCQ error semantics. |
| Order/webhook concepts | Potential audit/reconciliation integration, but not the request path for changing an existing subscription. |
| Checkout session | Poor parent. A completed checkout is terminal; SCQ operates on a long-lived commercial relationship after checkout. |

## Why the current ACP extension mechanism is insufficient

ACP's documented extension model is additive to checkout schemas. Extensions declare fields such as discounts or loyalty data and participate in checkout capability negotiation.

SCQ needs at least three distinct operations:

```text
get subscription state
create non-mutating change quote
commit a previously created quote
```

It also has independent resource state (`quoteId`, expiration, preconditions, committed receipt) that outlives a single checkout request/response modification.

Treating this as fields on `CheckoutSessionUpdateRequest` would conflate two different lifecycles:

- constructing a purchase before an order exists; and
- changing an existing ongoing subscription after the purchase exists.

That would weaken both ACP's checkout model and SCQ's semantics.

## Does SCQ qualify for an ACP SEP?

Yes.

ACP's SEP guidelines identify new endpoints/methods, changes to protocol data structures/semantics, and new interoperability standards between ACP-compatible tools as SEP-level work. They also require clear motivation, a technical specification, rationale, backward-compatibility analysis, a reference implementation before final status, and security implications.

SCQ already has most of the evidence package a SEP reviewer would ask for:

- a focused problem statement;
- a normative technical model;
- running reference adapters/simulators;
- a conformance suite;
- multi-provider evidence;
- one live provider validation cycle;
- explicit security limitations;
- documented rejected/modified designs.

The main missing ingredient is **external community feedback/sponsorship**, not protocol substance.

## Smallest focused ACP proposal

If SCQ enters ACP, the smallest defensible SEP is not “add subscription fields to checkout.” It is:

> **Add a Subscription Change Quote capability for safe post-purchase modification of an existing subscription.**

The SEP should preserve SCQ's narrow four-action scope and introduce only the operations required for the lifecycle.

Illustrative ACP-facing operations could be:

```text
GET  /subscriptions/{subscription_id}
POST /subscriptions/{subscription_id}/change_quotes
POST /subscription_change_quotes/{quote_id}/commit
```

The exact ACP URL design should be decided with maintainers; the important point is semantic separation from checkout.

The ACP profile should reuse existing ACP infrastructure for authentication, versioning, errors/messages, and capability negotiation. SCQ should remain explicitly outside payment authorization and delegation.

## Concepts genuinely missing from current ACP checkout semantics

SCQ contributes the following protocol concepts that are not equivalent to current checkout updates:

- authoritative quote-level `GuaranteeCoverage`;
- `EXACT` vs `REVALIDATE` commercial guarantees;
- caller-defined drift envelope;
- explicit `UNKNOWN` contract consequences;
- effective intent for existing-subscription mutations;
- multi-change execution consistency;
- stale subscription preconditions;
- provider concurrency guarantee disclosure;
- quote expiration and quote-level commit idempotency;
- post-commit reconciliation when provider atomicity is unavailable.

## Backward compatibility

A new optional capability/lifecycle can be additive. Existing ACP checkout implementations would remain unchanged when the capability is not negotiated.

The largest design risk is not backward compatibility; it is **scope creep**. A SEP review may try to pull subscription creation, payment mandates, usage billing, entitlements, or contract negotiation into the same proposal. SCQ should resist that until real evidence requires it.

## Recommendation for ACP

Do not translate SCQ into the existing checkout extension format before maintainer review.

Publish the protocol-neutral v0.6.1 package, then open an ACP pre-SEP discussion framed around one question:

> Should ACP define a separate post-purchase subscription-change capability with quote/commit safety semantics?

If maintainers agree the problem belongs in ACP, convert the neutral spec into the formal SEP structure while preserving the tested core.

## Current sources reviewed

- ACP documentation: https://www.agenticcommerce.dev/docs
- ACP architecture: https://www.agenticcommerce.dev/docs/concepts/architecture
- ACP checkout: https://www.agenticcommerce.dev/docs/reference/checkout
- ACP extensions: https://www.agenticcommerce.dev/docs/concepts/extensions
- ACP capability negotiation: https://www.agenticcommerce.dev/docs/concepts/capability-negotiation
- ACP SEP guidelines: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/docs/sep-guidelines.md
