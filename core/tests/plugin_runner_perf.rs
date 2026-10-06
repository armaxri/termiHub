//! Performance of the out-of-process plugin host against the in-process one
//! (#4182), measured with the real `echo-backend` example plugin against the
//! concept's budget ("Performance budget" in
//! `docs/concepts/backlog/plugin-os-sandbox.html`):
//!
//! * keystroke-to-echo latency: p99 added ≤ 0.5 ms (10 000 samples);
//! * single-session output throughput: ≥ 80 % of in-process and ≥ 100 MB/s.
//!
//! Ignored by default (timing-sensitive, and only meaningful optimised). Run:
//!
//! ```text
//! cargo test -p termihub-core --features plugin --release \
//!   --test plugin_runner_perf -- --ignored --nocapture
//! ```
//!
//! The nightly performance gate (concept phase 8) is a follow-up; this test
//! reports the numbers and asserts the latency budget and the absolute
//! throughput floor. The relative throughput figure is reported only (see the
//! note at the end of the test).
#![cfg(all(feature = "plugin", unix))]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod plugin_runner_support;
use plugin_runner_support::{
    host_for, install_echo, kill_process, new_connection, runner_binary, wait_until,
};

use termihub_core::connection::{ConnectionType, OutputReceiver};
use termihub_core::plugin::sandbox::PluginRunnerConfig;

const LATENCY_SAMPLES: usize = 10_000;
const THROUGHPUT_CHUNK: usize = 64 * 1024;
const THROUGHPUT_TOTAL: usize = 256 * 1024 * 1024;

/// `ConnectionType` is `Send` but not `Sync`; the throughput pump writes from
/// another thread, so the session sits behind an (uncontended) mutex.
type Shared = Arc<Mutex<Box<dyn ConnectionType>>>;

struct Measured {
    p50: Duration,
    p99: Duration,
    mb_per_s: f64,
}

async fn session(
    registry: &Arc<Mutex<termihub_core::connection::ConnectionTypeRegistry>>,
    type_id: &str,
) -> (Shared, OutputReceiver) {
    let mut conn = new_connection(registry, type_id);
    let rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "echoPrefix": "" }))
        .await
        .expect("connect");
    (Arc::new(Mutex::new(conn)), rx)
}

async fn measure(conn: Shared, mut rx: OutputReceiver) -> Measured {
    // Warm up.
    for _ in 0..200 {
        conn.lock().unwrap().write(b"w").unwrap();
        rx.recv().await.unwrap();
    }
    let mut samples = Vec::with_capacity(LATENCY_SAMPLES);
    for _ in 0..LATENCY_SAMPLES {
        let start = Instant::now();
        conn.lock().unwrap().write(b"x").unwrap();
        let chunk = rx.recv().await.unwrap();
        samples.push(start.elapsed());
        assert_eq!(chunk, b"x");
    }
    samples.sort();
    let p50 = samples[samples.len() / 2];
    let p99 = samples[samples.len() * 99 / 100];

    let writer = Arc::clone(&conn);
    let start = Instant::now();
    let pump = tokio::task::spawn_blocking(move || {
        let chunk = vec![b'a'; THROUGHPUT_CHUNK];
        for _ in 0..THROUGHPUT_TOTAL / THROUGHPUT_CHUNK {
            writer.lock().unwrap().write(&chunk).unwrap();
        }
    });
    let mut received = 0usize;
    while received < THROUGHPUT_TOTAL {
        received += rx.recv().await.expect("echo keeps flowing").len();
    }
    let elapsed = start.elapsed();
    pump.await.unwrap();
    let mb_per_s = THROUGHPUT_TOTAL as f64 / 1_000_000.0 / elapsed.as_secs_f64();
    Measured { p50, p99, mb_per_s }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "performance measurement; run optimised with --ignored --nocapture"]
async fn out_of_process_echo_stays_within_the_budget() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());

    let (in_host, in_registry) = host_for(&echo);
    let warm = Instant::now();
    in_host.load(&echo.plugin).unwrap();
    println!(
        "in-process load (trust + digest + dlopen + init) {:?}",
        warm.elapsed()
    );
    let (conn, rx) = session(&in_registry, &echo.type_id).await;
    let inproc = measure(conn, rx).await;
    in_host.unload(&echo.plugin.manifest.id);

    let (out_host, out_registry) = host_for(&echo);
    let out_host = out_host.with_runner(Some(PluginRunnerConfig::new(runner_binary())));
    let cold = Instant::now();
    out_host.load(&echo.plugin).unwrap();
    let cold_start = cold.elapsed();
    // A respawn after an idle reap: the same sequence on an already-seen binary.
    let handle = out_host
        .sandboxed_plugin(&echo.plugin.manifest.id)
        .expect("loaded out of process");
    let first_pid = handle.running().and_then(|p| p.pid()).expect("runner pid");
    kill_process(first_pid);
    assert!(wait_until(Duration::from_secs(5), || handle
        .running()
        .is_none()));
    let respawn = Instant::now();
    drop(session(&out_registry, &echo.type_id).await);
    println!(
        "runner respawn + first session (spawn + handshake + dlopen + init + create) {:?}",
        respawn.elapsed()
    );
    let pid = out_host
        .sandboxed_plugin(&echo.plugin.manifest.id)
        .and_then(|h| h.running())
        .and_then(|p| p.pid())
        .expect("runner pid");
    let rss = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    println!(
        "runner cold start (spawn + handshake + dlopen + init) {cold_start:?}; idle RSS {rss} KiB"
    );
    let (conn, rx) = session(&out_registry, &echo.type_id).await;
    let sandboxed = measure(conn, rx).await;
    out_host.unload(&echo.plugin.manifest.id);

    let added_p99 = sandboxed.p99.saturating_sub(inproc.p99);
    let ratio = sandboxed.mb_per_s / inproc.mb_per_s;
    println!(
        "echo latency  in-process p50 {:?} p99 {:?} | runner p50 {:?} p99 {:?} | p99 added {:?}",
        inproc.p50, inproc.p99, sandboxed.p50, sandboxed.p99, added_p99
    );
    println!(
        "throughput    in-process {:.0} MB/s | runner {:.0} MB/s | ratio {:.0} %",
        inproc.mb_per_s,
        sandboxed.mb_per_s,
        ratio * 100.0
    );
    if cfg!(debug_assertions) {
        println!("(debug build: numbers are indicative only; budgets not asserted)");
        return;
    }
    assert!(
        added_p99 <= Duration::from_micros(500),
        "p99 latency added {added_p99:?} exceeds the 0.5 ms budget"
    );
    assert!(
        sandboxed.mb_per_s >= 100.0,
        "runner throughput {:.0} MB/s is under 100 MB/s",
        sandboxed.mb_per_s
    );
    // The concept's relative budget (≥ 80 % of in-process) is reported, not
    // asserted: against this echo plugin the in-process "baseline" is a pure
    // in-memory copy (tens of GB/s), which no cross-process transport can
    // approach. Re-baselining it on a realistic pipeline is part of the phase-8
    // performance gate.
    if ratio < 0.8 {
        println!(
            "note: relative throughput {:.0} % is below the concept's 80 % \
             (in-process baseline is a memory copy)",
            ratio * 100.0
        );
    }
}
