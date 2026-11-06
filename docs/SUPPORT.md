# Support Matrix and Platform Notes (stable candidate)

**Status: PROPOSED for the 1.0 candidate.** The published
experimental package predates this matrix; its known deviations
are listed explicitly rather than smoothed over.

## Supported runtimes (candidate)

| Runtime | Suite | Consumer example | Notes |
|---|---|---|---|
| Node 22 LTS | ✅ 915/915 (clean `npm ci`) | ✅ | Primary baseline |
| Node 24 LTS | ✅ 915/915 (clean `npm ci`) | ✅ (published pkg) | |
| Node 26 LTS | ✅ 915/915 (clean `npm ci`, requires `better-sqlite3@^13`) | ✅ (candidate pack) | Published experimental package: durable store **not** usable (see migration guide §1) |

Node 20 and older: **not supported** for the candidate (EOL;
`engines: node >=22`).

## Platforms

- **Linux x86_64** is the validated platform (all matrix runs,
  CI). The durable store's process-kill and crash-recovery tests
  use POSIX signals and filesystem semantics and are **Linux-
  specific in their current form**; macOS is expected to behave
  identically (same signal/WAL semantics) but is not in the
  validated matrix. Windows is not validated: WAL-mode SQLite and
  the kill-based tests have not been qualified there, and no
  Windows claim is made.
- The optional native dependency (`better-sqlite3`) ships N-API
  prebuilds for the supported runtimes; where a prebuild is
  unavailable, installation falls back to a source build requiring
  a C++ toolchain — plan accordingly in minimal containers.

## What an application can safely rely on (candidate contract)

The §3 guarantees of `docs/STABLE-RELEASE-READINESS.md`: exact
integer money math, UNKNOWN ≠ 0, fail-closed acceptance, single
dispatch per intent with durable replay, fail-closed persistence,
and evidence-bound INDETERMINATE resolution.

## What remains the integrating application's responsibility

- Authorization: SCQ's envelope is a quote-drift tolerance, **not**
  a spending authorization. Who may initiate a change, and under
  what organizational authority, is your layer.
- Provider evidence authenticity (limitation G-01): the core
  trusts adapter-established classification.
- Transport: adapters translate records over transports you
  supply; credentials, network policy, and provider accounts are
  yours. No live dispatch is supported.
- Database file placement, permissions, backup, and retention.
