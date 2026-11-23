# site-generator-speed-01 entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Siriusbounty/site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Siriusbounty/site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)`, which
returns byte-for-byte the output tree `build(input)` returns, for every case.

`main.ts` is the kit's driver, copied unchanged. `solve.js` is a
dependency-free ES module (Node 22+, no installs, no WASM/native code, no
clock/env/random/network, deterministic, nothing cached from one case to the
next; all per-case state lives inside `run()`).

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## How it is faster

- **Markdown, single pass.** The reference lexes into token objects with a
  regex per line, then renders them. This implementation scans each source
  once: one fused line classifier (blank / fence / heading / break / quote /
  list / other) per line, blocks rendered straight into an output array.
- **Inline rendering without slicing.** Strong/emphasis/link nesting recurses
  on index ranges of the original string, never on sliced copies. One regex
  scan jumps between the characters that need attention (Markdown constructs
  and HTML escapes alike), so plain runs are pushed as-is.
- **Templates compiled to flat op lists** once per case, rendered by an
  iterative VM (explicit call stack for includes, explicit loop stack for
  `{% for %}`) instead of the reference's recursive tree walk.
- **Constant partials cached.** Templates that (transitively) read only
  `site`, `tags` and `recent` — the same for every page — are rendered once
  per entry include depth and reused; the analysis accounts for names bound
  by `{% for %}` (including `loop`) and for include-depth limits.
- **Memoised slugify**, with an ASCII fast path (NFKD is the identity on
  ASCII, and ASCII holds no combining marks); anything else falls back to
  the reference implementation verbatim. Heading ids, tag slugs and title
  slugs share one per-case cache.
- **Cheaper helpers:** index-scanned front matter (no line split, no
  per-line regexes), table-driven word counting, reading minutes computed
  once per source, `\r` fast path in source reading, array-joined output
  strings.

## Verification (practice set, Node v24.22.1 here)

- `node cli/makefun.mjs grade-local --kit <kit> --bot <this dir> --driver process`:
  `cases_passed 3/3, passed 1`.
- Timing (9 timed rounds after warmup, same harness/method as the baseline):
  this entry median ≈ 144,000–170,000 µs total over the 3 practice cases
  (trimmed mean ≈ 148,000–168,000 µs); house baseline median ≈ 543,000–
  577,000 µs (trimmed mean ≈ 544,000–575,000 µs). About **3.4–3.9x faster**.
- Determinism: two executions produce byte-identical `answers.json`
  (grade-local's L1 regrade reproduces byte for byte).

---

<sub>Entered on [make.fun](https://make.fun/?ref=dn3tcxxh&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
