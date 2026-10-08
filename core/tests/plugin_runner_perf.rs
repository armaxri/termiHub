//! Performance gate of the out-of-process plugin host (#4182, #4190), measured
//! with the real `echo-backend` example plugin against the concept's budget
//! ("Performance budget" in `docs/concepts/backlog/plugin-os-sandbox.html`):
//!
//! | Metric                          | Budget                                  |
//! | ------------------------------- | --------------------------------------- |
//! | keystroke-to-echo latency       | p99 added ≤ 0.5 ms (10 000 samples)     |
//! | output throughput, one session  | ≥ 100 MB/s absolute (256 MiB)           |
//! | 40 concurrent sessions          | every session completes; fairness ≤ 2×  |
//! | helper cold start               | ≤ 150 ms p95 (spawn + handshake + init) |
//! | idle helper memory              | ≤ 15 MiB RSS                            |
//!
//! Every budget breach is collected and reported together, then fails the
//! test, so one nightly run names every regression. The budgets are absolute
//! ceilings rather than "within 20 % of the last run": a hosted CI runner
//! varies far more than 20 % from run to run, so a stored baseline would either
//! flap or be loose enough to say nothing.
//!
//! Throughput has no relative budget: the in-process "baseline" of the echo
//! plugin is a plain memory copy (tens of GB/s) that no cross-process transport
//! can approach, so the old "≥ 80 % of in-process" figure is reported only
//! (concept re-baselined in #4190).
//!
//! Ignored by default (timing-sensitive, and only meaningful optimised); the
//! nightly `plugin-sandbox-nightly.yml` lane runs it on Linux, macOS and
//! Windows (#4233; there the runner starts in its LPAC AppContainer under a job
//! object, and "RSS" is the runner's working set). Run:
//!
//! ```text
//! cargo test -p termihub-core --features plugin --release \
//!   --test plugin_runner_perf -- --ignored --nocapture
//! ```
//!
//! Set `TERMIHUB_PERF_REPORT=<file>` to also write the numbers as JSON.
#![cfg(feature = "plugin")]

use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

mod plugin_runner_support;
use plugin_runner_support::{
    host_for, install_echo, kill_process, new_connection, rss_kib, runner_binary, wait_until,
};

use termihub_core::connection::{ConnectionType, ConnectionTypeRegistry, OutputReceiver};
use termihub_core::plugin::sandbox::{OutputRateCap, PluginRunnerConfig};
use termihub_core::plugin::{InstalledPlugin, PluginHost};

const LATENCY_SAMPLES: usize = 10_000;
const THROUGHPUT_CHUNK: usize = 64 * 1024;
const THROUGHPUT_TOTAL: usize = 256 * 1024 * 1024;
const COLD_START_SAMPLES: usize = 40;
const FAIR_SESSIONS: usize = 40;
const FAIR_CHUNK: usize = 16 * 1024;
/// Per fairness session. Large enough that no session can finish inside one
/// OS scheduling quantum (~10 ms on macOS): with 8 MiB a writer thread that
/// got a core first on a 3-vCPU CI runner finished alone (~7 ms) before the
/// other 39 threads were scheduled at all, a 76x "spread" that measured the
/// test's own thread scheduling rather than the channel's sharing.
const FAIR_PER_SESSION: usize = 64 * 1024 * 1024;

/// The budget table (see the module docs).
const BUDGET_ADDED_P99: Duration = Duration::from_micros(500);
const BUDGET_MB_PER_S: f64 = 100.0;
const BUDGET_COLD_START_P95: Duration = Duration::from_millis(150);
const BUDGET_IDLE_RSS_KIB: u64 = 15 * 1024;
const BUDGET_FAIRNESS: f64 = 2.0;
/// A session of the 40 that has not finished by then is starved.
const STARVATION_TIMEOUT: Duration = Duration::from_secs(60);

/// `ConnectionType` is `Send` but not `Sync`; the throughput pump writes from
/// another thread, so the session sits behind an (uncontended) mutex.
type Shared = Arc<Mutex<Box<dyn ConnectionType>>>;
type Registry = Arc<Mutex<ConnectionTypeRegistry>>;

struct Measured {
    p50: Duration,
    p99: Duration,
    mb_per_s: f64,
}

async fn session(registry: &Registry, type_id: &str) -> (Shared, OutputReceiver) {
    let mut conn = new_connection(registry, type_id);
    let rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "echoPrefix": "" }))
        .await
        .expect("connect");
    (Arc::new(Mutex::new(conn)), rx)
}

fn percentile(sorted: &[Duration], pct: usize) -> Duration {
    sorted[(sorted.len() * pct / 100).min(sorted.len() - 1)]
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
    let (p50, p99) = (percentile(&samples, 50), percentile(&samples, 99));
    let mb_per_s = pump(
        conn,
        rx,
        THROUGHPUT_CHUNK,
        THROUGHPUT_TOTAL,
        Arc::new(Barrier::new(1)),
    )
    .await
    .expect("echo keeps flowing");
    Measured { p50, p99, mb_per_s }
}

/// Write `total` bytes in `chunk`-sized writes from a blocking thread while
/// draining the echo; return MB/s, or `None` if the echo stopped.
///
/// The writer starts once every pump sharing `start` is ready, and the rate is
/// timed from that common release: otherwise the first writers of a fairness
/// run would pump alone while the others' threads are still being created (a
/// 3-vCPU CI runner showed one session at 936 MB/s, near the solo rate, next
/// to 25 MB/s ones), which measures thread start-up skew, not sharing.
async fn pump(
    conn: Shared,
    mut rx: OutputReceiver,
    chunk: usize,
    total: usize,
    start: Arc<Barrier>,
) -> Option<f64> {
    let writer = tokio::task::spawn_blocking(move || {
        start.wait();
        let released = Instant::now();
        let data = vec![b'a'; chunk];
        for _ in 0..total / chunk {
            conn.lock().unwrap().write(&data).unwrap();
        }
        released
    });
    let mut received = 0usize;
    while received < total {
        received += rx.recv().await?.len();
    }
    let done = Instant::now();
    let released = writer.await.unwrap();
    Some(total as f64 / 1_000_000.0 / (done - released).as_secs_f64())
}

/// `n` cold starts (spawn + handshake + dlopen + init) by loading and
/// unloading the plugin out of process; sorted.
///
/// One unmeasured start goes first: the very first exec of a freshly built
/// binary pays a one-off OS assessment (Gatekeeper on macOS, ~300 ms, see the
/// concept's spike results) that a user meets once per install, not per start.
fn cold_starts(host: &PluginHost, plugin: &InstalledPlugin, n: usize) -> Vec<Duration> {
    let first = Instant::now();
    host.load(plugin).expect("load out of process");
    host.unload(&plugin.manifest.id);
    println!(
        "first start of the fresh runner binary {:?} (not measured)",
        first.elapsed()
    );
    let mut samples: Vec<Duration> = (0..n)
        .map(|_| {
            let start = Instant::now();
            host.load(plugin).expect("load out of process");
            let took = start.elapsed();
            host.unload(&plugin.manifest.id);
            took
        })
        .collect();
    samples.sort();
    samples
}

fn runner_pid(host: &PluginHost, id: &str) -> u32 {
    host.sandboxed_plugin(id)
        .and_then(|h| h.running())
        .and_then(|p| p.pid())
        .expect("runner pid")
}

/// Per-session MB/s of [`FAIR_SESSIONS`] sessions pumping at once through one
/// runner; `None` for a session that starved.
async fn fairness(registry: &Registry, type_id: &str) -> Vec<Option<f64>> {
    let mut sessions = Vec::with_capacity(FAIR_SESSIONS);
    for _ in 0..FAIR_SESSIONS {
        sessions.push(session(registry, type_id).await);
    }
    let start = Arc::new(Barrier::new(FAIR_SESSIONS));
    let pumps: Vec<_> = sessions
        .into_iter()
        .map(|(conn, rx)| {
            let start = Arc::clone(&start);
            tokio::spawn(async move {
                tokio::time::timeout(
                    STARVATION_TIMEOUT,
                    pump(conn, rx, FAIR_CHUNK, FAIR_PER_SESSION, start),
                )
                .await
                .ok()
                .flatten()
            })
        })
        .collect();
    let mut rates = Vec::with_capacity(FAIR_SESSIONS);
    for pump in pumps {
        rates.push(pump.await.unwrap());
    }
    rates
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "performance gate; run optimised with --ignored --nocapture (nightly lane)"]
async fn out_of_process_echo_stays_within_the_budget() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let id = echo.plugin.manifest.id.clone();

    let (in_host, in_registry) = host_for(&echo);
    let warm = Instant::now();
    in_host.load(&echo.plugin).unwrap();
    println!(
        "in-process load (trust + digest + dlopen + init) {:?}",
        warm.elapsed()
    );
    let (conn, rx) = session(&in_registry, &echo.type_id).await;
    let inproc = measure(conn, rx).await;
    in_host.unload(&id);

    let (out_host, out_registry) = host_for(&echo);
    // The fairness run echoes 2.5 GiB within seconds, past the default output
    // cap's 1 GiB burst; a terminal never does. Widen the burst so the run
    // measures sharing, not the cap (whose own behaviour `peer_tests` covers).
    let cap = OutputRateCap {
        burst_bytes: 4 * 1024 * 1024 * 1024,
        ..OutputRateCap::default()
    };
    let out_host = out_host.with_runner(Some(
        PluginRunnerConfig::new(runner_binary()).with_output_rate_cap(cap),
    ));
    let starts = cold_starts(&out_host, &echo.plugin, COLD_START_SAMPLES);
    let cold_p50 = percentile(&starts, 50);
    let cold_p95 = percentile(&starts, 95);
    println!(
        "runner cold start (spawn + handshake + dlopen + init) p50 {cold_p50:?} p95 {cold_p95:?}"
    );

    out_host.load(&echo.plugin).unwrap();
    // A respawn after a crash: kill the runner, then time until the first new
    // session is up (the host respawns on demand or eagerly; either counts).
    let handle = out_host
        .sandboxed_plugin(&id)
        .expect("loaded out of process");
    let crashed = runner_pid(&out_host, &id);
    let respawn = Instant::now();
    kill_process(crashed);
    assert!(wait_until(Duration::from_secs(5), || handle
        .running()
        .and_then(|p| p.pid())
        != Some(crashed)));
    drop(session(&out_registry, &echo.type_id).await);
    println!(
        "runner respawn after a crash + first session {:?}",
        respawn.elapsed()
    );
    // Idle: loaded, its only session closed, nothing in flight.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let idle_rss = rss_kib(runner_pid(&out_host, &id));
    println!("runner idle RSS {idle_rss:?} KiB");

    let (conn, rx) = session(&out_registry, &echo.type_id).await;
    let sandboxed = measure(conn, rx).await;
    let rates = fairness(&out_registry, &echo.type_id).await;
    out_host.unload(&id);

    let added_p99 = sandboxed.p99.saturating_sub(inproc.p99);
    let ratio = sandboxed.mb_per_s / inproc.mb_per_s;
    println!(
        "echo latency  in-process p50 {:?} p99 {:?} | runner p50 {:?} p99 {:?} | p99 added {:?}",
        inproc.p50, inproc.p99, sandboxed.p50, sandboxed.p99, added_p99
    );
    println!(
        "throughput    in-process {:.0} MB/s | runner {:.0} MB/s | ratio {:.0} % (reported only)",
        inproc.mb_per_s,
        sandboxed.mb_per_s,
        ratio * 100.0
    );
    let finished: Vec<f64> = rates.iter().flatten().copied().collect();
    let starved = rates.len() - finished.len();
    let slowest = finished.iter().copied().fold(f64::INFINITY, f64::min);
    let fastest = finished.iter().copied().fold(0.0, f64::max);
    let spread = fastest / slowest;
    println!(
        "{FAIR_SESSIONS} sessions  slowest {slowest:.0} MB/s | fastest {fastest:.0} MB/s | \
         spread {spread:.2}x | starved {starved}"
    );

    write_report(&serde_json::json!({
        "latency_p99_added_us": added_p99.as_micros() as u64,
        "latency_p99_runner_us": sandboxed.p99.as_micros() as u64,
        "throughput_mb_per_s": sandboxed.mb_per_s.round(),
        "throughput_ratio_pct": (ratio * 100.0).round(),
        "cold_start_p95_ms": cold_p95.as_secs_f64() * 1000.0,
        "idle_rss_kib": idle_rss,
        "fair_sessions": FAIR_SESSIONS,
        "fair_spread": spread,
        "fair_starved": starved,
        "release": !cfg!(debug_assertions),
    }));

    if cfg!(debug_assertions) {
        println!("(debug build: numbers are indicative only; budgets not asserted)");
        return;
    }
    let mut breaches = Vec::new();
    if added_p99 > BUDGET_ADDED_P99 {
        breaches.push(format!(
            "p99 latency added {added_p99:?} > {BUDGET_ADDED_P99:?}"
        ));
    }
    if sandboxed.mb_per_s < BUDGET_MB_PER_S {
        breaches.push(format!(
            "throughput {:.0} MB/s < {BUDGET_MB_PER_S} MB/s",
            sandboxed.mb_per_s
        ));
    }
    if cold_p95 > BUDGET_COLD_START_P95 {
        breaches.push(format!(
            "cold start p95 {cold_p95:?} > {BUDGET_COLD_START_P95:?}"
        ));
    }
    match idle_rss {
        Some(kib) if kib > BUDGET_IDLE_RSS_KIB => {
            breaches.push(format!("idle RSS {kib} KiB > {BUDGET_IDLE_RSS_KIB} KiB"));
        }
        Some(_) => {}
        None => breaches.push("idle RSS could not be measured".to_owned()),
    }
    if starved > 0 {
        breaches.push(format!(
            "{starved} of {FAIR_SESSIONS} sessions starved (> {STARVATION_TIMEOUT:?})"
        ));
    } else if spread > BUDGET_FAIRNESS {
        breaches.push(format!("fairness spread {spread:.2}x > {BUDGET_FAIRNESS}x"));
    }
    assert!(
        breaches.is_empty(),
        "plugin sandbox performance budget breached:\n  {}",
        breaches.join("\n  ")
    );
}

/// Write the numbers to `$TERMIHUB_PERF_REPORT` when set (the nightly lane
/// uploads it and shows it in the job summary).
fn write_report(report: &serde_json::Value) {
    if let Some(path) = std::env::var_os("TERMIHUB_PERF_REPORT") {
        let text = serde_json::to_string_pretty(report).expect("serialise the report");
        std::fs::write(&path, text).expect("write TERMIHUB_PERF_REPORT");
    }
}
