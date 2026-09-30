//! Parity lock for the direct `files::transfer::TransferProgress` → store
//! [`TransferProgress`] conversion (#2973, PERF-007 follow-up).
//!
//! The server fold used to JSON round-trip every progress sample
//! (`serde_json::to_value` + `serde_json::from_value`) so it parsed the event
//! through the exact path the client `transfer.progress` route runs. The fold now
//! converts the struct directly; these tests keep the old round-trip as the
//! **oracle** and prove, over a table of every state / phase / direction and the
//! `Some`/`None`/empty/edge-value shapes of each field, that:
//!
//! 1. the converted struct equals the round-tripped one field-for-field, and
//! 2. folding either into a store yields the identical store transition, with no
//!    prior row and on top of each kind of prior row (so the `prev`-dependent
//!    speed / ETA / path / retry-counter carry-over is covered too).

use std::time::Instant;

use crate::files::transfer::state::TransferStateTag;
use crate::files::transfer::{
    TransferDirection as WireDirection, TransferPhase as WirePhase,
    TransferProgress as WireProgress,
};

use super::{TransferProgress, TransferStore};

const NOW: u64 = 50_000;

/// The pre-#2973 path, kept verbatim as the oracle.
fn oracle(p: &WireProgress) -> TransferProgress {
    serde_json::from_value(serde_json::to_value(p).expect("wire event serializes"))
        .expect("round-tripped event parses")
}

const STATES: [TransferStateTag; 6] = [
    TransferStateTag::Queued,
    TransferStateTag::Active,
    TransferStateTag::Paused,
    TransferStateTag::Completed,
    TransferStateTag::Failed,
    TransferStateTag::Cancelled,
];

const PHASES: [WirePhase; 4] = [
    WirePhase::Transferring,
    WirePhase::Done,
    WirePhase::Cancelled,
    WirePhase::Error,
];

const DIRECTIONS: [WireDirection; 2] = [WireDirection::Download, WireDirection::Upload];

/// Empty (skipped on the wire → `None`), plain, and awkward-to-escape strings.
const STRINGS: [&str; 3] = ["", "/remote/data.csv", "/ü/🚀 \"q\" \\ \n\t\u{0}"];

/// `(transferred, total, total_bytes, speed, attempt, max_attempts)` edges,
/// including all-zero, all-max and inconsistent total vs total_bytes.
const NUMERICS: [(u64, u64, u64, u64, u32, u32); 4] = [
    (0, 0, 0, 0, 0, 0),
    (u64::MAX, u64::MAX, u64::MAX, u64::MAX, u32::MAX, u32::MAX),
    (500, 1000, 1000, 1, 1, 3),
    (1500, 1000, 0, 0, 2, 0),
];

/// Every combination of the table dimensions.
fn table() -> Vec<WireProgress> {
    let messages = [None, Some(String::new()), Some("boom ⚠".to_string())];
    let etas = [None, Some(0), Some(u64::MAX)];
    let mut out = Vec::new();
    for state in STATES {
        for phase in PHASES {
            for direction in DIRECTIONS {
                for (i, path) in STRINGS.iter().enumerate() {
                    for message in &messages {
                        for eta_secs in etas {
                            for (transferred, total, total_bytes, speed, attempt, max_attempts) in
                                NUMERICS
                            {
                                out.push(WireProgress {
                                    transfer_id: "t-1".to_string(),
                                    session_id: "sess-1".to_string(),
                                    direction,
                                    file_name: STRINGS[(i + 1) % STRINGS.len()].to_string(),
                                    path: path.to_string(),
                                    transferred,
                                    total,
                                    phase,
                                    message: message.clone(),
                                    state,
                                    speed,
                                    total_bytes,
                                    eta_secs,
                                    attempt,
                                    max_attempts,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Prior rows the fold may land on: none, an `active` row (seeds throughput /
/// ETA smoothing), and a `paused` row carrying path + retry counters.
fn priors() -> Vec<Option<WireProgress>> {
    let base = |state, transferred, speed, path: &str, attempt| WireProgress {
        transfer_id: "t-1".to_string(),
        session_id: "sess-1".to_string(),
        direction: WireDirection::Download,
        file_name: "prev.bin".to_string(),
        path: path.to_string(),
        transferred,
        total: 1000,
        phase: WirePhase::Transferring,
        message: None,
        state,
        speed,
        total_bytes: 1000,
        eta_secs: Some(7),
        attempt,
        max_attempts: 5,
    };
    vec![
        None,
        Some(base(TransferStateTag::Active, 100, 0, "", 0)),
        Some(base(TransferStateTag::Active, 100, 250, "/prev/path", 1)),
        Some(base(TransferStateTag::Paused, 300, 0, "/prev/path", 2)),
    ]
}

#[test]
fn direct_conversion_equals_the_json_round_trip_for_every_shape() {
    let cases = table();
    assert_eq!(cases.len(), 6 * 4 * 2 * 3 * 3 * 3 * 4);
    for (i, wire) in cases.iter().enumerate() {
        assert_eq!(
            TransferProgress::from(wire),
            oracle(wire),
            "case {i}: direct conversion diverged from the round-trip for {wire:?}"
        );
    }
}

#[test]
fn direct_conversion_yields_the_identical_store_transition() {
    for prior in priors() {
        for (i, wire) in table().iter().enumerate() {
            let direct = TransferStore::new();
            let round_trip = TransferStore::new();
            if let Some(prev) = &prior {
                // Seed both stores through the oracle so the prior is identical.
                let parsed = oracle(prev);
                direct.progress(&parsed, NOW - 1_000);
                round_trip.progress(&parsed, NOW - 1_000);
            }
            direct.progress(&TransferProgress::from(wire), NOW);
            round_trip.progress(&oracle(wire), NOW);
            assert_eq!(
                direct.get("t-1"),
                round_trip.get("t-1"),
                "case {i} (prior {prior:?}): store row diverged for {wire:?}"
            );
            assert_eq!(
                direct.snapshot(),
                round_trip.snapshot(),
                "case {i}: region snapshot diverged"
            );
        }
    }
}

/// Rough before/after cost of producing the store event per progress sample.
/// Informational only — run with
/// `cargo test -p termihub --lib progress_parity -- --ignored --nocapture`.
#[test]
#[ignore = "micro-benchmark; run manually"]
fn bench_direct_conversion_vs_round_trip() {
    let wire = WireProgress {
        transfer_id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0".to_string(),
        session_id: "sess-1234".to_string(),
        direction: WireDirection::Upload,
        file_name: "backup-2026-09-30.tar.gz".to_string(),
        path: "/srv/backups/backup-2026-09-30.tar.gz".to_string(),
        transferred: 734_003_200,
        total: 2_147_483_648,
        phase: WirePhase::Transferring,
        message: None,
        state: TransferStateTag::Active,
        speed: 12_582_912,
        total_bytes: 2_147_483_648,
        eta_secs: Some(112),
        attempt: 0,
        max_attempts: 5,
    };
    const N: u32 = 200_000;
    let t = Instant::now();
    for _ in 0..N {
        std::hint::black_box(oracle(std::hint::black_box(&wire)));
    }
    let before = t.elapsed();
    let t = Instant::now();
    for _ in 0..N {
        std::hint::black_box(TransferProgress::from(std::hint::black_box(&wire)));
    }
    let after = t.elapsed();
    println!(
        "round-trip: {:?}/sample, direct: {:?}/sample ({:.1}x)",
        before / N,
        after / N,
        before.as_secs_f64() / after.as_secs_f64()
    );
}
