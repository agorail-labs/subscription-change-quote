# SCQ v0.6.1 — Standards Recommendation

**Assessment date:** 2026-08-27

| Criterion | ACP SEP | UCP third-party extension | Protocol-neutral first |
|---|---:|---:|---:|
| Semantic fit | 4/5 | 2.5/5 | 5/5 |
| Low adaptation required | 3/5 | 2.5/5 | 5/5 |
| Clear governance/contribution path | 5/5 | 3.5/5 | 3/5 |
| Likelihood of useful reviewer feedback | 5/5 | 4/5 | 4/5 |
| Preserves provider neutrality | 4/5 | 4/5 | 5/5 |
| Adoption potential | 4.5/5 | 4.5/5 | 3.5/5 |

ACP is the strongest eventual standards target. Its mission explicitly includes subscription commerce, and its SEP process is designed for exactly the kind of substantial interoperability feature SCQ represents. SCQ also arrives with unusually strong SEP inputs: normative semantics, a reference implementation, conformance tests, security analysis, multi-provider research, and live Chargebee evidence.

The problem is structural: ACP's current public extension framework augments checkout, while SCQ is a separate post-purchase lifecycle over an existing subscription. Submitting it immediately as an “extension” risks spending the first review cycle arguing about how to squeeze it into checkout instead of whether the commercial-safety model is correct.

UCP has a highly attractive discovery and capability architecture. Its reverse-domain namespaces and extensible services could host SCQ cleanly as a custom root capability/service. But that is not the common third-party-extension pattern, and none of Cart, Checkout, or Order is an honest parent for the full SCQ lifecycle. UCP Order is adjacent but still anchored to a historical checkout/order, while SCQ targets a long-lived subscription relationship.

The best sequence is therefore:

1. Publish SCQ v0.6.1 as a small protocol-neutral external-review draft with the spec, examples, evidence register, security considerations, and conformance suite.
2. Immediately use that neutral artifact to open an ACP pre-SEP discussion asking whether ACP wants a dedicated post-purchase subscription-change capability.
3. In parallel or after first feedback, produce a thin UCP binding that reuses UCP discovery/transport without changing SCQ semantics.

This is not an argument to create a competing commerce protocol. The neutral publication is a **semantic staging point**: it makes the tested abstraction reviewable without prematurely inheriting one host protocol's resource model. If ACP accepts the problem framing, ACP should become the first formal standards contribution target.

**PROTOCOL_NEUTRAL_FIRST**
