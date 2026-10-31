/**
 * Experimental SCQ v0.6.1 reference package entry point.
 *
 * The adapters exported here operate on in-memory, provider-shaped simulators.
 * They do NOT connect to production billing providers. A real integration
 * must implement SubscriptionProvider and separately enforce authorization,
 * credential handling, and business policy limits.
 *
 * Do not equate AcceptanceEnvelope's quote-relative drift tolerance with
 * an absolute spending cap or authorization grant.
 */
export * from "./core/types.js";
export { verifyPostCommitState } from "./core/state-verification.js";
export { QuoteStore, establishVerification, evidenceEntryId, type ReceiptEvidenceEntry, type ReceiptEvidenceDimensionDisposition } from "./store/quote-store.js";
export {
  DurableQuoteStore,
  DurableStoreError,
  DurableRecoveryError,
  DispatchBlockedError,
  type StoredAttempt,
  type MutationIntent,
} from "./store/durable-store.js";
export { DurableMutationCoordinator } from "./store/mutation-coordinator.js";
export { StripeAdapter } from "./adapters/stripe-adapter.js";
export { StripeSim } from "./adapters/stripe-sim.js";
export { PaddleAdapter } from "./adapters/paddle-adapter.js";
export { PaddleSim } from "./adapters/paddle-sim.js";
export { ZuoraAdapter } from "./adapters/zuora-adapter.js";
export { ZuoraSim } from "./adapters/zuora-sim.js";
export { ChargebeeAdapter } from "./adapters/chargebee-adapter.js";
export { ChargebeeSim } from "./adapters/chargebee-sim.js";
