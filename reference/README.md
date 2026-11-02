# @agorail-labs/scq-reference — experimental reference package

> **Experimental — not published on npm, not for production billing.**
> This package is a simulator-backed reference implementation of the
> Subscription Change Quote (SCQ) protocol. It carries `private: true`
> and exists so developers can install it from a locally built tarball
> and evaluate the protocol's behavior. Nothing in it is certified
> provider conformance, and it is not a replacement billing API or a
> production payment SDK.

This package implements the **published SCQ v0.6.2 experimental
specification** (`spec/scq-v0.6.2-spec.md` in the repository). The
specification and this package are separate artifacts: the spec's
publication did not approve this package for release, and this
package's version (`0.6.2-experimental.1`) tracks the spec version it
implements plus an experimental build suffix — it is not a stability
promise.

## What it does

SCQ models a subscription change as a **quote** (a priced, bounded,
expiring proposal), an explicit **approval** decision by the
integrator, and a **commit** whose result is a **receipt** that
reports — from operation-bound evidence — whether the landed change
matches what was authorized:

- `VERIFIED` / reconciliation `OK` — the committed effect is
  established and agrees with the quote.
- `VIOLATED` — the landed effect is established, attributable, and
  **wrong** (outside the authorized envelope or state).
- `UNVERIFIED` — the effect cannot be attributed to this operation
  (for example, a third-party change broke the validation bracket);
  figures may be retained only as non-establishing candidates.
- `INDETERMINATE` — the mutation's outcome is unknown (for example,
  its response was lost). Retrying is refused; reconciliation must be
  by independent observation.

Financial figures carry explicit **determinacy**: `DETERMINED` (an
established value, possibly a verified zero), `NOT_APPLICABLE`
(licensed by the spec's applicability table), or `UNKNOWN` (no
established value — never a synonym for zero).

## Install (from a locally built tarball)

This package is not on npm. Build the artifact from the repository
and install the tarball into your own project:

```bash
git clone https://github.com/agorail-labs/subscription-change-quote
cd subscription-change-quote/reference
npm ci
npm pack            # produces agorail-labs-scq-reference-0.6.2-experimental.1.tgz

cd /path/to/your/project
npm install /path/to/agorail-labs-scq-reference-0.6.2-experimental.1.tgz
```

Requires Node.js 20 or newer. The optional `better-sqlite3`
dependency is needed only for the durable (SQLite) store; the
in-memory simulator paths never load it, and if its native binding is
unavailable the durable store fails with an explicit message rather
than degrading silently.

## Quick start

Three runnable scenarios ship in `examples/` (simulator only):

```bash
node node_modules/@agorail-labs/scq-reference/examples/scenario-a-verified.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-b-divergence.mjs
node node_modules/@agorail-labs/scq-reference/examples/scenario-c-indeterminate.mjs
```

- **A** — an authorized change that commits and verifies.
- **B** — divergence: a provably wrong landing (`VIOLATED`) versus an
  unattributable one (`UNVERIFIED`), and why the difference matters.
- **C** — a lost mutation response (`INDETERMINATE`): no blind retry,
  reconciliation by observation, and durable receipt replay after a
  restart.

See `DEVELOPER-GUIDE.md` (included in this package) for concepts,
JavaScript and TypeScript examples, receipt interpretation, and the
limits below in full.

## Hard limits

- **Simulator only.** The exported adapters run against in-memory
  Stripe-, Paddle-, Zuora-, and Chargebee-shaped simulators. They do
  not connect to any real provider. The env-gated live Chargebee
  pilot code is **excluded from this artifact** and remains
  repository-only; live commit functionality is disabled by design
  and no real-provider guarantee of any kind is offered or implied.
- **Best-effort concurrency.** All simulated adapters report
  best-effort precondition/commit consistency; no atomic provider
  compare-and-swap guarantee is implied.
- **The acceptance envelope is not authorization.** An SCQ
  `acceptanceEnvelope` permits quote-relative drift; it is not a
  total spending limit or an authorization grant. Real integrations
  must independently perform identity, approval, absolute-budget, and
  contractual/entitlement checks.
- **Determinacy is only as strong as its provenance.** Established
  figures rest on adapter-produced evidence; the core trusts the
  adapter's classification and does not independently authenticate
  provider events (spec section 6.15, register item G-01). Candidate
  figures come only from the mutating call's own response (spec
  section 3.10) and establish nothing by themselves.
- **Durability has preconditions.** The section 6.10 rule that a
  repeated commit returns the original receipt without a second
  mutation presumes durable persistence (use `DurableQuoteStore`)
  plus reconciliation of provider state after an indeterminate
  outcome. The in-memory `QuoteStore` cannot establish that guarantee
  across process crashes; after a restart it can only fail closed.
  Provider-native idempotency is not indefinite either — Chargebee's
  documented native idempotency window is 30 minutes (see
  `spec/ERRATA-v0.6.1.md` ER-4 in the repository).

## Conformance status and limitations

This package is a reference implementation of the published SCQ
v0.6.2 experimental specification. A consolidated conformance audit
of the merged repository (PR #54, issue #29) assessed the 75 rules
of spec Appendix B at **72 IMPLEMENTED / 3 PARTIAL / 0 BLOCKED**,
entirely from simulator-level evidence — no live provider commit has
ever been executed, and no provider has reviewed or endorsed SCQ.
This package is **not** fully v0.6.2-conformant, and no certification
claim is made. The three PARTIAL rules are:

- **V62-DET-08** — snapshot determinacy is informative metadata:
  adapters emit it honestly, but there is no enforcement consumer of
  the field. Effect determinacy is established independently when
  the committed effect is constructed.
- **V62-EVD-01 (G-01)** — evidence provenance is trusted-adapter
  provenance, not authenticated provider-origin proof: the core
  trusts adapter-established classification and does not
  independently authenticate provider events.
- **V62-SV-02 (G-08)** — shared-hook consumption for post-commit
  state verification is not universal: three adapter-owned
  specializations remain (Chargebee-sim CANCEL, Paddle CANCEL, and
  Zuora). Equivalence rests on per-adapter pinning tests, disclosed
  in the audit.

Two further disclosed limitations, both fail-closed and neither
fixed in this release:

- **Issue #45** — the durable store's unresolved-attempt exclusion
  is keyed by subscription identity alone, so it over-blocks: the
  same subscription ID is refused across provider/site boundaries
  even where the attempts are unrelated. This is an availability
  limitation — multi-site use of one subscription ID is not fully
  supported — and the behavior fails closed (refusal), never open.
- **Issue #51** — in a store migrated from a pre-v4 schema, an
  ASSERTED migrated landing reconciliation cannot be superseded by
  a new VERIFIED barrier, so the affected attempt stays blocked;
  migrated-store recovery for such attempts is not fully supported.
  The behavior fails closed. No affected population is known outside
  this repository's fixtures.

Both are recorded as accepted experimental limitations, pending
maintainer decisions in the audit record
(`research/v0.6.2-release-readiness.md` section G in the repository).

## Support and security

This is an experimental artifact maintained on a best-effort basis.
Report issues at
https://github.com/agorail-labs/subscription-change-quote/issues and
see the repository's `SECURITY.md` and `SUPPORT.md`. Apache-2.0
licensed.
