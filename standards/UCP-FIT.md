# SCQ v0.6.1 — Fit with Universal Commerce Protocol (UCP)

**Assessment date:** 2026-08-27

## Conclusion

SCQ fits **UCP's discovery/service architecture** better than it fits any one existing UCP root capability, but it is **not naturally a third-party extension of Checkout, Cart, or Order**.

If implemented in the UCP ecosystem today, the cleanest technical form would be a **third-party root capability (and, if needed, a custom service)** that uses UCP's namespacing, discovery, negotiation, and transport conventions—rather than pretending SCQ augments checkout.

That is a different proposition from “UCP third-party extension,” which is why a protocol-neutral publication remains preferable before choosing a UCP binding.

## Relevant UCP architecture

UCP separates:

- **services** — API surfaces/transport bindings;
- **capabilities** — features within a service;
- **extensions** — capabilities that declare `extends` and augment parent root capabilities;
- reverse-domain namespaces — allowing vendor/organization-controlled capabilities without a central registry.

UCP's current standard shopping roots include Cart, Checkout, and Order.

Third-party extensions commonly extend one or more UCP-defined roots and compose schemas into those parent operations. UCP also explicitly describes service namespaces as an extensibility mechanism for new verticals.

## Mapping SCQ to existing UCP roots

### Checkout

**Poor fit.** Checkout manages a purchase before completion. SCQ changes an existing long-lived subscription after it already exists.

UCP's Payment Terms extension reinforces this boundary: it explicitly says recurring commerce is out of scope and that payment schedules settle the current checkout rather than create future purchases/renewals.

### Cart

**No meaningful fit.** SCQ does not build a basket or represent pre-purchase intent.

### Order

**Adjacent but incomplete fit.** UCP Order is the closest root because it models post-purchase state, adjustments, cancellation, and a `...order:manage` scope for post-purchase operations.

However, the current Order operation surface is principally retrieval plus lifecycle events. More importantly, a subscription is not necessarily equivalent to an order:

- it may have originated outside UCP;
- it may span many renewals and invoices;
- the SCQ target is the subscription relationship, not a single historical checkout/order;
- forcing an order/`checkout_id` ancestry would make SCQ less provider-neutral.

Therefore SCQ should not be encoded as an Order extension merely because Order is the nearest post-purchase object.

## UCP Actions are not SCQ

UCP Actions represent extension-defined outstanding work that a Platform must process before some effect can proceed. They are useful for challenges, verification, or other gated work in capabilities that explicitly adopt Actions.

SCQ's quote is different:

- the agent initiated the commercial mutation intent;
- the quote describes consequences and guarantee strength;
- commit is a deliberate mutation step;
- the quote is not simply an outstanding UI/action challenge surfaced by the business.

Actions could potentially appear *inside* a future SCQ/UCP binding for external verification, but they should not replace the SCQ lifecycle.

## Natural UCP-shaped deployment

A third party could publish a namespaced root capability, for example:

```text
org.example.subscriptions.change_quote
```

with no `extends`, backed by a custom or compatible service such as:

```text
org.example.subscriptions
```

and advertise REST/MCP bindings in `/.well-known/ucp` using UCP's normal discovery and exact-version negotiation.

Illustrative operations:

```text
get_subscription
create_subscription_change_quote
commit_subscription_change_quote
```

This would reuse UCP's strongest architectural assets without claiming that SCQ is semantically part of checkout.

Whether UCP governance wants custom root capabilities/services to become standardized `dev.ucp.*` capabilities is a separate standards question. SCQ should not assume the answer in advance.

## Concepts UCP can reuse directly

- reverse-domain capability naming;
- business/platform profiles;
- capability version negotiation;
- REST and MCP service bindings;
- UCP identity/authentication mechanisms in a binding;
- common error/message conventions where appropriate.

## Concepts SCQ still needs independently

- subscription snapshot semantics;
- change proposal and quote resource;
- quote-level guarantee coverage;
- EXACT/REVALIDATE semantics;
- acceptance envelope;
- quote expiration and quote-id commit replay;
- effective intent;
- multi-change consistency and no-partial-execution rule;
- consistency guarantee;
- committed-effect reconciliation.

## Why not publish SCQ only as a UCP third-party extension?

A standard UCP extension augments a parent capability's existing schema/operations. SCQ's core value requires a new lifecycle and resource type. Forcing it under Checkout or Order would make the parent relationship carry semantics it does not currently have.

The protocol-neutral SCQ specification can later define a **UCP binding/profile** that says how SCQ is advertised and transported using UCP. This keeps the commercial semantics independent while still gaining UCP interoperability.

## Recommendation for UCP

Do not target a Checkout/Cart/Order third-party extension as the first publication.

After neutral review, prototype a UCP binding that treats SCQ as a namespaced root capability/custom service. Use that prototype to ask UCP maintainers whether they see a natural future standardized root or post-purchase capability.

## Current sources reviewed

- UCP overview: https://ucp.dev/specification/overview/
- UCP core concepts: https://ucp.dev/documentation/core-concepts/
- UCP Order: https://ucp.dev/specification/order/
- UCP Order REST binding: https://ucp.dev/specification/shopping/order/rest/
- UCP Actions (draft overview): https://ucp.dev/draft/specification/overview/
- UCP Payment Terms: https://ucp.dev/specification/payment/extensions/terms/
