import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { QuoteStore } from "../src/store/quote-store.js";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../src/store/mutation-coordinator.js";
import { StripeAdapter } from "../src/adapters/stripe-adapter.js";
import { StripeSim } from "../src/adapters/stripe-sim.js";
import { ChargebeeSim } from "../src/adapters/chargebee-sim.js";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";

// Stable Release Engineering Program, Phase 3 — adversarial and
// property-based hardening for the proposed stable core. Guarantees
// referenced from docs/STABLE-RELEASE-READINESS.md §3.
const execFileP = promisify(execFile);
const tempDirs: string[] = [];
after(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

// Deterministic PRNG (mulberry32) — property cases are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: quote arithmetic preserves integer minor units, currency, and exact recurring amounts (150 seeded cases)", async () => {
  const rand = rng(20261105);
  const nowSec = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
  // StripeSim resolves prices from its fixed catalog; quantities vary.
  const catalog = [
    { id: "price_seat_basic", unitAmount: 1000 },
    { id: "price_seat_pro", unitAmount: 1500 },
    { id: "price_seat_basic_annual", unitAmount: 10000 },
  ];
  for (let i = 0; i < 150; i++) {
    const price = catalog[Math.floor(rand() * catalog.length)];
    const unitAmount = price.unitAmount;
    const q0 = 1 + Math.floor(rand() * 1000);
    let q1 = 1 + Math.floor(rand() * 1000);
    if (q1 === q0) q1 += 1;
    const sim = new StripeSim(nowSec);
    sim.seedSubscription({
      id: "sub_prop",
      status: "active",
      items: [{ id: "si_1", price: { id: price.id, unitAmount, currency: "usd", interval: "month" }, quantity: q0 }],
      current_period_start: nowSec,
      current_period_end: nowSec + 30 * 24 * 3600,
      cancel_at_period_end: false,
    });
    const adapter = new StripeAdapter(sim, new QuoteStore());
    const quote = await adapter.createChangeQuote("sub_prop", {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "si_1", quantity: q1 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
    });
    const eff = quote.commercialEffect;
    assert.equal(eff.recurring?.resultingAmount, unitAmount * q1, `case ${i}: recurring must be exactly unitAmount*q1`);
    assert.equal(eff.recurring?.currency, "usd", `case ${i}: currency preserved`);
    assert.equal(eff.determinacy?.immediateFinancialEffect, "DETERMINED", `case ${i}: sim quote must be determined`);
    assert.ok(eff.immediate, `case ${i}: immediate effect present`);
    for (const [k, v] of Object.entries(eff.immediate)) {
      if (typeof v === "number") assert.ok(Number.isInteger(v), `case ${i}: immediate.${k} must be integer minor units, got ${v}`);
    }
    assert.ok(Number.isInteger(eff.immediate.net), `case ${i}: immediate.net integer`);
    if (q1 > q0) {
      // At period start the full remaining period is prorated.
      assert.equal(eff.immediate.charge, unitAmount * (q1 - q0), `case ${i}: upgrade charge at period start`);
      assert.ok(eff.immediate.net !== undefined && eff.immediate.net >= 0, `case ${i}: upgrade net non-negative`);
    } else {
      assert.ok(eff.immediate.net !== undefined && eff.immediate.net <= 0, `case ${i}: downgrade net non-positive (a credit, never a charge)`);
    }
    // Quoting never mutates.
    const afterQuote = await adapter.getSubscription("sub_prop");
    assert.equal(afterQuote.items[0].quantity, q0, `case ${i}: quote must not mutate`);
  }
});

test("concurrency (in-process): 10 simultaneous executes of one intent dispatch exactly once", async () => {
  const dir = tmpDir("scq-race-inproc-");
  const store = new DurableQuoteStore(join(dir, "race.db"));
  // A real quote must exist in the store first: beginDispatch refuses
  // intents for unknown quotes (fail-closed), which an earlier draft
  // of this test rediscovered the hard way.
  const sim = new ChargebeeSim(new Date("2026-08-01T00:00:00Z"));
  sim.seedSubscription({
    id: "sub_race",
    status: "active",
    subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat", quantity: 100 }],
    currentTermStart: "2026-08-01T00:00:00.000Z",
    currentTermEnd: "2026-08-31T00:00:00.000Z",
    nextBillingAt: "2026-08-31T00:00:00.000Z",
  });
  const adapter = new ChargebeeAdapter(sim, store);
  const quote = await adapter.createChangeQuote("sub_race", {
    changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
    effectiveIntent: { type: "IMMEDIATE" },
    guaranteeMode: "REVALIDATE",
    acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
  });
  const coordinator = new DurableMutationCoordinator(store);
  const intent = {
    quoteId: quote.id,
    subscriptionId: "sub_race",
    provider: "chargebee",
    request: { changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }] },
    idempotencyKey: "race-inproc-key",
  };
  let dispatches = 0;
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    coordinator.execute(intent, async () => {
      dispatches += 1;
      await new Promise(r => setTimeout(r, 50));
      return { type: "outcome" as const, outcome: "INDETERMINATE" as const, details: { reason: "race test settle" } };
    })));
  assert.equal(dispatches, 1, "exactly one dispatch across all concurrent executes");
  const settled = results.filter(r => r.status === "fulfilled" && r.value.type === "settled");
  assert.equal(settled.length, 1, "exactly one execute settles");
  store.close();
});

test("concurrency (multi-process): two processes racing one intent on one database dispatch exactly once", async () => {
  const dir = tmpDir("scq-race-mp-");
  const dbPath = join(dir, "race.db");
  const logPath = join(dir, "dispatches.log");
  // Parent prepares a real quote in the durable store, then closes it.
  {
    const sim = new ChargebeeSim(new Date("2026-08-01T00:00:00Z"));
    sim.seedSubscription({
      id: "sub_race_mp",
      status: "active",
      subscriptionItems: [{ id: "item_1", itemPriceId: "ip_seat", quantity: 100 }],
      currentTermStart: "2026-08-01T00:00:00.000Z",
      currentTermEnd: "2026-08-31T00:00:00.000Z",
      nextBillingAt: "2026-08-31T00:00:00.000Z",
    });
    const store = new DurableQuoteStore(dbPath);
    const adapter = new ChargebeeAdapter(sim, store);
    const quote = await adapter.createChangeQuote("sub_race_mp", {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }],
      effectiveIntent: { type: "IMMEDIATE" },
      guaranteeMode: "REVALIDATE",
      acceptanceEnvelope: { maxImmediateNetIncrease: 0, maxImmediateCreditDecrease: 0, maxRecurringIncrease: 0 },
    });
    writeFileSync(join(dir, "quote-id.txt"), quote.id);
    store.close();
  }
  const quoteId = readFileSync(join(dir, "quote-id.txt"), "utf8");
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = pathToFileURL(join(here, "..", "..", "dist", "src", "index.js")).href;
  const child = join(dir, "child.mjs");
  writeFileSync(child, `
import { DurableQuoteStore, DurableMutationCoordinator } from ${JSON.stringify(distEntry)};
import { appendFileSync } from "node:fs";
const store = new DurableQuoteStore(${JSON.stringify(dbPath)});
const coordinator = new DurableMutationCoordinator(store);
const intent = {
  quoteId: ${JSON.stringify(quoteId)},
  subscriptionId: "sub_race_mp",
  provider: "chargebee",
  request: { changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 120 }] },
  idempotencyKey: "race-mp-key",
};
try {
  const result = await coordinator.execute(intent, async () => {
    appendFileSync(${JSON.stringify(logPath)}, "DISPATCH\\n");
    await new Promise(r => setTimeout(r, 500));
    return { type: "outcome", outcome: "INDETERMINATE", details: { reason: "mp race settle" } };
  });
  console.log("RESULT:" + result.type);
} catch (e) {
  console.log("RESULT:error:" + e.name);
}
store.close();
`);
  const run = () => execFileP(process.execPath, [child], { timeout: 60_000 }).then(r => r.stdout);
  const [a, b] = await Promise.all([run(), run()]);
  const outcomes = [a, b].map(s => (s.match(/RESULT:.*/) ?? ["RESULT:none"])[0]);
  const dispatchCount = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length : 0;
  assert.equal(dispatchCount, 1, `exactly one cross-process dispatch (outcomes: ${outcomes.join(" | ")})`);
  assert.equal(outcomes.filter(o => o === "RESULT:settled").length, 1, `exactly one process settles (outcomes: ${outcomes.join(" | ")})`);
  assert.equal(outcomes.filter(o => o.includes("DispatchBlockedError")).length, 1, `the losing process is fenced out (outcomes: ${outcomes.join(" | ")})`);
});

test("corrupted persistence fails closed: garbage database never opens, never dispatches", async () => {
  const dir = tmpDir("scq-corrupt-");
  const dbPath = join(dir, "corrupt.db");
  writeFileSync(dbPath, Buffer.from("this is not a sqlite database at all".repeat(64)));
  assert.throws(() => new DurableQuoteStore(dbPath), "opening a garbage file as a store must throw, not silently succeed");
  // A valid database whose header is destroyed after close also fails closed.
  const dbPath2 = join(dir, "valid-then-corrupt.db");
  const store = new DurableQuoteStore(dbPath2);
  store.close();
  const bytes = readFileSync(dbPath2);
  bytes.write("GARBAGE!", 0);
  writeFileSync(dbPath2, bytes);
  assert.throws(() => new DurableQuoteStore(dbPath2), "a database with a destroyed header must throw on open");
});
