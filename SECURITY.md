# Security policy — SCQ experimental preview

SCQ is an **experimental specification and simulator-backed reference implementation** (`@agorail-labs/scq-reference@0.6.2-experimental.1`), not a production billing, payment authorization, identity, or entitlement system. No published security-support lifecycle or response SLA is offered for the experimental line.

## Supported versions

| Version | Support |
|---|---|
| `0.6.2-experimental.1` (published) | Experimental — reports accepted and triaged; no SLA. Durable-store use is supported on Node 22/24 (see `docs/SUPPORT.md` for the Node 26 dependency caveat) |
| Repository source (v0.7 development line) | Best-effort |

A stable-line maintenance and vulnerability-fix policy takes effect only with an approved 1.0 release; the program's security audit is `docs/SECURITY-AUDIT.md`.

## Reporting a vulnerability

Please do **not** put credentials, account identifiers, customer information, exploit details, or other non-public security-sensitive material into a public GitHub issue or discussion.

If the repository has GitHub **Private vulnerability reporting** enabled, use **Security → Report a vulnerability** on the repository. If that feature is unavailable, use a private contact method listed by the repository owner on their GitHub profile. Do not assume public issues are private. General non-sensitive issues, documentation errors and conformance observations may be reported through [GitHub Issues](../../issues).

## Scope

Reports are useful for misleading safety guarantees, quote/commit idempotency failures, authorization-boundary confusion, stale-state enforcement defects, unsafe partial application, and accidental credentials or personal data in the repository. A finding in the simulator is not proof of an exploitable flaw in a named billing provider.

SCQ's `acceptanceEnvelope` is a **relative quote-drift tolerance**, not a spending authorization or a complete financial limit. The protocol does not guarantee that all taxes, fees, contracts or entitlements are modeled. A `BEST_EFFORT` outcome can mutate a provider before reconciliation detects a violation; it is not a rollback mechanism.

Review the [specification's security considerations](spec/security-considerations.md) and the [evidence register](research/EVIDENCE.md) before deploying an independently developed adapter. Production integrations require their own security assessment and live-provider validation.
