/**
 * Exercise a packed SCQ reference tarball as a genuinely separate consumer.
 * Runs without publishing anything to npm or contacting a billing provider.
 * npm's local tarball install uses --offline and --ignore-scripts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = manifest.name;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const dir = mkdtempSync(join(tmpdir(), "scq-consumer-"));
const consumerDir = join(dir, "consumer");

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

try {
  const pack = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", dir], root, true));
  if (pack.length !== 1) throw new Error("Expected one npm tarball.");
  const entry = pack[0];
  const packedFiles = new Set(entry.files.map((file) => file.path));
  for (const expected of [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "LICENSE",
    "README.md",
    "DEVELOPER-GUIDE.md",
    "examples/scenario-a-verified.mjs",
    "examples/scenario-b-divergence.mjs",
    "examples/scenario-c-indeterminate.mjs",
    "package.json",
  ]) {
    if (!packedFiles.has(expected)) throw new Error("Missing required packed file: " + expected);
  }
  // dist/src/live/ (the env-gated Chargebee live pilot) must NOT ship:
  // the published artifact is simulator-only. The exports map already
  // encapsulates it; the files allowlist now excludes it outright.
  const excludedPrefixes = ["dist/tests/", "dist/demo/", "dist/scripts/", "dist/src/live/", "tests/", "demo/", "scripts/"];
  for (const file of packedFiles) {
    if (excludedPrefixes.some((prefix) => file.startsWith(prefix)) ||
        (file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
      throw new Error("Unexpected source/test/demo in distributed package: " + file);
    }
  }
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "scq-external-smoke", private: true, type: "module" }));
  const tarball = resolve(dir, entry.filename);
  run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerDir);

  const runtime = `import { StripeAdapter, StripeSim, QuoteStore, SCQError } from ${JSON.stringify(name)};
if (typeof StripeAdapter !== "function" || typeof StripeSim !== "function" || typeof SCQError !== "function") {
  throw new Error("Missing package runtime exports");
}
const adapter = new StripeAdapter(new StripeSim(), new QuoteStore());
if (adapter.getCapabilities().consistencyGuarantee !== "BEST_EFFORT") {
  throw new Error("Unexpected guarantee in consumer import");
}
console.log("External ESM import: OK");`;
  writeFileSync(join(consumerDir, "check.mjs"), runtime);
  run(process.execPath, [join(consumerDir, "check.mjs")], consumerDir);

  const typecheck = `import { StripeAdapter, StripeSim, QuoteStore, SCQError } from ${JSON.stringify(name)};
import type { SubscriptionProvider, SubscriptionChangeProposal, SubscriptionChangeReceipt } from ${JSON.stringify(name)};
const provider: SubscriptionProvider = new StripeAdapter(new StripeSim(), new QuoteStore());
const proposed: SubscriptionChangeProposal = {
  changes: [{ action: "CHANGE_QUANTITY", itemId: "seat_1", quantity: 120 }],
  effectiveIntent: { type: "IMMEDIATE" },
  acceptanceEnvelope: { maxRecurringIncrease: 0 }
};
const maybeReceipt: SubscriptionChangeReceipt | undefined = undefined;
void provider; void proposed; void maybeReceipt; void SCQError;`;
  writeFileSync(join(consumerDir, "check.mts"), typecheck);
  run(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2020",
    "--module", "NodeNext", "--moduleResolution", "NodeNext",
    join(consumerDir, "check.mts"),
  ], consumerDir);
  console.log("External TypeScript consumer: OK");

  // Run the shipped quick-start scenarios A and B from the INSTALLED
  // copy (in-memory only: they must pass even though this consumer
  // installed with --ignore-scripts, i.e. without a better-sqlite3
  // native binding — proof the simulator paths never load it).
  // Scenario C's durable segment needs the native binding and is
  // covered by the full clean-room procedure in
  // docs/PACKAGE-RELEASE-READINESS.md, not by this offline smoke.
  const installedExamples = join(consumerDir, "node_modules", ...name.split("/"), "examples");
  for (const scenario of ["scenario-a-verified.mjs", "scenario-b-divergence.mjs"]) {
    run(process.execPath, [join(installedExamples, scenario)], consumerDir);
    console.log("Installed example " + scenario + ": OK");
  }
  console.log("Tarball packaging smoke test: OK (nothing published)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
