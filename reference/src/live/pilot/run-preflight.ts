/**
 * CLI: `npm run preflight:chargebee` (PR-11).
 *
 * Produces the read-only exact-commit preflight report (JSON +
 * Markdown) for an identified durable quote, preceded by the mocked
 * recovery rehearsal whose summary feeds readiness condition 2.
 *
 * Modes:
 * - Default (mocked): builds the canonical pilot fixture quote in a
 *   temporary durable database over the mocked transport, rehearses,
 *   and preflights it. Evidence is SIMULATED; the overall assessment
 *   is NO-GO by construction (conditions 1/3/4/5 unresolved).
 * - `--db <path> --quote <id>`: preflights an EXISTING durable quote
 *   record. With `--live`, reads go to the real Chargebee test tenant
 *   through the preflight's own internally constructed guarded
 *   real-network transport (structural provenance, PF1 — there is no
 *   caller-asserted origin); this requires CHARGEBEE_SITE +
 *   CHARGEBEE_API_KEY in the environment and the site listed in
 *   SCQ_PILOT_APPROVED_TEST_SITES. Without that configuration the
 *   run is BLOCKED (reported, never fabricated).
 *
 * Quote origin (PF3): site/subscription binding is established from
 * the quote-origin manifest — issuance records written when a quote
 * was created (see quote-origin.ts). The mocked fixture path below
 * records the fixture quote's origin at issuance; for an existing
 * database the manifest is read from `--origin-manifest <path>`
 * (default `<db>.origins.jsonl`). A quote with no origin record
 * BLOCKS: the CLI never falls back to asserting the configured site
 * as the quote's origin.
 *
 * Operator-supplied records are inputs, recorded as supplied:
 * - `--attest-test-tenant`: the operator running this command attests
 *   the configured tenant is a test tenant they control.
 * - `--owner <name> [--owner-backup <name>]`: a named reconciliation
 *   owner who has accepted the runbook (condition 4 input).
 * - `--release-approved-ref <ref>`: a v0.6.2 release-approval record
 *   reference (condition 1 input; never inferred from merged PRs).
 * - `--authorization-ref <ref>`: a separate commit-authorization
 *   record reference (condition 5 input; this tool grants nothing).
 *
 * The preflight NEVER commits: its transport rejects update_for_items
 * before dispatch, and SCQ_LIVE_COMMIT_ENABLED=true in the
 * environment refuses the run outright.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChargebeeClient, type HttpTransport } from "../chargebee-http.js";
import { ChargebeeLiveAdapter } from "../chargebee-scq-adapter.js";
import { PilotMockChargebee } from "./mock-transport.js";
import { approvedTestSitesFromEnv } from "./live-guard.js";
import { QuoteOriginManifest } from "./quote-origin.js";
import { DurableQuoteStore } from "../../store/durable-store.js";
import { DurableMutationCoordinator } from "../../store/mutation-coordinator.js";
import { createRealPreflightTransport, runPreflight, renderPreflightMarkdown, type RealPreflightTransport } from "./preflight.js";
import { runRehearsal } from "./rehearsal.js";

const SUB = "pilot-sub-001";
const ADDON = "pilot-addon-vision";
const SITE = "pilot-test";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const live = argv.includes("--live");
  const dbPath = argValue(argv, "--db");
  const quoteIdArg = argValue(argv, "--quote");
  const outDir = argValue(argv, "--out");
  const skipRehearsal = argv.includes("--skip-rehearsal");

  const rehearsal = skipRehearsal ? undefined : await runRehearsal();
  if (rehearsal) {
    console.log(`rehearsal: ${rehearsal.scenariosPassed}/${rehearsal.scenariosTotal} scenarios passed (${rehearsal.evidenceClass})`);
    for (const s of rehearsal.scenarios.filter((x) => !x.pass)) console.log(`  FAILED ${s.id}: ${s.evidence}`);
  }

  let store: DurableQuoteStore;
  let transport: HttpTransport | undefined;
  let realTransport: RealPreflightTransport | undefined;
  let originManifest: QuoteOriginManifest;
  let site: string;
  let quoteId: string;
  let apiKey: string | undefined;

  const manifestFor = (db: string): QuoteOriginManifest =>
    QuoteOriginManifest.load(argValue(argv, "--origin-manifest") ?? `${db}.origins.jsonl`);

  if (live) {
    site = process.env.CHARGEBEE_SITE ?? "";
    apiKey = process.env.CHARGEBEE_API_KEY;
    if (!apiKey || !site || !dbPath || !quoteIdArg) {
      console.log("preflight --live: BLOCKED — requires CHARGEBEE_SITE and CHARGEBEE_API_KEY in the environment plus --db <durable database> and --quote <quote id>. No report is fabricated without them.");
      return 2;
    }
    store = new DurableQuoteStore(dbPath, { recoveryGraceMs: 0 });
    // PF1: the LIVE path uses the preflight module's own internally
    // constructed guarded network transport — the only construction
    // whose evidence can be classified as real.
    realTransport = createRealPreflightTransport();
    originManifest = manifestFor(dbPath);
    quoteId = quoteIdArg;
  } else {
    site = SITE;
    apiKey = "pilot-mock-key";
    const mock = new PilotMockChargebee();
    transport = mock.transport as HttpTransport;
    if (dbPath && quoteIdArg) {
      store = new DurableQuoteStore(dbPath, { recoveryGraceMs: 0 });
      originManifest = manifestFor(dbPath);
      quoteId = quoteIdArg;
    } else {
      const dir = mkdtempSync(join(tmpdir(), "scq-pr11-cli-"));
      const path = join(dir, "scq.db");
      store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
      const client = new ChargebeeClient({ site, apiKey }, transport);
      const adapter = new ChargebeeLiveAdapter(client, store, {
        liveCommitEnabled: false, // quote creation only; the preflight never enables commit
        durableCoordinator: new DurableMutationCoordinator(store),
        providerSite: site,
      });
      const quote = await adapter.createChangeQuote(SUB, {
        changes: [{ action: "CHANGE_QUANTITY", itemId: ADDON, quantity: 21 }],
        effectiveIntent: { type: "IMMEDIATE" },
        acceptanceEnvelope: {},
      });
      quoteId = quote.id;
      // PF3: origin is recorded AT ISSUANCE, with the site taken
      // from this run's configuration — the record the preflight
      // below binds to. (A real issuance harness does the same at
      // its own quote-creation step; without a record, preflight
      // blocks.)
      originManifest = new QuoteOriginManifest(join(dir, "scq.db.origins.jsonl"));
      originManifest.record({ stored: store.get(quoteId)!, site, recordedBy: "run-preflight mocked issuance (fixture)" });
      console.log(`mocked fixture quote: ${quoteId} (durable db ${path}; origin recorded in ${originManifest.filePath})`);
    }
  }

  const owner = argValue(argv, "--owner");
  const releaseRef = argValue(argv, "--release-approved-ref");
  const authorizationRef = argValue(argv, "--authorization-ref");
  const report = await runPreflight({
    quoteId,
    store,
    ...(realTransport ? { realTransport } : { transport }),
    originManifest,
    site,
    approvedTestSites: live ? approvedTestSitesFromEnv() : [SITE],
    apiKey,
    operatorAttestation: argv.includes("--attest-test-tenant") ? { testTenantAttested: true, attestedBy: "operator running this command (--attest-test-tenant)" } : undefined,
    env: process.env,
    rehearsal: rehearsal ? { completed: true, scenariosPassed: rehearsal.scenariosPassed, scenariosTotal: rehearsal.scenariosTotal, reference: "runRehearsal() in this process (mocked)" } : undefined,
    humanInputs: {
      ...(releaseRef ? { releaseApproval: { approved: true, reference: releaseRef } } : {}),
      ...(owner ? { reconciliationOwner: { name: owner, backupName: argValue(argv, "--owner-backup"), rehearsalReference: rehearsal ? "runRehearsal() in this process (mocked)" : undefined } } : {}),
      ...(authorizationRef ? { commitAuthorization: { granted: true, reference: authorizationRef } } : {}),
    },
  });
  store.close();

  const json = JSON.stringify(report, null, 2);
  const md = renderPreflightMarkdown(report);
  if (outDir) {
    writeFileSync(join(outDir, "preflight.json"), json + "\n");
    writeFileSync(join(outDir, "preflight.md"), md + "\n");
    console.log(`wrote ${join(outDir, "preflight.json")} and ${join(outDir, "preflight.md")}`);
  }
  console.log(md);
  console.log(`\noverall: ${report.overall} · blockers: ${report.blockers.length} · observed calls: ${report.transport.totalCalls} (mutating ${report.transport.mutatingCalls})`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
