//! Shared cross-language golden-vector test runner (#2147).
//!
//! This is the reusable core of every `*_golden.rs` suite. The four Phase-0
//! util ports (panel-tree #2143, reconnect-backoff #2144, restore-mode #2145,
//! schema-defaults #2146) each re-implemented an identical fixture loader,
//! structural matcher, and driver loop; this module extracts them so Phase-1+
//! ports reuse it instead of copy-pasting.
//!
//! ## What a golden suite provides, and what this module provides
//!
//! A per-util suite supplies only the util-specific `run_case` closure — the
//! bit that deserializes a case's `input`/`args`, calls the Rust port, and
//! serializes the result back to JSON. Everything else (finding the fixture
//! files, parsing the `{operation, cases}` envelope, structural comparison with
//! the golden relaxations, and the "enough cases actually ran" sanity floor)
//! lives here in [`run_golden_suite`].
//!
//! The fixture format, directory layout, and the TS-authoritative convention are
//! documented in `tests/fixtures/golden/README.md`.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Directory holding one util's golden fixtures: `tests/fixtures/golden/<util>`.
///
/// `util` is the snake_case util directory name (`panel_tree`,
/// `reconnect_backoff`, `restore_mode`, `schema_defaults`, …).
pub fn fixture_dir(util: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden")
        .join(util)
}

/// Deserialize a fixture JSON value into a typed Rust value, panicking with a
/// clear message on shape mismatch. The workhorse `run_case` closures use this
/// to turn a case's `input`/`args` into the port's argument types.
pub fn from<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).expect("deserialize fixture value")
}

/// Deep structural JSON equality with the two golden-vector relaxations shared
/// across every suite:
///
///   * the string `"__GENERATED__"` in `expected` matches **any** string in
///     `actual` — for freshly generated, non-deterministic ids (e.g. `splitLeaf`
///     wrapping a leaf, `simplifyTree` collapsing to a new empty leaf);
///   * numbers compare within a `1e-9` tolerance, absorbing cross-language float
///     rounding (size redistribution, the backoff curve, …).
///
/// Object key sets must match **exactly**, so a fixture must omit optional
/// fields the function does not set. Suites whose data never contains
/// `"__GENERATED__"` are unaffected by that arm; keeping one matcher lets every
/// suite share it.
pub fn json_matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::String(e), _) if e == "__GENERATED__" => actual.is_string(),
        (Value::Number(e), Value::Number(a)) => match (e.as_f64(), a.as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-9,
            _ => e == a,
        },
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(x, y)| json_matches(x, y))
        }
        (Value::Object(e), Value::Object(a)) => {
            e.len() == a.len()
                && e.iter()
                    .all(|(k, v)| a.get(k).is_some_and(|av| json_matches(v, av)))
        }
        _ => expected == actual,
    }
}

/// Drive a util's whole golden suite.
///
/// Loads every `*.json` fixture under `tests/fixtures/golden/<util>`, and for
/// each `{operation, cases}` envelope runs `run_case(operation, case)` per case,
/// asserting the serialized actual result matches the case's `expected` under
/// [`json_matches`]. `min_cases` is a per-util sanity floor: the total number of
/// cases run must reach it, guarding against a suite that silently loads nothing.
///
/// `run_case` receives the fixture's `operation` string and the whole `case`
/// object (with its `input`, optional `args`, and `expected`), and returns the
/// port's result serialized to a [`Value`].
pub fn run_golden_suite<F>(util: &str, min_cases: usize, run_case: F)
where
    F: Fn(&str, &Value) -> Value,
{
    let dir = fixture_dir(util);
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read fixture dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "no golden fixtures found in {}",
        dir.display()
    );

    let mut total_cases = 0usize;
    for file in files {
        let raw = fs::read_to_string(&file).expect("read fixture");
        let fixture: Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", file.display()));
        let operation = fixture["operation"]
            .as_str()
            .unwrap_or_else(|| panic!("{} missing operation", file.display()));
        let cases = fixture["cases"]
            .as_array()
            .unwrap_or_else(|| panic!("{} missing cases array", file.display()));

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let actual = run_case(operation, case);
            let expected = &case["expected"];
            assert!(
                json_matches(expected, &actual),
                "golden mismatch in {} :: {operation} :: {name}\n  expected: {}\n  actual:   {}",
                file.display(),
                serde_json::to_string(expected).unwrap_or_default(),
                serde_json::to_string(&actual).unwrap_or_default(),
            );
            total_cases += 1;
        }
    }
    // Sanity: make sure the harness actually exercised a meaningful body of cases.
    assert!(
        total_cases >= min_cases,
        "only ran {total_cases} golden cases for {util} (expected >= {min_cases})"
    );
}
