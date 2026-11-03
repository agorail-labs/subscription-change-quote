# Adoption and evaluation tracker — Agorail experimental packages

This tracker records **verified evidence only** for
`@agorail-labs/scq-reference` and `@agorail-labs/mse-reference`.

> **Outreach attempts are not adoption.** An invitation sent, a link
> shared, or a conversation started is never recorded here as adoption,
> use, or endorsement. A row is added only when the result is
> independently verifiable: a reproducible install log, a published
> review, a merged fix, or a public integration that can be inspected.
> Internal verification by the project itself is labeled as such and is
> not external adoption.

| Date | Evaluator | Channel | Install reproduced (Node versions) | Example run result | Code review | Fixes accepted | Integration (verified) | Public reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-02 | Agorail project (internal) | npm registry publication | n/a — publication event | n/a | n/a | n/a | n/a | `@agorail-labs/mse-reference@0.4.0-experimental.1` and `@agorail-labs/scq-reference@0.6.2-experimental.1` published under the `experimental` dist-tag; registry-served tarballs verified byte-for-byte against the approved CI-attested artifacts (SHA-256 `edcef7c9…` / `9d297441…`) |
| 2026-11-02 | Agorail project (internal verification, **not** external adoption) | Clean-room consumer project (no repository-relative imports) | Yes — Node 20 and Node 22 | Published-package examples and consumer checks executed: MSE admission pass/refusal with witness; SCQ verified commit, divergence, and indeterminate/replay scenarios | Internal | n/a | None | Internal consumer-verification record, 2026-11-02 |

## How a row gets added

1. An independent evaluator installs a published package version with
   `@experimental` or an exact version pin, on a recorded Node version.
2. Their example run, review, or integration is captured in a form a
   third party can inspect (public issue, PR, post, or repository).
3. Any claimed integration is verified working against the published
   package — a mention, a star, or an expression of interest does not
   qualify.

Fixes accepted from external reports are credited in the row and in the
fixing PR. Nothing in this table asserts that any named party uses or
endorses these packages beyond the specific verified evidence recorded.
