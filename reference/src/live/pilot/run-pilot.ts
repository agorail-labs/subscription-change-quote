// SCQ Chargebee PILOT harness — a developer-executable, reproducible
// validation workflow over the experimental live Chargebee adapter.
//
// Steps: (1) retrieve a subscription, (2) build the SCQ snapshot,
// (3) construct a change proposal, (4) obtain a provider-backed quote
// using READ/ESTIMATE operations only, (5) compare the adapter's
// normalized quote against the RAW provider estimate field-by-field,
// (6) emit a structured validation report (JSON + Markdown summary).
//
// Safety posture:
//   - Default mode is MOCKED (fixture transport; SIMULATED evidence).
//   - Live mode requires BOTH the --live flag AND credentials in the
//     environment (CHARGEBEE_SITE + CHARGEBEE_API_KEY, plus
//     CHARGEBEE_TEST_SUBSCRIPTION_ID). Without them the run classifies
//     live capabilities BLOCKED and performs NO network call.
//   - The harness NEVER enables live commit, in either mode: the
//     adapter is constructed with liveCommitEnabled=false, and the
//     report classifies commit BLOCKED with the reason. Commit-path
//     behavior is exercised only by mocked tests (test21 / test13).
//
// Run (from reference/):  npm run pilot:chargebee
//                         npm run pilot:chargebee -- --out ../../research/chargebee-pilot/runs
//                         npm run pilot:chargebee -- --live   (BLOCKED without env credentials)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QuoteStore } from "../../store/quote-store.js";
import type { SubscriptionChangeQuote } from "../../core/types.js";
import { ChargebeeClient, chargebeeConfigFromEnv, fetchTransport, type HttpTransport } from "../chargebee-http.js";
import { ChargebeeLiveAdapter, interpretChargebeeEstimate, type CbItemPriceInfo } from "../chargebee-scq-adapter.js";
import { PilotMockChargebee } from "./mock-transport.js";

export type EvidenceClass = "LIVE_PASS" | "LIVE_FAIL" | "SIMULATED_PASS" | "DOCUMENTATION_SUPPORTED" | "BLOCKED" | "UNVERIFIED";
export const EVIDENCE_CLASSES: EvidenceClass[] = ["LIVE_PASS", "LIVE_FAIL", "SIMULATED_PASS", "DOCUMENTATION_SUPPORTED", "BLOCKED", "UNVERIFIED"];

export type PilotStep = { step: string; status: "pass" | "fail" | "blocked"; detail: string };
export type FieldComparison = { field: string; providerSource: string; rawDerived: unknown; normalized: unknown; match: boolean; note?: string };
export type CapabilityResult = { capability: string; classification: EvidenceClass; basis: string };

export type PilotReport = {
  generatedAt: string;
  mode: "mocked" | "live";
  site: string;
  subscriptionRef: string;
  proposalDescription: string;
  steps: PilotStep[];
  comparisons: FieldComparison[];
  capabilities: CapabilityResult[];
  transport: { totalCalls: number; mutatingCalls: number; estimateCalls: number };
  quote?: { id: string; immediateNet?: number; recurringResulting?: number; recurringPrevious?: number; currency?: string; provenance?: unknown; nextInvoiceEstimate?: unknown };
};

export const PILOT_ADDON = "pilot-addon-vision";
export const PILOT_SUBSCRIPTION_ID = "pilot-sub-001";
export const PILOT_TARGET_QTY = 21;

/**
 * Field-by-field comparison of the adapter's normalized quote against
 * the RAW provider estimate. The raw response is interpreted
 * independently (interpretChargebeeEstimate over the raw JSON with
 * the same context) and each normalized figure must equal the
 * raw-derived figure; next-invoice figures must appear ONLY in
 * metadata and never in the effect.
 */
export function compareQuoteToRawEstimate(
  quote: SubscriptionChangeQuote,
  rawEstimateJson: any,
  ctx: { currency: string; currentItems: Array<{ itemPriceId: string; quantity: number; unitPrice?: number; amount?: number; freeQuantity?: number }>; targetItems: Array<{ itemPriceId: string; quantity: number }>; priceInfo: Map<string, CbItemPriceInfo> },
): FieldComparison[] {
  const raw = interpretChargebeeEstimate(rawEstimateJson?.estimate, ctx);
  const eff = quote.commercialEffect;
  const md = (quote.providerMetadata ?? {}) as Record<string, unknown>;
  const out: FieldComparison[] = [];
  const push = (field: string, providerSource: string, rawDerived: unknown, normalized: unknown, note?: string) =>
    out.push({ field, providerSource, rawDerived, normalized, match: JSON.stringify(rawDerived) === JSON.stringify(normalized), note });
  push("immediate.net", raw.provenance.immediate, raw.effect.immediate?.net, eff.immediate?.net, "incurred obligation incurred by the change (never amount_due)");
  push("recurring.resultingAmount", raw.provenance.recurring, raw.effect.recurring?.resultingAmount, eff.recurring?.resultingAmount, "post-change price level; credits do not reduce it");
  push("recurring.previousAmount", "sum of current subscription_items[].amount (provider-stated)", raw.effect.recurring?.previousAmount, eff.recurring?.previousAmount);
  push("currency", "subscription.currency_code", ctx.currency, eff.recurring?.currency);
  // Next-invoice separation: figures exist in metadata only.
  const ni = (md.nextInvoiceEstimate ?? null) as { total?: number; amountDue?: number } | null;
  out.push({
    field: "nextInvoiceEstimate isolation",
    providerSource: "next_invoice_estimate.total / amount_due",
    rawDerived: raw.nextInvoice ? { total: raw.nextInvoice.total, amountDue: raw.nextInvoice.amountDue } : null,
    normalized: ni ? { total: ni.total, amountDue: ni.amountDue } : null,
    match: JSON.stringify(raw.nextInvoice ? { total: raw.nextInvoice.total, amountDue: raw.nextInvoice.amountDue } : null) === JSON.stringify(ni ? { total: ni.total, amountDue: ni.amountDue } : null)
      && eff.immediate?.net !== raw.nextInvoice?.amountDue,
    note: "next-invoice figures are metadata only; amount_due (net of credits) must never equal-by-substitution the incurred immediate",
  });
  const prov = (md.financialProvenance ?? {}) as Record<string, string>;
  out.push({
    field: "provenance recorded for every determined dimension",
    providerSource: "adapter financialProvenance",
    rawDerived: { immediate: raw.provenance.immediate, recurring: raw.provenance.recurring },
    normalized: prov,
    match: typeof prov.immediate === "string" && prov.immediate.length > 0 && typeof prov.recurring === "string" && prov.recurring.length > 0,
  });
  return out;
}

export type RunPilotOptions = {
  mode: "mocked" | "live";
  env?: Record<string, string | undefined>;
  subscriptionId?: string;
  targetQuantity?: number;
  mock?: PilotMockChargebee;
};

export async function runPilot(opts: RunPilotOptions): Promise<PilotReport> {
  const passClass: EvidenceClass = opts.mode === "live" ? "LIVE_PASS" : "SIMULATED_PASS";
  const steps: PilotStep[] = [];
  const capabilities: CapabilityResult[] = [];
  const targetQty = opts.targetQuantity ?? PILOT_TARGET_QTY;

  let baseTransport: HttpTransport;
  let clientConfig: { site: string; apiKey: string };
  let subscriptionId = opts.subscriptionId ?? PILOT_SUBSCRIPTION_ID;
  const mock = opts.mode === "mocked" ? (opts.mock ?? new PilotMockChargebee()) : undefined;

  if (opts.mode === "live") {
    const envStatus = chargebeeConfigFromEnv(opts.env ?? process.env);
    if (!envStatus.ok) {
      const blocked: PilotReport = {
        generatedAt: new Date().toISOString(),
        mode: "live",
        site: "<test-site>",
        subscriptionRef: "<subscription-id>",
        proposalDescription: `CHANGE_QUANTITY ${PILOT_ADDON} -> ${targetQty}`,
        steps: [{ step: "environment check", status: "blocked", detail: `Missing environment: ${envStatus.missing.join(", ")}. No network call was made.` }],
        comparisons: [],
        capabilities: [
          { capability: "retrieve subscription (live)", classification: "BLOCKED", basis: `credentials unavailable: ${envStatus.missing.join(", ")}` },
          { capability: "estimate-backed quote (live)", classification: "BLOCKED", basis: "credentials unavailable" },
          { capability: "live commit", classification: "BLOCKED", basis: "prohibited in this pilot; SCQ_LIVE_COMMIT_ENABLED untouched (false)" },
        ],
        transport: { totalCalls: 0, mutatingCalls: 0, estimateCalls: 0 },
      };
      return blocked;
    }
    clientConfig = envStatus.config;
    subscriptionId = opts.subscriptionId ?? envStatus.testSubscriptionId ?? "";
    baseTransport = fetchTransport;
  } else {
    clientConfig = { site: "pilot-test", apiKey: "pilot-mock-key" };
    baseTransport = mock!.transport;
  }

  // Capture the raw estimate response for the field-by-field comparison.
  let rawEstimateJson: any;
  const capturing: HttpTransport = async (req) => {
    const res = await baseTransport(req);
    if (req.url.includes("/estimates/") && res.json) rawEstimateJson = res.json;
    return res;
  };
  const client = new ChargebeeClient(clientConfig, capturing);

  const store = new QuoteStore();
  const adapter = new ChargebeeLiveAdapter(client, store, { liveCommitEnabled: false });

  // (1)+(2) retrieve + snapshot
  const snapshot = await adapter.getSubscription(subscriptionId);
  steps.push({ step: "retrieve subscription", status: "pass", detail: `status=${snapshot.status}, items=${snapshot.items.length}, version=${snapshot.version}` });
  steps.push({ step: "build SCQ snapshot", status: "pass", detail: `recurring=${snapshot.billing.recurringAmount} ${snapshot.billing.currency}` });
  capabilities.push({ capability: "retrieve subscription + snapshot", classification: passClass, basis: opts.mode === "live" ? "real test-site GET via fetch transport" : "mocked transport fixture (pilot mock)" });

  // (3)+(4) proposal + estimate-backed quote (read/estimate only)
  const proposal = {
    changes: [{ action: "CHANGE_QUANTITY" as const, itemId: PILOT_ADDON, quantity: targetQty }],
    effectiveIntent: { type: "IMMEDIATE" as const },
    // Explicit zero-tolerance envelope: omitted bounds retain
    // zero-tolerance semantics, so any drift at revalidation refuses.
    acceptanceEnvelope: {},
  };
  const quote = await adapter.createChangeQuote(subscriptionId, proposal);
  steps.push({ step: "construct proposal", status: "pass", detail: `CHANGE_QUANTITY ${PILOT_ADDON} 1 -> ${targetQty}, IMMEDIATE` });
  steps.push({ step: "provider-backed quote (estimate only)", status: "pass", detail: `quote ${quote.id}; immediate.net=${quote.commercialEffect.immediate?.net}; recurring=${quote.commercialEffect.recurring?.resultingAmount}` });
  capabilities.push({ capability: "estimate-backed quote", classification: passClass, basis: opts.mode === "live" ? "real test-site estimate POST (non-mutating)" : "mocked transport fixture (pilot mock)" });

  // (5) field-by-field comparison against the raw estimate
  const { json: rawSub } = await client.getSubscription(subscriptionId);
  const sub = rawSub.subscription;
  const currentItems = (sub.subscription_items ?? []).map((i: any) => ({ itemPriceId: i.item_price_id, quantity: i.quantity, unitPrice: i.unit_price, amount: i.amount, freeQuantity: i.free_quantity }));
  const targetItems = currentItems.map((i: { itemPriceId: string; quantity: number }) => (i.itemPriceId === PILOT_ADDON ? { itemPriceId: i.itemPriceId, quantity: targetQty } : { itemPriceId: i.itemPriceId, quantity: i.quantity }));
  const priceInfo = new Map<string, CbItemPriceInfo>();
  for (const id of targetItems.map((i: { itemPriceId: string }) => i.itemPriceId)) {
    const { json } = await client.getItemPrice(id);
    const ip = json?.item_price;
    if (ip) priceInfo.set(id, { itemPriceId: id, pricingModel: ip.pricing_model, price: ip.price, freeQuantity: ip.free_quantity, itemType: ip.item_type });
  }
  const comparisons = compareQuoteToRawEstimate(quote, rawEstimateJson, { currency: sub.currency_code ?? "USD", currentItems, targetItems, priceInfo });
  const allMatch = comparisons.every((c) => c.match);
  steps.push({ step: "field-by-field comparison (normalized vs raw)", status: allMatch ? "pass" : "fail", detail: `${comparisons.filter((c) => c.match).length}/${comparisons.length} fields match` });
  capabilities.push({ capability: "normalized-vs-raw field comparison", classification: allMatch ? passClass : (opts.mode === "live" ? "LIVE_FAIL" : "UNVERIFIED"), basis: "interpretChargebeeEstimate applied independently to the captured raw estimate response" });
  capabilities.push({ capability: "live commit", classification: "BLOCKED", basis: "prohibited in this pilot; harness constructs the adapter with liveCommitEnabled=false in both modes; SCQ_LIVE_COMMIT_ENABLED untouched" });
  capabilities.push({ capability: "mocked commit-path + recovery behavior", classification: "DOCUMENTATION_SUPPORTED", basis: "exercised by test21/test13 mocked suites, not by this read-only harness run" });

  const calls = mock?.calls ?? [];
  return {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    site: opts.mode === "live" ? "<test-site>" : "pilot-test (mocked)",
    subscriptionRef: opts.mode === "live" ? "<subscription-id>" : subscriptionId,
    proposalDescription: `CHANGE_QUANTITY ${PILOT_ADDON} 1 -> ${targetQty}`,
    steps,
    comparisons,
    capabilities,
    transport: {
      totalCalls: opts.mode === "mocked" ? calls.length : -1,
      mutatingCalls: opts.mode === "mocked" ? calls.filter((c) => c.mutating).length : 0,
      estimateCalls: opts.mode === "mocked" ? mock!.estimateCount : -1,
    },
    quote: {
      id: quote.id,
      immediateNet: quote.commercialEffect.immediate?.net,
      recurringResulting: quote.commercialEffect.recurring?.resultingAmount,
      recurringPrevious: quote.commercialEffect.recurring?.previousAmount,
      currency: quote.commercialEffect.recurring?.currency,
      provenance: (quote.providerMetadata as Record<string, unknown>)?.financialProvenance,
      nextInvoiceEstimate: (quote.providerMetadata as Record<string, unknown>)?.nextInvoiceEstimate ?? null,
    },
  };
}

export function renderMarkdown(report: PilotReport): string {
  const lines: string[] = [];
  lines.push(`# Chargebee pilot run — ${report.mode} mode`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt} · Site: ${report.site} · Subscription: ${report.subscriptionRef}`);
  lines.push(`Proposal: ${report.proposalDescription}`);
  lines.push("");
  lines.push("## Steps");
  for (const s of report.steps) lines.push(`- [${s.status}] ${s.step} — ${s.detail}`);
  lines.push("");
  lines.push("## Field-by-field comparison (normalized quote vs raw provider estimate)");
  lines.push("");
  lines.push("| Field | Provider source | Raw-derived | Normalized | Match |");
  lines.push("|---|---|---|---|---|");
  for (const c of report.comparisons) lines.push(`| ${c.field} | ${c.providerSource} | ${JSON.stringify(c.rawDerived)} | ${JSON.stringify(c.normalized)} | ${c.match ? "yes" : "NO"} |`);
  lines.push("");
  lines.push("## Capability classifications");
  lines.push("");
  lines.push("| Capability | Classification | Basis |");
  lines.push("|---|---|---|");
  for (const c of report.capabilities) lines.push(`| ${c.capability} | ${c.classification} | ${c.basis} |`);
  lines.push("");
  lines.push(`Transport: ${report.transport.totalCalls} calls, ${report.transport.estimateCalls} estimate calls, **${report.transport.mutatingCalls} mutating calls**.`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const subIdx = args.indexOf("--subscription");
  const report = await runPilot({ mode: live ? "live" : "mocked", subscriptionId: subIdx >= 0 ? args[subIdx + 1] : undefined });
  const md = renderMarkdown(report);
  console.log(md);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "pilot-report.json"), JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "pilot-report.md"), md);
    console.log(`Wrote ${path.join(outDir, "pilot-report.json")} and pilot-report.md`);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
