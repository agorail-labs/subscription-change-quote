/** Issue #48 CI-only residue verifier; never deletes files.
 * Snapshot before two full npm test runs; assert that neither creates new
 * scq-pr11-rh-* or scq-pr11-cli-* directories. This compares names against
 * the BEFORE snapshot rather than deleting or asserting on preexisting user
 * files in /tmp. Runner isolation excludes other repositories.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const baselineFile = resolve(".scq-pilot-temp-baseline.json");
const prefixes = ["scq-pr11-rh-", "scq-pr11-cli-"];
const snapshot = () => readdirSync(tmpdir(), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && prefixes.some(prefix => entry.name.startsWith(prefix)))
  .map(entry => entry.name)
  .sort();
if (process.argv[2] === "snapshot") {
  writeFileSync(baselineFile, JSON.stringify({ before: snapshot() }) + "\n");
  console.log("Issue #48 pilot temp baseline captured");
} else if (process.argv[2] === "check") {
  if (!existsSync(baselineFile)) throw Error("Missing Issue #48 baseline; fail closed");
  const { before } = JSON.parse(readFileSync(baselineFile, "utf8"));
  if (!Array.isArray(before) || !before.every((entry) => typeof entry === "string")) {
    throw Error("Invalid issue48 baseline; fail closed");
  }
  const previous = new Set(before);
  const fresh = snapshot().filter(name => !previous.has(name));
  console.log(`Issue #48: new leftover pilot temp directories after two suites: ${fresh.length}`);
  if (fresh.length) throw Error("Pilot fixture temp residue: " + fresh.join(", "));
} else {
  throw Error("usage: node scripts/pilot-residue-check.mjs snapshot|check");
}
