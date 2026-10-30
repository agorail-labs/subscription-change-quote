/**
 * Quote-origin manifest (PR #20 review correction PF3; record
 * format v2 + substitution hardening, PR #20 re-review).
 *
 * A Chargebee `StoredQuote` records provider + subscription id, but
 * NO originating site. Comparing the run's configured site against a
 * second caller-supplied "expected site" therefore establishes only
 * that two inputs agree — it does not establish that the quote was
 * actually ISSUED against that site, and a quote created for one
 * site could be replayed against another approved site carrying a
 * coincidentally matching subscription id / fingerprint.
 *
 * This module is the trustworthy origin record the preflight binds
 * to: an append-only manifest (JSON lines, one record per issuance)
 * written at quote-issuance time by the pilot/live issuance path,
 * where the site is known from the run's own configuration (never
 * from a later caller's assertion). Each record is keyed by quote id
 * and carries the ledger-canonical digest (`requestHashOf`) of the
 * stored quote's issuance-stable fields, so a stored quote altered
 * after issuance — or a record transplanted from another quote —
 * no longer matches its origin record.
 *
 * The preflight fails closed on this evidence: no record, a corrupt
 * manifest, conflicting records, a digest mismatch, or a site /
 * subscription mismatch are all blockers, and Condition 3 cannot
 * PASS without an established binding. The manifest lives entirely
 * in the pilot layer: no core, engine, or store surface is touched,
 * and no ledger semantics change — the store is only READ here.
 *
 * Substitution hardening (record format v2). A v1 record's own
 * fields were NOT digest-bound: the record's `site` — the very fact
 * the manifest exists to attest — could be edited in the JSONL line
 * after issuance and every check stayed green (the quote digest
 * still matched; the site comparison then ran against the tampered
 * value). V2 closes that hole three ways:
 *
 * 1. RECORD SELF-DIGEST — every record carries `recordDigest`, the
 *    ledger-canonical hash of the COMPLETE record content (kind,
 *    version, quote id, provider, site, subscription id, quote
 *    digest, issuance timestamp, recording path, chain link). Any
 *    post-issuance edit to any field invalidates the record.
 * 2. HASH CHAIN — every record carries `prevRecordDigest`, the
 *    record digest of the preceding record in the manifest (a fixed
 *    genesis constant for the first). Loading verifies, in file
 *    order, every record's self-digest AND the chain linkage, so
 *    editing, reordering, inserting, or deleting a non-final record
 *    breaks verification and marks the manifest CORRUPT.
 * 3. ONE-TIME WRITER — `record()` refuses when a record already
 *    exists for the quote id: issuance is once-only, so
 *    substitution-by-append is refused at write time, not merely
 *    blocked at read. (A conflicting record appended by raw file
 *    edit still blocks at read, via both the conflict rule and the
 *    broken chain/digest.)
 *
 * Version policy: version-1 (or unknown-version) records predate
 * self-digest/chain binding and are UNTRUSTWORTHY — a manifest
 * containing one is corrupt and consumers fail closed. Nothing
 * external persists v1 records (the manifest is written and read
 * within this pilot layer), so no migration path is offered.
 *
 * Honest limits: this is tamper-EVIDENCE within the manifest file,
 * not tamper-proofing. A privileged writer holding BOTH the
 * manifest and the durable database could rewrite the file with a
 * fully recomputed chain (and a matching quote digest) and nothing
 * in the file alone would evidence it; defeating that requires an
 * external trust anchor — an issuance countersignature or a WORM
 * store — which is named subsequent work, not claimed here.
 * Operational control of the manifest file remains part of the
 * real-tenant evidence story.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { requestHashOf } from "../../store/durable-store.js";
import type { StoredQuote } from "../../store/quote-store.js";

export type QuoteOriginRecord = {
  kind: "scq-quote-origin";
  version: 2;
  quoteId: string;
  provider: string;
  /** The site from the issuing run's configuration — the origin this quote is bound to. */
  site: string;
  subscriptionId: string;
  /** Ledger-canonical digest of the stored quote's issuance-stable fields at issuance time. */
  quoteDigest: string;
  recordedAt: string;
  /** Descriptive only: which issuance path recorded this (e.g. the CLI fixture builder). */
  recordedBy: string;
  /** Hash-chain link: the recordDigest of the preceding record, or the genesis constant for the first. */
  prevRecordDigest: string;
  /** Self-digest over the COMPLETE record content (see quoteOriginRecordDigestOf) — any field edit invalidates the record. */
  recordDigest: string;
};

/** Chain link expected on the first record of every manifest. */
export const QUOTE_ORIGIN_CHAIN_GENESIS = "scq-quote-origin-chain-genesis-v2";

/**
 * The digest an origin record binds: the issuance-stable identity of
 * the stored quote — its id, provider, subscription, quote-time
 * fingerprint, proposal, stored preview input (target items + the
 * original idempotency key), and validity window. Mutable lifecycle
 * fields (status, receipts, outcomes) are deliberately excluded: a
 * quote that later commits does not stop being the quote that was
 * issued, but any change to WHAT was issued breaks the binding.
 */
export function quoteOriginDigest(stored: StoredQuote): string {
  return requestHashOf({
    scqQuoteOriginDigestOf: {
      quote_id: stored.quote_id,
      provider: stored.provider,
      subscription_id: stored.subscription_id,
      subscription_version_at_quote: stored.subscription_version_at_quote,
      proposal: stored.proposal,
      provider_preview_input: stored.provider_preview_input,
      created_at: stored.created_at,
      expires_at: stored.expires_at,
    },
  });
}

/**
 * The record self-digest: the ledger-canonical hash of the COMPLETE
 * record content — including the originating site, subscription id,
 * quote identity, and quote digest the record exists to attest — so
 * no field of a written record can be substituted after issuance
 * without invalidating it.
 */
export function quoteOriginRecordDigestOf(record: Omit<QuoteOriginRecord, "recordDigest">): string {
  return requestHashOf({
    scqQuoteOriginRecordDigestOf: {
      kind: record.kind,
      version: record.version,
      quote_id: record.quoteId,
      provider: record.provider,
      site: record.site,
      subscription_id: record.subscriptionId,
      quote_digest: record.quoteDigest,
      recorded_at: record.recordedAt,
      recorded_by: record.recordedBy,
      prev_record_digest: record.prevRecordDigest,
    },
  });
}

function isOriginRecord(value: unknown): value is QuoteOriginRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.kind === "scq-quote-origin" && r.version === 2
    && typeof r.quoteId === "string" && typeof r.provider === "string"
    && typeof r.site === "string" && typeof r.subscriptionId === "string"
    && typeof r.quoteDigest === "string" && typeof r.recordedAt === "string"
    && typeof r.recordedBy === "string"
    && typeof r.prevRecordDigest === "string" && typeof r.recordDigest === "string";
}

/**
 * Verifies a record sequence as a hash chain, in order: the first
 * record must link to the genesis constant, every later record must
 * link to its predecessor's digest, and every record's self-digest
 * must match its content. Any break — an edited field, a reorder,
 * an insertion, a deleted non-final record — fails verification.
 */
function chainVerifies(records: QuoteOriginRecord[]): boolean {
  let prev = QUOTE_ORIGIN_CHAIN_GENESIS;
  for (const record of records) {
    if (record.prevRecordDigest !== prev) return false;
    if (quoteOriginRecordDigestOf(record) !== record.recordDigest) return false;
    prev = record.recordDigest;
  }
  return true;
}

/**
 * An append-only quote-origin manifest. Records are appended in
 * memory and, when a file path is configured, as JSON lines on disk
 * (append-only: existing lines are never rewritten). A file that
 * exists but contains an unparseable or malformed line — including
 * a version-1 or unknown-version record — marks the manifest
 * CORRUPT, as does any self-digest or hash-chain verification
 * failure: consumers must fail closed, because origin evidence that
 * does not verify is not trustworthy evidence.
 */
export class QuoteOriginManifest {
  readonly corrupt: boolean = false;
  private readonly records: QuoteOriginRecord[] = [];

  constructor(readonly filePath?: string) {
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isOriginRecord(parsed)) throw new Error("malformed origin record");
          this.records.push(parsed);
        } catch {
          (this as { corrupt: boolean }).corrupt = true;
        }
      }
      if (!chainVerifies(this.records)) {
        (this as { corrupt: boolean }).corrupt = true;
      }
    }
  }

  /** Loads (or creates, in memory) the manifest at a file path. */
  static load(filePath: string): QuoteOriginManifest {
    return new QuoteOriginManifest(filePath);
  }

  /**
   * Records the origin of a freshly issued quote. Called by the
   * issuance path at creation time, with the site taken from that
   * run's configuration. Appends — never rewrites — so the history
   * of what was issued where is preserved.
   *
   * Issuance is ONCE-ONLY per quote: if a record already exists for
   * the quote id this throws, so a second (substituted) record can
   * never be appended through the writer. Appending to a manifest
   * that failed integrity verification also throws — new issuance
   * records must not be chained onto untrustworthy evidence.
   */
  record(input: { stored: StoredQuote; site: string; recordedBy: string; now?: () => Date }): QuoteOriginRecord {
    if (this.corrupt) {
      throw new Error("quote-origin manifest is corrupt or fails integrity verification — refusing to append an issuance record to untrustworthy evidence");
    }
    if (this.records.some((r) => r.quoteId === input.stored.quote_id)) {
      throw new Error(`quote-origin manifest already holds a record for quote ${input.stored.quote_id} — issuance is once-only and a second record would be substitution-by-append`);
    }
    const content: Omit<QuoteOriginRecord, "recordDigest"> = {
      kind: "scq-quote-origin",
      version: 2,
      quoteId: input.stored.quote_id,
      provider: input.stored.provider,
      site: input.site,
      subscriptionId: input.stored.subscription_id,
      quoteDigest: quoteOriginDigest(input.stored),
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      recordedBy: input.recordedBy,
      prevRecordDigest: this.records.length > 0
        ? this.records[this.records.length - 1].recordDigest
        : QUOTE_ORIGIN_CHAIN_GENESIS,
    };
    const record: QuoteOriginRecord = { ...content, recordDigest: quoteOriginRecordDigestOf(content) };
    this.records.push(record);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(record) + "\n");
    return record;
  }

  /** All records for one quote id (possibly several, possibly conflicting — the consumer judges). */
  recordsFor(quoteId: string): QuoteOriginRecord[] {
    return this.records.filter((r) => r.quoteId === quoteId);
  }

  get size(): number {
    return this.records.length;
  }
}
