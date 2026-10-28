# SCQ v0.6.1 — Security and Safety Considerations

SCQ is a **commercial-change safety protocol**, not an identity or authorization system. A deployment must bind SCQ operations to an external authentication/authorization mechanism appropriate to its environment.

## Security boundary

SCQ standardizes what an agent can learn and assert about a proposed subscription mutation:

- what change is requested;
- what commercial effects are predicted;
- how strongly those effects are guaranteed;
- what amount of drift the caller accepts;
- whether the underlying provider can execute a multi-change request safely;
- what actually happened at commit time.

SCQ does **not** prove who the caller is or whether the caller is legally/organizationally entitled to change the subscription.

## 1. TOCTOU and lost updates

A provider may expose a version/fingerprint that SCQ can read, yet offer no server-enforced compare-and-swap on the mutation itself. In that case:

```text
read -> validate -> preview -> mutate
```

contains a race window.

A concurrent writer may change the subscription after SCQ's last validation but before the mutation. SCQ must report `ConsistencyGuarantee: BEST_EFFORT` where this window cannot be closed natively.

Mitigations:

- pre-mutation staleness check;
- immediate re-preview for `REVALIDATE`;
- post-commit reconciliation;
- audit logging and alerting on `reconciliation.status = VIOLATED`;
- provider-native compare-and-swap if a future provider exposes one.

A client-side lock must not be represented as provider-backed atomicity because it cannot coordinate independent actors or independent SCQ deployments.

## 2. Stale quotes

A quote captures a precondition on subscription state. If the state changes before commit, SCQ must refuse with `QUOTE_STALE` before mutation.

A fingerprint is only as strong as its covered inputs. Provider-native versions are preferable when available, but even a native version does not imply atomic mutation unless the provider enforces it on the same write request.

## 3. Quote expiry

Quotes are time-bounded through `validUntil`.

A commit attempted after expiration must fail with `QUOTE_EXPIRED` and perform no mutation, unless the quote was already successfully committed earlier—in which case idempotent replay returns the original receipt rather than retroactively invalidating the prior commit.

Expiry reduces, but does not eliminate, drift and concurrency risk.

## 4. Commit replay and idempotency

v0.6.1 makes a successful `quoteId` commit idempotent:

- first successful commit stores the receipt;
- repeated commit of the same quote returns that original receipt;
- the provider mutation must not be repeated.

Remaining limitation: SCQ does not deduplicate **different quote IDs** that encode the same business intent. An agent that creates two distinct quotes for “add 20 seats” and commits both may still cause two legitimate mutations. Cross-quote intent deduplication is outside v0.6.1.

## 5. Acceptance-envelope bypass

For `REVALIDATE`, the acceptance envelope must be evaluated against the **last non-mutating preview before mutation**. The adapter must not:

- compare against an older cached preview;
- silently widen omitted tolerances;
- ignore a dimension because the provider makes it inconvenient to calculate;
- downgrade an out-of-envelope result into a warning.

If the preview exceeds the envelope, SCQ must return `QUOTE_DRIFTED` with no mutation.

The envelope is a drift-control primitive, not a user-identity or spending-authorization mandate. Systems needing legal/organizational authorization must enforce it separately.

## 6. Post-commit reconciliation limitation

With `BEST_EFFORT`, a concurrent write may change the final outcome after the last preview. v0.6.1 therefore requires reconciliation of `committedEffect` against the envelope.

`VIOLATED` is a reporting obligation. It does not imply rollback, reversal, refund, or re-authorization. Implementations should define operational handling for this event, including alerts, human review, compensating actions, or provider-specific reversal where safe.

## 7. Silent partial execution

Some provider APIs may accept unknown or inapplicable fields, return success, and apply only the fields they recognize.

This is especially dangerous for autonomous agents because HTTP success can be mistaken for semantic success.

SCQ requires adapters to refuse a multi-change proposal with `UNSUPPORTED_CHANGE_SET` before mutation when the provider request shape risks silent subset application.

Adapters must not deliberately “try it and inspect afterward” for an operation that cannot be rolled back atomically.

## 8. Capability overstatement

Provider-level capability discovery is advisory/coarse; quote-level `GuaranteeCoverage` is authoritative for a specific subscription state and proposal.

An adapter must not advertise a guarantee stronger than actual enforcement can deliver. Overall `EXACT` must be rejected if any modeled dimension is not exact.

`UNKNOWN` is safer than guessing.

## 9. Malicious or compromised adapters

An SCQ adapter sits in a privileged position between the agent and billing provider. A compromised adapter could:

- falsify a quote;
- overstate `GuaranteeCoverage`;
- omit a term consequence;
- widen an envelope;
- return a fabricated receipt;
- submit a different mutation than the proposal.

SCQ's type system cannot by itself prevent a malicious implementation. Production deployments should use normal software-supply-chain controls, authenticated provider connections, tamper-evident audit logs, request/response correlation, and independent provider-side reconciliation where available.

For higher-assurance environments, quote and receipt signing could be layered above SCQ; cryptographic signing is intentionally not defined by v0.6.1.

## 10. Quote tampering and integrity

`quoteId`, proposal, preconditions, commercial effects, guarantee coverage, and expiry are security-sensitive. Implementations should store authoritative quote state server-side or protect serialized quote state against client modification.

A caller must not be able to modify an envelope or proposal after quote creation while reusing the same quote identifier.

## 11. Effective-time substitution

`IMMEDIATE`, `TERM_END`, and `DATE` are semantically distinct. An adapter must validate support before preview/mutation and must not silently substitute one for another.

A silent `DATE -> IMMEDIATE` substitution could create an immediate financial or contractual effect the caller never approved.

## 12. Unknown contract effects

A provider that cannot deterministically expose commitment, renewal, or early-termination consequences must report `termEffect: UNKNOWN`. SCQ must not infer “no commitment” from the absence of a provider field.

This is particularly important for enterprise billing systems where contractual logic may live outside the immediate subscription-update response.

## 13. Sensitive data

SCQ should carry only the subscription and commercial data necessary to evaluate a change. It should avoid embedding payment credentials, identity credentials, or unrelated customer PII in `providerMetadata` or audit logs.

## 14. Relationship to authorization protocols

SCQ intentionally does not define:

- authentication;
- buyer identity;
- agent identity;
- delegation;
- payment authorization;
- cryptographic mandates;
- consent capture.

A standards integration should reuse the host protocol's mechanisms for those concerns. SCQ answers a different question: **given an authorized actor, can the actor understand and safely bound the commercial consequences of the subscription mutation it is about to request?**
