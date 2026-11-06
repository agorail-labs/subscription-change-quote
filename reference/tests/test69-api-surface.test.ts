import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Public API surface drift guard (Stable Release Engineering Program,
// Phase 2). The committed snapshot docs/api/public-api.snapshot.json
// is the reviewed public surface of the package entry. Any change to
// exported names — addition or removal — fails this test until the
// snapshot is regenerated and the change is reviewed as a deliberate
// API change (see docs/API-INVENTORY.md).
const here = dirname(fileURLToPath(import.meta.url));
const referenceRoot = join(here, "..", "..");
const script = join(referenceRoot, "scripts", "api-surface.mjs");
const entry = join(referenceRoot, "src", "index.ts");
const snapshot = join(referenceRoot, "..", "docs", "api", "public-api.snapshot.json");

test("public API surface matches the reviewed snapshot", () => {
  const out = execFileSync(process.execPath, [script, entry, "--check", snapshot], { encoding: "utf8" });
  assert.match(out, /API surface matches/);
});
