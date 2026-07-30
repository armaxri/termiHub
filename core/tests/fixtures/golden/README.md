# Golden-vector fixtures

Cross-language equivalence fixtures for the stateless-UI Rust ports (#2139,
Phase 0). Each pure TypeScript util that is ported to `termihub-core` keeps a
set of **golden vectors** here: input → expected-output cases extracted from the
util's authoritative TypeScript test suite. The Rust port runs against the same
vectors and must produce identical output, so any drift between the two
implementations fails a test.

The panel-tree port (#2143) established this convention; the sibling ports
(#2144–#2146) reuse it verbatim, and #2147 extracted the shared runner they all
drive (see [Shared runner](#shared-runner) below).

## TypeScript is authoritative

The vectors are **derived from the TypeScript suite, which stays the source of
truth.** The direction is one-way: expected values are lifted from the util's
`*.test.ts` cases, and the Rust port is written to reproduce them. So when a
golden case fails, the default is that **the Rust port is wrong** — fix the Rust
side (or, if the TS behaviour genuinely changed, update the TS test first, then
regenerate the affected vectors). Never "fix" a red case by editing `expected`
to match whatever Rust currently emits; that silently ratifies a divergence,
which is exactly what these fixtures exist to catch.

(The fixtures are plain JSON so a future `vitest` loader could replay them
against the TS implementation too — a genuine dual-run. Today only the Rust
`cargo test` side loads them; the TS side remains the authoring source rather
than a second reader.)

## Layout

```
core/tests/fixtures/golden/
  README.md                 # this file
  <util>/                   # one directory per ported util
    <function>.json         # one fixture file per exported function
```

For the panel-tree algebra that is `golden/panel_tree/<function>.json`
(e.g. `split_leaf.json`, `find_adjacent_leaf.json`); for the reconnect-backoff
state machine (#2144) it is `golden/reconnect_backoff/<function>.json`
(e.g. `backoff_delay.json`, `reconnect_reducer.json`).

## Fixture file format

Each file is a single JSON object:

```jsonc
{
  "operation": "splitLeaf",        // the exported function under test
  "cases": [
    {
      "name": "human-readable case description",
      "input": <primary argument>,  // the tree / panel / value the fn operates on
      "args":  { ... },             // remaining named arguments (omit if none)
      "expected": <serialized result>
    }
  ]
}
```

- **`input`** is the primary argument — the `PanelNode` tree for tree ops, the
  `LeafPanel` for `getPanelActiveSessionId`, the size array for `normalizeSizes`,
  the edge string for `edgeToSplit`.
- **`args`** carries the rest by name (`leafId`, `targetId`, `newLeaf`,
  `direction`, `position`, `currentLeafId`, `tabGroups`, `activeTabGroupId`, …;
  for reconnect-backoff: `config`, `event`, and a constant `rand` value
  standing in for the injected `() => number` generator).
- **`expected`** is the function's result serialized as JSON. A returned node is
  a full `PanelNode` (`{"type":"leaf",…}` / `{"type":"split",…}`); a "not found"
  / center result is `null`; scalars are plain JSON numbers, booleans or strings.

Nodes use the same shape both languages serialize to:

- **leaf**: `{"type":"leaf","id":…,"tabs":[…],"activeTabId":… }`
- **split**: `{"type":"split","id":…,"direction":"horizontal|vertical","children":[…]}`
  plus optional `"sizes"` and `"lastActiveLeafId"` (present only when set).
- **tab** (minimal projection the algebra reads):
  `{"id":…,"sessionId":…|null,"contentType":"terminal"|…}`

## Matcher conventions

The shared runner (`core/tests/support/golden.rs`, see below) compares
`expected` to the serialized actual result structurally, with two deliberate
relaxations:

1. **`"__GENERATED__"`** as an expected string matches any string in the actual
   output. Use it for freshly generated panel ids (`splitLeaf` wrapping a leaf,
   `simplifyTree` collapsing to a new empty leaf) whose value is
   non-deterministic by design.
2. **Numbers** compare within `1e-9`, absorbing cross-language float rounding in
   `normalizeSizes` / size redistribution.

Object key sets must match exactly — so omit optional fields (`sizes`,
`lastActiveLeafId`) from `expected` whenever the function does not set them.

## Shared runner

The loader, the structural matcher above, and the driver loop live **once** in
`core/tests/support/golden.rs` — a test-only support module (not a `cargo test`
target of its own; it sits in a subdirectory). It exposes three items:

- `run_golden_suite(util, min_cases, run_case)` — loads every `*.json` under
  `golden/<util>/`, and for each `{operation, cases}` envelope calls
  `run_case(operation, case)` per case and asserts the result matches. The
  `min_cases` floor fails the suite if fewer than that many cases ran (guards a
  fixture dir that silently loads nothing).
- `from::<T>(value)` — deserialize a fixture JSON value into a port argument
  type, panicking with a clear message on a shape mismatch.
- `json_matches(expected, actual)` / `fixture_dir(util)` — the matcher and path
  helper, exposed for direct use if ever needed (the driver uses them itself).

A per-util `*_golden.rs` file therefore contains **only** its `run_case`
mapping plus a one-line `#[test]`. See `core/tests/panel_tree_golden.rs` for the
worked example.

## Adding a new port's golden vectors

1. **Extract the vectors from the TS suite.** For the util's `src/utils/<util>.test.ts`,
   capture each interesting case as `{name, input, args?, expected}` and group
   the cases per exported function into `golden/<util>/<function>.json` with the
   `{operation, cases}` envelope above. `operation` is the exported (camelCase)
   TS function name; `expected` is its result serialized to JSON.
2. **Add the runner.** Create `core/tests/<util>_golden.rs`:

   ```rust
   mod support;
   use serde_json::Value;
   use support::golden::{from, run_golden_suite};
   // + the port's public items from termihub_core

   fn run_case(operation: &str, case: &Value) -> Value {
       let input = &case["input"];
       let args = &case["args"];
       match operation {
           "yourFunction" => serde_json::to_value(
               termihub_core::your_module::your_function(&from(input)),
           )
           .expect("serialize"),
           other => panic!("unknown golden operation: {other}"),
       }
   }

   #[test]
   fn golden_vectors_match_typescript() {
       run_golden_suite("<util>", <min_cases>, run_case);
   }
   ```

3. **Run it:** `cargo test -p termihub-core --test <util>_golden`. Every TS case
   must reproduce exactly; a mismatch means the Rust port diverges (fix the port,
   per [TypeScript is authoritative](#typescript-is-authoritative)).
