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
