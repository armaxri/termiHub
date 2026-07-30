# Golden-vector fixtures

Cross-language equivalence fixtures for the stateless-UI Rust ports (#2139,
Phase 0). Each pure TypeScript util that is ported to `termihub-core` keeps a
set of **golden vectors** here: input → expected-output cases extracted from the
util's authoritative TypeScript test suite. The Rust port runs against the same
vectors and must produce identical output, so any drift between the two
implementations fails a test.

The panel-tree port (#2143) established this convention; the sibling ports
(#2144–#2147) reuse it verbatim.

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

The Rust harness (`core/tests/panel_tree_golden.rs`) compares `expected` to the
serialized actual result structurally, with two deliberate relaxations:

1. **`"__GENERATED__"`** as an expected string matches any string in the actual
   output. Use it for freshly generated panel ids (`splitLeaf` wrapping a leaf,
   `simplifyTree` collapsing to a new empty leaf) whose value is
   non-deterministic by design.
2. **Numbers** compare within `1e-9`, absorbing cross-language float rounding in
   `normalizeSizes` / size redistribution.

Object key sets must match exactly — so omit optional fields (`sizes`,
`lastActiveLeafId`) from `expected` whenever the function does not set them.
