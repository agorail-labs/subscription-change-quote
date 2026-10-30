/**
 * Quote-origin manifest (PR #20 review correction PF3).
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
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { requestHashOf } from "../../store/durable-store.js";
import type { StoredQuote } from "../../store/quote-store.js";

export type QuoteOriginRecord = {
  kind: "scq-quote-origin";
  version: 1;
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
};

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

function isOriginRecord(value: unknown): value is QuoteOriginRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.kind === "scq-quote-origin" && r.version === 1
    && typeof r.quoteId === "string" && typeof r.provider === "string"
    && typeof r.site === "string" && typeof r.subscriptionId === "string"
    && typeof r.quoteDigest === "string" && typeof r.recordedAt === "string";
}

/**
 * An append-only quote-origin manifest. Records are appended in
 * memory and, when a file path is configured, as JSON lines on disk
 * (append-only: existing lines are never rewritten). A file that
 * exists but contains an unparseable or malformed line marks the
 * manifest CORRUPT: consumers must fail closed, because a partially
 * unreadable origin record is not trustworthy evidence.
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
   */
  record(input: { stored: StoredQuote; site: string; recordedBy: string; now?: () => Date }): QuoteOriginRecord {
    const record: QuoteOriginRecord = {
      kind: "scq-quote-origin",
      version: 1,
      quoteId: input.stored.quote_id,
      provider: input.stored.provider,
      site: input.site,
      subscriptionId: input.stored.subscription_id,
      quoteDigest: quoteOriginDigest(input.stored),
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      recordedBy: input.recordedBy,
    };
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
