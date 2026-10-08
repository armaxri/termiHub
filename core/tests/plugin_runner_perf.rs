//! Performance gate of the out-of-process plugin host (#4182, #4190), measured
//! with the real `echo-backend` example plugin against the concept's budget
//! ("Performance budget" in `docs/concepts/implemented/plugin-os-sandbox.html`):
//!
//! | Metric                          | Budget                                  |
//! | ------------------------------- | --------------------------------------- |
//! | keystroke-to-echo latency       | p99 added ≤ 0.5 ms (10 000 samples)     |
//! | output throughput, one session  | ≥ 100 MB/s absolute (256 MiB)           |
//! | 40 concurrent sessions          | every session completes; fairness ≤ 2×  |
//! | helper cold start               | ≤ 150 ms p95 (spawn + handshake + init) |
//! | idle helper memory              | ≤ 15 MiB RSS                            |
//!
//! The fairness spread and starvation are asserted on every OS, the 3-vCPU
//! macOS runner included: the spread there was 21-91x until the channel lock
//! queued senders before they leave the CPU (#4260, see
//! `termihub_plugin_runner::ipc::FairMutex`).
//!
//! Every budget breach is collected and reported together, then fails the
//! test, so one nightly run names every regression. The budgets are absolute
//! ceilings rather than "within 20 % of the last run": a hosted CI runner
//! varies far more than 20 % from run to run, so a stored baseline would either
//! flap or be loose enough to say nothing.
//!
//! **The in-process baseline.** "p99 added" is the runner's p99 minus the p99
//! of the same echo plugin called directly in this test process. termiHub has
//! no in-process plugin path any more (ADR-19), so the baseline is built here,
//! test-only: [`DirectEcho`] opens the plugin with the runner's own loader
//! ([`termihub_plugin_runner::loader`], the gates the runner applies), hands it
//! a deny-all bridge, and relays its output through a forwarding thread onto a
//! tokio channel — the shape the removed in-process host had, so the budget
//! keeps measuring what the process boundary adds, against the same baseline
//! as before the cut-over (#4189). A fixed baseline number was rejected: it
//! would not track the machine the gate runs on.
//!
//! Throughput has no relative budget: the in-process baseline of the echo
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

use std::ffi::c_void;
use std::path::Path;
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

mod plugin_runner_support;
use plugin_runner_support::{
    echo_backend_library, host_for, install_echo, kill_process, new_connection, rss_kib,
    runner_binary, wait_until,
};

use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};
use termihub_core::output::OUTPUT_CHANNEL_CAPACITY;
use termihub_core::plugin::sandbox::PluginRunnerConfig;
use termihub_core::plugin::{BackendLoadOptions, InstalledPlugin, PluginHost};

use termihub_plugin_api::{
    FfiByteSlice, FfiOwnedBytes, FfiStr, LoadedBackend, PluginFileMetadata, PluginHostBridge,
    PluginHostBridgeVTable, PluginOutputSender, PluginStatus, PluginTcpStream, PluginWriteMode,
};
use termihub_plugin_runner::loader::{load_plugin_library, PluginLibrary};

const LATENCY_SAMPLES: usize = 10_000;
const THROUGHPUT_CHUNK: usize = 64 * 1024;
const THROUGHPUT_TOTAL: usize = 256 * 1024 * 1024;
const COLD_START_SAMPLES: usize = 40;
const FAIR_SESSIONS: usize = 40;
const FAIR_CHUNK: usize = 16 * 1024;
const FAIR_PER_SESSION: usize = 8 * 1024 * 1024;

/// The budget table (see the module docs).
const BUDGET_ADDED_P99: Duration = Duration::from_micros(500);
const BUDGET_MB_PER_S: f64 = 100.0;
const BUDGET_COLD_START_P95: Duration = Duration::from_millis(150);
const BUDGET_IDLE_RSS_KIB: u64 = 15 * 1024;
const BUDGET_FAIRNESS: f64 = 2.0;
/// A session of the 40 that has not finished by then is starved.
const STARVATION_TIMEOUT: Duration = Duration::from_secs(60);

/// Terminal input into one echo session. A runner session is a
/// `ConnectionType`, which is `Send` but not `Sync`, so it sits behind an
/// (uncontended) mutex the throughput pump also writes through.
type Shared = Arc<dyn Fn(&[u8]) + Send + Sync>;
type Registry = Arc<Mutex<ConnectionTypeRegistry>>;

// --- The test-only in-process baseline (see the module docs) ---------------

/// The echo plugin called directly in this process: the baseline "p99 added"
/// is measured against. Field order is drop order — the backend is destroyed
/// while the library is still mapped.
struct DirectEcho {
    backend: Mutex<LoadedBackend>,
    _library: PluginLibrary,
}

/// Every bridge call is refused: the echo plugin never makes one.
unsafe extern "C" fn deny_connect(
    _: *mut c_void,
    _: FfiStr,
    _: u16,
    _: *mut PluginTcpStream,
) -> PluginStatus {
    PluginStatus::PermissionDenied
}
unsafe extern "C" fn deny_read(_: *mut c_void, _: FfiStr, _: *mut FfiOwnedBytes) -> PluginStatus {
    PluginStatus::PermissionDenied
}
unsafe extern "C" fn deny_write(
    _: *mut c_void,
    _: FfiStr,
    _: FfiByteSlice,
    _: PluginWriteMode,
) -> PluginStatus {
    PluginStatus::PermissionDenied
}
unsafe extern "C" fn deny_stat(
    _: *mut c_void,
    _: FfiStr,
    _: *mut PluginFileMetadata,
) -> PluginStatus {
    PluginStatus::PermissionDenied
}
static DENY_ALL: PluginHostBridgeVTable = PluginHostBridgeVTable {
    open_connection: deny_connect,
    read_file: deny_read,
    write_file: deny_write,
    stat_path: deny_stat,
    list_dir: deny_read,
};

impl DirectEcho {
    /// Load the echo library at `path` with the runner's loader and open one
    /// session whose output is relayed onto a tokio channel by a forwarding
    /// thread.
    fn open(path: &Path) -> (Arc<Self>, OutputReceiver) {
        let library =
            load_plugin_library(path, &BackendLoadOptions::default()).expect("direct load");
        let (std_tx, std_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        std::thread::spawn(move || {
            while let Ok(chunk) = std_rx.recv() {
                if tx.blocking_send(chunk).is_err() {
                    break;
                }
            }
        });
        // SAFETY: the null context is never dereferenced, every callback in
        // `DENY_ALL` ignores it, and there is no destructor to run.
        let bridge = unsafe { PluginHostBridge::from_raw(std::ptr::null_mut(), &DENY_ALL, None) };
        let backend = library
            .create_backend_with_context(
                r#"{"echoPrefix":""}"#,
                "{}",
                PluginOutputSender::from_sender(std_tx),
                bridge,
                None,
            )
            .expect("direct session");
        let echo = Arc::new(Self {
            backend: Mutex::new(backend),
            _library: library,
        });
        (echo, rx)
    }
}

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
    let conn = Mutex::new(conn);
    let write: Shared = Arc::new(move |data: &[u8]| conn.lock().unwrap().write(data).unwrap());
    (write, rx)
}

fn percentile(sorted: &[Duration], pct: usize) -> Duration {
    sorted[(sorted.len() * pct / 100).min(sorted.len() - 1)]
}

async fn measure(conn: Shared, mut rx: OutputReceiver) -> Measured {
    // Warm up.
    for _ in 0..200 {
        conn(b"w");
        rx.recv().await.unwrap();
    }
    let mut samples = Vec::with_capacity(LATENCY_SAMPLES);
    for _ in 0..LATENCY_SAMPLES {
        let start = Instant::now();
        conn(b"x");
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
            conn(&data);
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

    let warm = Instant::now();
    let (direct, rx) = DirectEcho::open(&echo_backend_library(work.path()));
    println!(
        "in-process baseline load (test-only direct dlopen + init + session) {:?}",
        warm.elapsed()
    );
    let baseline = Arc::clone(&direct);
    let write: Shared = Arc::new(move |data: &[u8]| {
        baseline.backend.lock().unwrap().write_input(data).unwrap();
    });
    let inproc = measure(write, rx).await;
    drop(direct);

    let (out_host, out_registry) = host_for(&echo);
    let out_host = out_host.with_runner(PluginRunnerConfig::new(runner_binary()));
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
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
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
        "cores": cores,
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
