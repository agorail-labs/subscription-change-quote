# Security policy — SCQ experimental preview

SCQ v0.6.1 is an **experimental specification and simulator-backed reference implementation**, not a production billing, payment authorization, identity, or entitlement system. No published security-support lifecycle or response SLA is offered.

## Reporting a vulnerability

Please do **not** put credentials, account identifiers, customer information, exploit details, or other non-public security-sensitive material into a public GitHub issue or discussion.

If the repository has GitHub **Private vulnerability reporting** enabled, use **Security → Report a vulnerability** on the repository. If that feature is unavailable, use a private contact method listed by the repository owner on their GitHub profile. Do not assume public issues are private. General non-sensitive issues, documentation errors and conformance observations may be reported through [GitHub Issues](../../issues).

## Scope

Reports are useful for misleading safety guarantees, quote/commit idempotency failures, authorization-boundary confusion, stale-state enforcement defects, unsafe partial application, and accidental credentials or personal data in the repository. A finding in the simulator is not proof of an exploitable flaw in a named billing provider.

SCQ's `acceptanceEnvelope` is a **relative quote-drift tolerance**, not a spending authorization or a complete financial limit. The protocol does not guarantee that all taxes, fees, contracts or entitlements are modeled. A `BEST_EFFORT` outcome can mutate a provider before reconciliation detects a violation; it is not a rollback mechanism.

Review the [specification's security considerations](spec/security-considerations.md) and the [evidence register](research/EVIDENCE.md) before deploying an independently developed adapter. Production integrations require their own security assessment and live-provider validation.
