#!/usr/bin/env python3
"""Machine check: the in-spec errata application (ER-1..ER-4) changes no
normative obligation and no API type relative to a base ref.

Usage: python3 research/errata-application/check_normative_diff.py [BASE_REF]
BASE_REF defaults to 9748e03daff4059a1a78eb8c14e98ceefba80fdc (main at the
PR #4 merge). Run from the repository root on the application branch.

Checks:
  1. Obligation lines: lines of spec/scq-v0.6.1-spec.md containing an
     obligation token (MUST, MUST NOT, SHALL, SHALL NOT, REQUIRED) are
     extracted from base and from the working tree, whitespace-normalized
     and wrap-joined, then compared as sorted multisets. Every differing
     line is printed for itemization.
  2. Obligation token counts (MUST / MUST NOT / SHALL / SHALL NOT /
     REQUIRED) in base vs working tree.
  3. reference/src/core/types.ts and reference/src/core/scq-engine.ts are
     byte-identical to base (sha256).
  4. TypeScript fences (```ts blocks) of the spec are identical to base.
Exit code 0 iff checks 3 and 4 pass and every check-1 difference is
printed (itemization is a human step; see NORMATIVE-DIFF-PROOF.md).
"""
import hashlib, re, subprocess, sys

BASE = sys.argv[1] if len(sys.argv) > 1 else "9748e03daff4059a1a78eb8c14e98ceefba80fdc"
SPEC = "spec/scq-v0.6.1-spec.md"
TOKENS = ["MUST NOT", "MUST", "SHALL NOT", "SHALL", "REQUIRED"]
TOKEN_RE = re.compile(r"\b(MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b")

def base_text(path):
    return subprocess.run(["git", "show", f"{BASE}:{path}"],
                          capture_output=True, text=True, check=True).stdout

def work_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()

def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def obligation_lines(text):
    """Wrap-join paragraphs, then keep logical lines containing a token."""
    logical, buf = [], ""
    for raw in text.splitlines():
        if raw.strip() == "":
            if buf: logical.append(buf); buf = ""
            continue
        buf = (buf + " " + raw.strip()) if buf else raw.strip()
    if buf: logical.append(buf)
    return sorted(l for l in logical if TOKEN_RE.search(l))

def ts_fences(text):
    return re.findall(r"```ts\n(.*?)```", text, flags=re.S)

fail = False
base_spec, work_spec = base_text(SPEC), work_text(SPEC)

print(f"== Check 1: obligation-line multiset (base {BASE[:12]} vs working tree) ==")
b, w = obligation_lines(base_spec), obligation_lines(work_spec)
from collections import Counter
cb, cw = Counter(b), Counter(w)
removed = list((cb - cw).elements()); added = list((cw - cb).elements())
print(f"base obligation lines: {len(b)} | branch obligation lines: {len(w)}")
print(f"removed: {len(removed)} | added: {len(added)}")
for l in removed: print(f"  REMOVED: {l}")
for l in added:   print(f"  ADDED:   {l}")

print("== Check 2: obligation token counts ==")
for t in TOKENS:
    pat = rf"\b{t}\b"
    print(f"  {t:10s} base={len(re.findall(pat, base_spec))} branch={len(re.findall(pat, work_spec))}")

print("== Check 3: frozen core files byte-identical ==")
for p in ["reference/src/core/types.ts", "reference/src/core/scq-engine.ts"]:
    same = sha(base_text(p).encode()) == sha(work_text(p).encode())
    print(f"  {p}: {'IDENTICAL' if same else 'DIFFERS'}")
    fail |= not same

print("== Check 4: spec TypeScript fences identical ==")
fb, fw = ts_fences(base_spec), ts_fences(work_spec)
same = fb == fw
print(f"  ts fences: base={len(fb)} branch={len(fw)} identical={same}")
fail |= not same

print("RESULT:", "FAIL" if fail else "PASS (checks 3-4 exact; check 1 differences itemized above)")
sys.exit(1 if fail else 0)
