/**
 * Experimental Agorail v0.7 composition: business-intent dispatch fence.
 * NOT part of frozen SCQ v0.6.2 and NOT an exactly-once provider guarantee.
 *
 * This is deliberately a one-way fail-closed write-ahead fence. Its SQLite
 * transaction is separate from SCQ's attempt ledger: if the process dies
 * between the intent claim and SCQ beginDispatch, the intent remains
 * blocked for operator investigation. Never infer non-execution from that
 * gap, and never automatically clear the claim.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SubscriptionChangeReceipt } from "../core/types.js";
import { DurableMutationCoordinator, type DispatchResult, type ExecuteResult } from "../store/mutation-coordinator.js";
import type { MutationIntent } from "../store/durable-store.js";

export type BusinessIntent = {
  /** Stable ID assigned by a trusted authorizer to ONE approved action. */
  tenantId: string;
  businessIntentId: string;
  actorId: string;
  authorizationRef: string;
  provider: string;
  site?: string;
  subscriptionId: string;
  /** Canonical business operation, independent of SCQ quote/attempt/key. */
  operation: unknown;
  quoteId: string;
};

type StoredClaim = { quoteId: string; binding: string; admission: unknown };

export class BusinessIntentConflict extends Error {
  readonly code = "BUSINESS_INTENT_CONFLICT";
  constructor(message: string) { super(message); this.name = "BusinessIntentConflict"; }
}

export class BusinessIntentUnavailable extends Error {
  readonly code = "BUSINESS_INTENT_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "BusinessIntentUnavailable"; }
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new BusinessIntentConflict(`${name} must be a nonempty, canonical string`);
  }
  return value;
}

function canonical(value: unknown): string {
  // Fail closed on unsupported JSON, rather than silently hashing it away.
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new BusinessIntentConflict("Business operation must be unambiguous plain JSON (no undefined, special numbers, classes or sparse structures)");
}
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

function identityOf(i: BusinessIntent): { tenantId: string; businessIntentId: string; binding: string } {
  const tenantId = required(i.tenantId, "tenantId");
  const businessIntentId = required(i.businessIntentId, "businessIntentId");
  const binding = canonical({
    actorId: required(i.actorId, "actorId"),
    authorizationRef: required(i.authorizationRef, "authorizationRef"),
    provider: required(i.provider, "provider"),
    site: i.site === undefined ? null : required(i.site, "site"),
    subscriptionId: required(i.subscriptionId, "subscriptionId"),
    operation: i.operation,
  });
  required(i.quoteId, "quoteId");
  return { tenantId, businessIntentId, binding };
}

export class BusinessIntentLedger {
  private readonly db: Database.Database;
  constructor(path: string) {
    try {
      const sqlite = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
      this.db = new sqlite(path, { timeout: 5000 });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS business_intent_claims (
        tenant_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        binding_sha TEXT NOT NULL,
        original_quote_id TEXT NOT NULL,
        admission_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, intent_id)
      )`);
    } catch (error) {
      throw new BusinessIntentUnavailable(`Durable business-intent ledger unavailable: ${String(error)}`);
    }
  }

  close(): void { this.db.close(); }

  private get(id: ReturnType<typeof identityOf>): StoredClaim | undefined {
    const row = this.db.prepare(
      "SELECT binding_json, binding_sha, original_quote_id, admission_json FROM business_intent_claims WHERE tenant_id=? AND intent_id=?",
    ).get(id.tenantId, id.businessIntentId) as {
      binding_json: string; binding_sha: string; original_quote_id: string; admission_json: string;
    } | undefined;
    if (!row) return undefined;
    if (digest(row.binding_json) !== row.binding_sha || !row.original_quote_id) {
      throw new BusinessIntentUnavailable("Business-intent record failed integrity inspection; refusing dispatch");
    }
    let admission: unknown;
    try { admission = JSON.parse(row.admission_json); } catch {
      throw new BusinessIntentUnavailable("Business-intent admission evidence is unreadable");
    }
    if (row.binding_json !== id.binding) {
      throw new BusinessIntentConflict("Intent ID already belongs to a different actor, authorization, resource or operation");
    }
    return { quoteId: row.original_quote_id, binding: row.binding_json, admission };
  }

  lookup(i: BusinessIntent): StoredClaim | undefined {
    return this.get(identityOf(i));
  }

  /** One caller wins the SQLite IMMEDIATE transaction; everyone else replays or blocks. */
  claim(i: BusinessIntent, admission: unknown): { acquired: boolean; claim: StoredClaim } {
    const id = identityOf(i);
    let admissionJson: string;
    try { admissionJson = canonical(admission); } catch {
      throw new BusinessIntentConflict("Admission evidence must be durable JSON");
    }
    try {
      return this.db.transaction(() => {
        const existing = this.get(id);
        if (existing) return { acquired: false, claim: existing };
        this.db.prepare(`INSERT INTO business_intent_claims
          (tenant_id, intent_id, binding_json, binding_sha, original_quote_id, admission_json, created_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          id.tenantId, id.businessIntentId, id.binding, digest(id.binding),
          i.quoteId, admissionJson, new Date().toISOString(),
        );
        return { acquired: true, claim: { quoteId: i.quoteId, binding: id.binding, admission } };
      }).immediate();
    } catch (error) {
      if (error instanceof BusinessIntentConflict || error instanceof BusinessIntentUnavailable) throw error;
      throw new BusinessIntentUnavailable(`Intent claim transaction failed, dispatch not authorized: ${String(error)}`);
    }
  }
}

/**
 * MSE's live evaluator + assertAdmissionReportWellFormed must be implemented
 * by the caller, using the v0.4 contract. This bridge MUST NOT call MSE's
 * ReferenceProvider.commit() as an "admission-only" hook: commit has effects.
 */
export type MseAdmissionGate =
  () => Promise<{ kind: "REFUSED"; refusal: unknown } | { kind: "PASSED"; report: unknown }>;

export type BridgeHooks = {
  /** Validate caller authorization on EVERY call, including replay (not MSE's responsibility). */
  authorize: () => Promise<void>;
  /** Independently evaluate and validate live MSE admission before first dispatch. */
  admission: MseAdmissionGate;
  /** Must throw unless MSE report is genuinely valid for the actual quote/proposal. */
  validatePassedAdmission: (report: unknown) => void;
  /** SCQ quote/financial/provider-preservation guard: no side effects here. */
  validateCommercial: () => Promise<void>;
};

export type BridgeResult =
  | { kind: "ADMISSION_REFUSED"; refusal: unknown }
  | { kind: "EXISTING_RECEIPT"; receipt: SubscriptionChangeReceipt; originalQuoteId: string }
  | { kind: "BLOCKED"; originalQuoteId: string; reason: "NO_RECORDED_RECEIPT" }
  | { kind: "EXECUTED"; execution: ExecuteResult; admission: unknown };

/**
 * Fail-closed composition boundary: authorization -> MSE admission -> SCQ
 * commercial preflight -> durable intent claim -> SCQ coordinator dispatch.
 * All dispatch is through SCQ, never through the MSE reference simulator.
 */
export class MseScqIntentBridge {
  constructor(
    readonly ledger: BusinessIntentLedger,
    readonly coordinator: DurableMutationCoordinator,
  ) {}

  private existing(quoteId: string): BridgeResult {
    const receipt = this.coordinator.store.recordedReceipt(quoteId);
    return receipt
      ? { kind: "EXISTING_RECEIPT", receipt, originalQuoteId: quoteId }
      : { kind: "BLOCKED", originalQuoteId: quoteId, reason: "NO_RECORDED_RECEIPT" };
  }

  async execute(
    business: BusinessIntent,
    mutation: MutationIntent,
    hooks: BridgeHooks,
    dispatch: () => Promise<DispatchResult>,
  ): Promise<BridgeResult> {
    // A raw ID or authorizationRef is not an authorization capability.
    await hooks.authorize();
    if (business.quoteId !== mutation.quoteId ||
        business.subscriptionId !== mutation.subscriptionId ||
        business.provider !== mutation.provider ||
        (business.site ?? null) !== (mutation.site ?? null)) {
      throw new BusinessIntentConflict("Business intent and SCQ attempt have different quote/resource/provider/site bindings");
    }
    const existing = this.ledger.lookup(business);
    if (existing) return this.existing(existing.quoteId);

    const decision = await hooks.admission();
    if (decision.kind === "REFUSED") return { kind: "ADMISSION_REFUSED", refusal: decision.refusal };
    if (decision.kind !== "PASSED" || !decision.report) {
      throw new BusinessIntentConflict("Missing validated MSE admission result");
    }
    hooks.validatePassedAdmission(decision.report);
    await hooks.validateCommercial();

    // The claim is persisted BEFORE SCQ's own write-ahead dispatch gate.
    // A crash in between is conservatively blocked on every retry.
    const claimed = this.ledger.claim(business, decision.report);
    if (!claimed.acquired) return this.existing(claimed.claim.quoteId);
    const execution = await this.coordinator.execute(mutation, dispatch);
    return { kind: "EXECUTED", execution, admission: decision.report };
  }
}
