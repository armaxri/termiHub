//! Tests for the exec provider's `/proc` → container-stats source selection
//! (#3202). A child module of `exec_provider`, so it reaches its private items.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::monitoring::{
    ContainerCpuCounters, ContainerStatsSample, MonitorStatus, NetCounters, StatsMetric,
    StatsSource,
};

/// A minimal parseable `MONITORING_COMMAND` output.
const PROC_SAMPLE: &str = "\
host
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000 80000 1000 0 200 0 0 0
MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0";

/// A `/proc` source answering `output` (or failing when `None`), counting calls.
struct ProcFake {
    output: Option<&'static str>,
    calls: AtomicUsize,
}

impl ProcFake {
    fn new(output: Option<&'static str>) -> Arc<Self> {
        Arc::new(Self {
            output,
            calls: AtomicUsize::new(0),
        })
    }
}

#[async_trait::async_trait]
impl ProcStatsSource for ProcFake {
    async fn collect_proc(&self) -> Result<String, CoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.output
            .map(str::to_string)
            .ok_or_else(|| CoreError::Other("exec: sh not found".into()))
    }
}

/// A container-stats source whose CPU counters advance on every call.
struct StatsFake {
    ok: bool,
    calls: AtomicUsize,
}

impl StatsFake {
    fn new(ok: bool) -> Arc<Self> {
        Arc::new(Self {
            ok,
            calls: AtomicUsize::new(0),
        })
    }
}

#[async_trait::async_trait]
impl ContainerStatsSource for StatsFake {
    async fn collect_container_stats(&self) -> Result<ContainerStatsSample, CoreError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) as u64;
        if !self.ok {
            return Err(CoreError::Other("docker stats failed".into()));
        }
        Ok(ContainerStatsSample {
            name: "distroless".to_string(),
            cpu: Some(ContainerCpuCounters {
                container_ns: n * 100,
                system_ns: n * 1_000,
            }),
            memory_used_bytes: Some(512 * 1024),
            memory_limit_bytes: Some(1024 * 1024),
            net: Some(NetCounters::default()),
            block_io: None,
            pids: Some(2),
        })
    }
}

fn provider(
    proc: Arc<ProcFake>,
    fallback: Option<Arc<StatsFake>>,
) -> ExecMonitoringProvider {
    let mut p = ExecMonitoringProvider::new(proc);
    if let Some(f) = fallback {
        p = p.with_stats_fallback(f);
    }
    p.interval = Duration::from_millis(20);
    p
}

async fn next_sample(rx: &mut MonitoringReceiver) -> SystemStats {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("a sample must arrive before timeout")
        .expect("stats channel should stay open")
}

#[tokio::test]
async fn proc_stays_primary_when_it_parses() {
    let stats = StatsFake::new(true);
    let selected = select_source(
        ProcFake::new(Some(PROC_SAMPLE)),
        Some(stats.clone()),
        Duration::from_secs(1),
    )
    .await
    .expect("proc source");
    assert!(matches!(selected, ActiveSource::Proc(_)));
    assert_eq!(stats.calls.load(Ordering::SeqCst), 0, "fallback not probed");
}

#[tokio::test]
async fn failing_proc_selects_the_stats_fallback() {
    let selected = select_source(
        ProcFake::new(None),
        Some(StatsFake::new(true)),
        Duration::from_secs(1),
    )
    .await
    .expect("fallback source");
    assert!(matches!(selected, ActiveSource::ContainerStats(_)));
}

#[tokio::test]
async fn unparseable_proc_selects_the_stats_fallback() {
    let selected = select_source(
        ProcFake::new(Some("OCI runtime exec failed")),
        Some(StatsFake::new(true)),
        Duration::from_secs(1),
    )
    .await
    .expect("fallback source");
    assert!(matches!(selected, ActiveSource::ContainerStats(_)));
}

#[tokio::test]
async fn both_sources_failing_is_an_honest_error_naming_both() {
    let err = select_source(
        ProcFake::new(None),
        Some(StatsFake::new(false)),
        Duration::from_secs(1),
    )
    .await
    .err()
    .expect("no usable source");
    let msg = err.to_string();
    assert!(msg.contains("sh not found"), "{msg}");
    assert!(msg.contains("fallback also failed"), "{msg}");
}

#[tokio::test]
async fn no_fallback_keeps_the_proc_error() {
    let err = select_source(ProcFake::new(None), None, Duration::from_secs(1))
        .await
        .err()
        .expect("no usable source");
    assert!(err.to_string().contains("sh not found"));
}

/// End to end: a distroless target streams Docker-stats-sourced samples that
/// go `Live`, derive CPU from the second sample, and list the metrics the stats
/// API cannot supply as unavailable.
#[tokio::test]
async fn distroless_target_streams_labelled_docker_stats_samples() {
    let proc = ProcFake::new(None);
    let p = provider(proc.clone(), Some(StatsFake::new(true)));
    let mut sub = p.subscribe().await.expect("fallback subscribe");

    let first = next_sample(&mut sub.stats).await;
    assert_eq!(first.source, StatsSource::DockerStats);
    assert_eq!(first.cpu_usage_percent, 0.0, "first sample primes CPU");
    assert!((first.memory_used_percent - 50.0).abs() < 1e-9);
    assert!(first.is_unavailable(StatsMetric::LoadAverage));
    assert!(first.is_unavailable(StatsMetric::Disk));
    assert!(first.is_unavailable(StatsMetric::Processes));
    assert_eq!(first.pids_current, Some(2));

    let second = next_sample(&mut sub.stats).await;
    assert!((second.cpu_usage_percent - 10.0).abs() < 1e-9);

    let status = tokio::time::timeout(Duration::from_secs(5), sub.status.recv())
        .await
        .expect("status")
        .expect("status channel");
    assert_eq!(status.status, MonitorStatus::Live);

    let proc_calls = proc.calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        proc.calls.load(Ordering::SeqCst),
        proc_calls,
        "the loop must not keep exec-ing /proc once on the fallback"
    );
    p.unsubscribe().await.expect("unsubscribe");
}

/// A `/proc`-capable target keeps the full `/proc` sample, tagged as such.
#[tokio::test]
async fn proc_target_samples_are_tagged_proc_with_nothing_unavailable() {
    let p = provider(ProcFake::new(Some(PROC_SAMPLE)), Some(StatsFake::new(true)));
    let mut sub = p.subscribe().await.expect("subscribe");
    let s = next_sample(&mut sub.stats).await;
    assert_eq!(s.source, StatsSource::Proc);
    assert!(s.unavailable_metrics.is_empty());
    assert_eq!(s.pids_current, None);
    p.unsubscribe().await.expect("unsubscribe");
}
