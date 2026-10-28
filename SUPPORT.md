# SCQ support and community feedback

SCQ v0.6.1 is an **experimental, independently proposed protocol** with simulated reference adapters. It does not offer production support, a response-time commitment, or provider/standards-body certification.

## Where to ask

- **[Discussions](../../discussions)**: protocol questions, design tradeoffs, implementation approaches, and suggestions for future versions. Share small, synthetic examples and identify the relevant commercial-effect or timing dimension.
- **[Issues](../../issues)**: reproducible reference-implementation bugs, incorrect documentation, spec contradictions and conformance gaps. Select a relevant issue template when available.
- **[Security reporting](SECURITY.md)**: report potentially exploitable or sensitive concerns privately, never in a public issue or Discussion.

## Evidence expectations

Please distinguish **LIVE_API_VALIDATED**, **DOCUMENTATION_BACKED_SIMULATION**, **INFERRED**, and **UNVERIFIED** statements, as described in the [evidence register](research/EVIDENCE.md). An in-memory Stripe-, Paddle-, Zuora-, or Chargebee-shaped adapter is **not** proof that a real provider API behaves identically.

Do not include real account identifiers, customer data, credentials, authentication headers, or full production request/response payloads. Redact sensitive information and use synthetic examples.

The v0.6.1 normative contract is frozen for review. Proposed future extensions should be discussed without treating them as currently adopted protocol requirements.
