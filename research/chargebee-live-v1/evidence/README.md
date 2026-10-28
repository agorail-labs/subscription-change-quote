# Evidence directory (gitignored)

Sanitized fixtures and local run metadata for the Chargebee live validation live
here and are intentionally NOT tracked (see the `evidence/` entry appended to the
repository `.gitignore` by this experiment).

Rules for anything placed here:

- No credentials, API keys, authorization headers, or idempotency keys from a real site.
- No real customer identifiers, email addresses, payment data, or full unfiltered
  provider payloads. Synthetic test-site ids only, and only when a future approved
  live run produces them.
- Each fixture must name its test ID, the repository commit, the Chargebee endpoint,
  and its evidence source (live / simulated / documented / inferred).

In this run the directory is empty of fixtures by design: all live cases were
BLOCKED — CREDENTIALS NOT AVAILABLE, and mocked-transport fixtures are preserved
in-file in `reference/tests/test13-chargebee-http.test.ts` where they are executable.
*(The "in this run / BLOCKED" statements describe Phase 1. Phase 3
later produced the summary below; account identifiers in it were
redacted to placeholders — `<test-site>`, `<subscription-id>`,
`<quote-id>` — in the PR #4 review round, 2026-10-28; catalog
item-price SKUs are retained.)*

**Exception (Phase 3, 2026-10-27):** `PHASE3-EVIDENCE-SUMMARY.md` in this
directory IS tracked (see the `.gitignore` exception). It is a sanitized,
reviewed summary — narrative results, classifications, and amounts in minor
units for the synthetic demo subscription only; it contains no credentials,
no raw provider payloads, and no customer data beyond the demo identifiers
already used across this branch's documents. Raw fixtures and run metadata
remain local-only under the rules above.
