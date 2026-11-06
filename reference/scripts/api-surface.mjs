#!/usr/bin/env node
// Public API surface extractor (dependency-free, static).
// Usage: node api-surface.mjs <entry-file> [--check <snapshot.json>] [--write <snapshot.json>]
// Extracts value exports and type exports reachable from the entry
// module by following relative re-export statements one level deep
// (export { ... } from, export * from, export type * from).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const entry = process.argv[2];
if (!entry) { console.error("usage: api-surface.mjs <entry> [--check f] [--write f]"); process.exit(2); }
const mode = process.argv[3];
const snapPath = process.argv[4];

function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", base + ".d.ts", base + "/index.ts", base + "/index.d.ts"]) {
    try { readFileSync(cand); return cand; } catch { /* try next */ }
  }
  return null;
}

function declaredNames(file) {
  const src = readFileSync(file, "utf8");
  const values = new Set(), types = new Set();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) types.add(m[2]);
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:const|let|var|function|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) values.add(m[1]);
  return { values, types };
}

function extract(file, depth = 0) {
  const src = readFileSync(file, "utf8");
  const values = new Set(), types = new Set();
  // export { A, type B } from "./x"  |  export { A } (local)
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}(?:\s+from\s+"([^"]+)")?/g)) {
    const typeOnly = !!m[1];
    for (let part of m[2].split(",")) {
      part = part.trim(); if (!part) continue;
      const isType = typeOnly || /^type\s+/.test(part);
      const name = part.replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
      (isType ? types : values).add(name);
    }
  }
  // export * from "./x" / export type * from "./x"
  for (const m of src.matchAll(/export\s+(type\s+)?\*\s+from\s+"([^"]+)"/g)) {
    const target = resolveModule(file, m[2]);
    if (!target || depth > 2) continue;
    const sub = declaredNames(target);
    if (m[1]) { for (const t of sub.types) types.add(t); }
    else { for (const v of sub.values) values.add(v); for (const t of sub.types) types.add(t); }
  }
  // locally declared exports in the entry itself
  const own = declaredNames(file);
  for (const v of own.values) values.add(v);
  for (const t of own.types) types.add(t);
  return { values: [...values].sort(), types: [...types].sort() };
}

const surface = extract(resolve(entry));
const out = JSON.stringify(surface, null, 2) + "\n";
if (mode === "--write") { writeFileSync(snapPath, out); console.log(`wrote ${snapPath}: ${surface.values.length} values, ${surface.types.length} types`); }
else if (mode === "--check") {
  const expected = readFileSync(snapPath, "utf8");
  if (expected === out) { console.log(`API surface matches ${snapPath} (${surface.values.length} values, ${surface.types.length} types)`); }
  else {
    console.error("API surface DRIFT vs " + snapPath);
    const e = JSON.parse(expected);
    console.error("added values:", surface.values.filter(v => !e.values.includes(v)));
    console.error("removed values:", e.values.filter(v => !surface.values.includes(v)));
    console.error("added types:", surface.types.filter(v => !e.types.includes(v)));
    console.error("removed types:", e.types.filter(v => !surface.types.includes(v)));
    process.exit(1);
  }
} else { process.stdout.write(out); }
