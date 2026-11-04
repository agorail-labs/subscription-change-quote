import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableQuoteStore } from "../src/store/durable-store.js";
import { runRehearsal } from "../src/live/pilot/rehearsal.js";
import { main as preflightMain } from "../src/live/pilot/run-preflight.js";

/**
 * Issue #48: only run-created rehearsal and automatic mocked-CLI
 * directories may be deleted, and only after their evidence is read.
 * These tests capture the EXACT owned directory via test-only callbacks:
 * they never glob-delete other callers' /tmp files.
 */
const own: string[] = [];
after(() => { for (const d of own) rmSync(d, { recursive: true, force: true }); });
function ownTemp() { const d=mkdtempSync(join(tmpdir(),"scq-issue48-test-")); own.push(d); return d; }

test("Test 68.1 (Issue #48): completed rehearsal removes exactly its own workspace after all recovery scenarios", async () => {
  let workspace = "";
  const r = await runRehearsal({ onWorkspaceCreatedForTest: path => { workspace = path; assert.ok(existsSync(path)); } });
  assert.ok(workspace.startsWith(join(tmpdir(),"scq-pr11-rh-")));
  assert.equal(r.scenariosTotal, 14);
  assert.equal(r.allPassed, true, r.scenarios.filter(s=>!s.pass).map(s=>s.evidence).join("\n"));
  assert.equal(existsSync(workspace), false, "owned rehearsal SQLite/WAL/SHM files removed only after full evidence creation");
});

test("Test 68.2 (Issue #48): interrupted rehearsal removes owned workspace even on thrown exception", async () => {
  let workspace = "";
  await assert.rejects(
    () => runRehearsal({ onWorkspaceCreatedForTest: path => { workspace = path; }, abortBeforeScenarioForTest: 1 }),
    /simulated rehearsal interruption/,
  );
  assert.ok(workspace);
  assert.equal(existsSync(workspace), false, "outer finally cleans the exact owned workspace after an interrupted run");
});

test("Test 68.3 (Issue #48): simultaneous rehearsal invocations never share or cross-remove owned directories", async () => {
  const paths: string[] = [];
  const a = runRehearsal({ onWorkspaceCreatedForTest: path=>{ paths.push(path); }, abortBeforeScenarioForTest: 1 });
  const b = runRehearsal({ onWorkspaceCreatedForTest: path=>{ paths.push(path); }, abortBeforeScenarioForTest: 1 });
  const results = await Promise.allSettled([a,b]);
  assert.deepEqual(results.map(r=>r.status), ["rejected","rejected"]);
  assert.equal(paths.length,2);
  assert.notEqual(paths[0],paths[1],"AsyncLocalStorage isolates each run");
  assert.ok(paths.every(p=>!existsSync(p)),"both independently allocated workspaces cleaned");
});

test("Test 68.4 (Issue #48): automatically-created mocked CLI fixture is cleaned after report generation", async () => {
  let workspace = "";
  const result = await preflightMain(["--skip-rehearsal"], {
    onFixtureCreatedForTest: path => { workspace=path; assert.ok(existsSync(path)); },
  });
  assert.equal(result,0);
  assert.ok(workspace.startsWith(join(tmpdir(),"scq-pr11-cli-")));
  assert.equal(existsSync(workspace),false,"CLI owns and deletes only its automatic mock fixture");
});

test("Test 68.5 (Issue #48): mocked CLI constructor/fixture error closes SQLite and removes only its own directory", async () => {
  let workspace = "";
  await assert.rejects(
    () => preflightMain(["--skip-rehearsal"], {
      onFixtureCreatedForTest: path => {workspace=path;},
      failAfterFixtureOpenForTest: true,
    }),
    /simulated mock fixture interruption/,
  );
  assert.ok(workspace);
  assert.equal(existsSync(workspace), false);
});

test("Test 68.6 (Issue #48): caller-supplied --db is never removed, even if preflight rejects missing origin", async () => {
  const dir = ownTemp();
  const path = join(dir,"caller.db");
  const store = new DurableQuoteStore(path, { recoveryGraceMs: 0 });
  store.close();
  assert.ok(existsSync(path));
  try {
    await preflightMain(["--skip-rehearsal","--db",path,"--quote","missing-quote"]);
  } catch {
    // Missing quote/origin may fail, but cleanup must remain scoped.
  }
  assert.ok(existsSync(path), "existing caller-owned database must not be deleted");
  assert.ok(existsSync(dir), "caller-owned directory must not be deleted");
  const entries = readFileSync(path);
  assert.ok(entries.length>0,"caller-owned SQLite database has not been removed or truncated");
});
