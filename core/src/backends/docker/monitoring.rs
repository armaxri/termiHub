//! Docker container monitoring (#3182).
//!
//! A container is Linux with `/proc`, so its system stats are gathered exactly
//! like the SSH backend's — running the canonical
//! [`MONITORING_COMMAND`](crate::monitoring::MONITORING_COMMAND) and feeding the
//! output through the shared [`parse_stats`](crate::monitoring::parse_stats)
//! parser. The only Docker-specific part is *how* the command runs: a single
//! `docker exec` via bollard, reading `/proc/stat`, `/proc/meminfo`,
//! `/proc/net/dev`, etc. in one round-trip. Everything else — the collect loop,
//! the CPU/network delta trackers, the observable lifecycle — is provided by the
//! shared [`ExecMonitoringProvider`](crate::monitoring::ExecMonitoringProvider).
//!
//! Distroless / minimal images have no shell or `/proc` to exec against, so the
//! provider is also given a [`ContainerStatsSource`] backed by the Docker Engine
//! stats API (`docker stats`, via bollard) as a fallback (#3202). The mapping
//! from bollard's payload to the engine-neutral sample lives in
//! [`sample_from_docker_stats`].

use std::sync::Arc;

use bollard::container::{MemoryStatsStats, Stats, StatsOptions};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;

use crate::errors::CoreError;
use crate::monitoring::{
    BlockIoCounters, ContainerCpuCounters, ContainerStatsSample, ContainerStatsSource,
    ExecMonitoringProvider, NetCounters, ProcStatsSource, MONITORING_COMMAND,
};

/// A [`ProcStatsSource`] that runs the monitoring command inside a Docker
/// container via `docker exec`.
struct DockerProcStatsSource {
    client: bollard::Docker,
    container_id: String,
}

#[async_trait::async_trait]
impl ProcStatsSource for DockerProcStatsSource {
    async fn collect_proc(&self) -> Result<String, CoreError> {
        exec_monitoring_command(&self.client, &self.container_id).await
    }
}

/// A [`ContainerStatsSource`] reading the Docker Engine stats API (#3202).
struct DockerEngineStatsSource {
    client: bollard::Docker,
    container_id: String,
}

#[async_trait::async_trait]
impl ContainerStatsSource for DockerEngineStatsSource {
    async fn collect_container_stats(&self) -> Result<ContainerStatsSample, CoreError> {
        // `one_shot` returns immediately instead of waiting ~1 s for the engine
        // to fill `precpu_stats`: the provider diffs consecutive samples itself.
        let options = StatsOptions {
            stream: false,
            one_shot: true,
        };
        let stats = self
            .client
            .stats(&self.container_id, Some(options))
            .next()
            .await
            .ok_or_else(|| CoreError::Other("docker stats returned no sample".to_string()))?
            .map_err(|e| CoreError::Other(format!("docker stats failed: {e}")))?;
        Ok(sample_from_docker_stats(&stats))
    }
}

/// Build the Docker monitoring provider for a connected container.
///
/// Called from [`Docker::connect`](super::Docker) with a clone of the live
/// bollard client and the container id, mirroring how the file browser is wired.
/// `/proc` via `docker exec` is primary; the Docker stats API is the fallback for
/// containers without a shell or readable `/proc` (#3202).
pub(super) fn docker_monitoring_provider(
    client: bollard::Docker,
    container_id: String,
) -> ExecMonitoringProvider {
    let fallback = Arc::new(DockerEngineStatsSource {
        client: client.clone(),
        container_id: container_id.clone(),
    });
    ExecMonitoringProvider::new(Arc::new(DockerProcStatsSource {
        client,
        container_id,
    }))
    .with_stats_fallback(fallback)
}

/// Map one Docker stats payload into an engine-neutral [`ContainerStatsSample`].
///
/// Memory "used" follows the Docker CLI: raw cgroup usage minus reclaimable
/// inactive page cache (`total_inactive_file` on cgroup v1, `inactive_file` on
/// v2). Any counter the engine left out stays `None`, so the metric is shown as
/// unavailable rather than as a fabricated zero.
pub(super) fn sample_from_docker_stats(stats: &Stats) -> ContainerStatsSample {
    let cpu = stats
        .cpu_stats
        .system_cpu_usage
        .map(|system_ns| ContainerCpuCounters {
            container_ns: stats.cpu_stats.cpu_usage.total_usage,
            system_ns,
        });

    let memory = &stats.memory_stats;
    let memory_used_bytes = memory.usage.map(|usage| {
        let inactive_file = match memory.stats {
            Some(MemoryStatsStats::V1(v1)) => v1.total_inactive_file,
            Some(MemoryStatsStats::V2(v2)) => v2.inactive_file,
            None => 0,
        };
        if inactive_file < usage {
            usage - inactive_file
        } else {
            usage
        }
    });

    let net = stats.networks.as_ref().map(|networks| {
        networks
            .values()
            .fold(NetCounters::default(), |acc, n| NetCounters {
                rx_bytes: acc.rx_bytes.saturating_add(n.rx_bytes),
                tx_bytes: acc.tx_bytes.saturating_add(n.tx_bytes),
            })
    });

    let block_io = stats
        .blkio_stats
        .io_service_bytes_recursive
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .fold(BlockIoCounters::default(), |mut acc, e| {
                    // cgroup v1 reports "Read"/"Write", v2 "read"/"write".
                    if e.op.eq_ignore_ascii_case("read") {
                        acc.read_bytes = acc.read_bytes.saturating_add(e.value);
                    } else if e.op.eq_ignore_ascii_case("write") {
                        acc.write_bytes = acc.write_bytes.saturating_add(e.value);
                    }
                    acc
                })
        });

    ContainerStatsSample {
        name: stats.name.trim_start_matches('/').to_string(),
        cpu,
        memory_used_bytes,
        memory_limit_bytes: memory.limit,
        net,
        block_io,
        pids: stats.pids_stats.current,
    }
}

/// Run [`MONITORING_COMMAND`] inside the container in a single exec and return
/// its raw stdout.
///
/// The command is wrapped in `sh -c` so the whole compound pipeline (which
/// `export`s a C locale itself) runs in one shell. As with the SSH exec, the
/// process exit status is intentionally ignored: [`parse_stats`] tolerates a
/// missing trailing leg (e.g. a container without `/proc/net/dev`), so returning
/// whatever stdout was produced yields more metrics than failing the collect on
/// a non-zero exit. A container with no shell / no readable `/proc` (distroless)
/// produces stdout the parser rejects, which the provider surfaces honestly as a
/// failed connect — never fabricated data.
async fn exec_monitoring_command(
    client: &bollard::Docker,
    container_id: &str,
) -> Result<String, CoreError> {
    let exec_config = CreateExecOptions {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(vec!["sh", "-c", MONITORING_COMMAND]),
        ..Default::default()
    };

    let exec = client
        .create_exec(container_id, exec_config)
        .await
        .map_err(|e| CoreError::Other(format!("failed to create monitoring exec: {e}")))?;

    let start_config = StartExecOptions {
        detach: false,
        ..Default::default()
    };

    let result = client
        .start_exec(&exec.id, Some(start_config))
        .await
        .map_err(|e| CoreError::Other(format!("failed to start monitoring exec: {e}")))?;

    match result {
        StartExecResults::Attached { mut output, .. } => {
            let mut stdout = Vec::new();
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout.extend_from_slice(&message);
                    }
                    // stderr is ignored — the parser reads stdout, and a partial
                    // leg's diagnostic on stderr must not fail the whole collect.
                    Ok(_) => {}
                    Err(e) => {
                        return Err(CoreError::Other(format!(
                            "monitoring exec output error: {e}"
                        )));
                    }
                }
            }
            Ok(String::from_utf8_lossy(&stdout).to_string())
        }
        StartExecResults::Detached => Err(CoreError::Other(
            "monitoring exec started in detached mode".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map, Value};

    /// Every cgroup v1 memory-stat key bollard requires, all zero.
    const V1_KEYS: [&str; 34] = [
        "cache",
        "dirty",
        "mapped_file",
        "total_inactive_file",
        "pgpgout",
        "rss",
        "total_mapped_file",
        "writeback",
        "unevictable",
        "pgpgin",
        "total_unevictable",
        "pgmajfault",
        "total_rss",
        "total_rss_huge",
        "total_writeback",
        "total_inactive_anon",
        "rss_huge",
        "hierarchical_memory_limit",
        "total_pgfault",
        "total_active_file",
        "active_anon",
        "total_active_anon",
        "total_pgpgout",
        "total_cache",
        "total_dirty",
        "inactive_anon",
        "active_file",
        "pgfault",
        "inactive_file",
        "total_pgmajfault",
        "total_pgpgin",
        "hierarchical_memsw_limit",
        "shmem",
        "total_shmem",
    ];

    /// Every cgroup v2 memory-stat key bollard requires, all zero.
    const V2_KEYS: [&str; 31] = [
        "anon",
        "file",
        "kernel_stack",
        "slab",
        "sock",
        "shmem",
        "file_mapped",
        "file_dirty",
        "file_writeback",
        "anon_thp",
        "inactive_anon",
        "active_anon",
        "inactive_file",
        "active_file",
        "unevictable",
        "slab_reclaimable",
        "slab_unreclaimable",
        "pgfault",
        "pgmajfault",
        "workingset_refault",
        "workingset_activate",
        "workingset_nodereclaim",
        "pgrefill",
        "pgscan",
        "pgsteal",
        "pgactivate",
        "pgdeactivate",
        "pglazyfree",
        "pglazyfreed",
        "thp_fault_alloc",
        "thp_collapse_alloc",
    ];

    fn memory_stats(keys: &[&str], overrides: &[(&str, u64)]) -> Value {
        let mut map: Map<String, Value> = keys.iter().map(|k| (k.to_string(), json!(0))).collect();
        for (k, v) in overrides {
            map.insert(k.to_string(), json!(v));
        }
        Value::Object(map)
    }

    fn cpu_stats(total: u64, system: Option<u64>) -> Value {
        json!({
            "cpu_usage": { "total_usage": total, "usage_in_kernelmode": 0, "usage_in_usermode": 0 },
            "system_cpu_usage": system,
            "online_cpus": 10,
            "throttling_data": { "periods": 0, "throttled_periods": 0, "throttled_time": 0 }
        })
    }

    /// A Docker stats payload as the engine returns it (one-shot: empty precpu).
    fn payload(memory: Value, networks: Value, blkio: Value, system: Option<u64>) -> Stats {
        serde_json::from_value(json!({
            "read": "2026-09-29T14:48:19.871146751Z",
            "preread": "0001-01-01T00:00:00Z",
            "id": "6ea179cb5fc6",
            "name": "/distroless-app",
            "num_procs": 0,
            "pids_stats": { "current": 3, "limit": 18446744073709551615u64 },
            "networks": networks,
            "memory_stats": memory,
            "blkio_stats": { "io_service_bytes_recursive": blkio },
            "cpu_stats": cpu_stats(18_170_000, system),
            "precpu_stats": cpu_stats(0, None),
            "storage_stats": {}
        }))
        .expect("fixture deserializes into bollard Stats")
    }

    #[test]
    fn cgroup_v2_payload_maps_cpu_memory_network_block_io_and_pids() {
        let stats = payload(
            json!({
                "usage": 2_203_648u64,
                "limit": 8_321_515_520u64,
                "stats": memory_stats(&V2_KEYS, &[("inactive_file", 65_536)])
            }),
            json!({
                "eth0": { "rx_bytes": 1698, "rx_packets": 17, "rx_errors": 0, "rx_dropped": 0,
                          "tx_bytes": 126, "tx_packets": 3, "tx_errors": 0, "tx_dropped": 0 },
                "eth1": { "rx_bytes": 2, "rx_packets": 1, "rx_errors": 0, "rx_dropped": 0,
                          "tx_bytes": 4, "tx_packets": 1, "tx_errors": 0, "tx_dropped": 0 }
            }),
            json!([
                { "major": 254, "minor": 0, "op": "read", "value": 1_323_008 },
                { "major": 254, "minor": 0, "op": "write", "value": 10 },
                { "major": 254, "minor": 16, "op": "read", "value": 135_168 },
                { "major": 254, "minor": 16, "op": "write", "value": 5 }
            ]),
            Some(3_050_400_000_000),
        );

        let sample = sample_from_docker_stats(&stats);
        assert_eq!(sample.name, "distroless-app");
        assert_eq!(
            sample.cpu,
            Some(ContainerCpuCounters {
                container_ns: 18_170_000,
                system_ns: 3_050_400_000_000,
            })
        );
        assert_eq!(sample.memory_used_bytes, Some(2_203_648 - 65_536));
        assert_eq!(sample.memory_limit_bytes, Some(8_321_515_520));
        assert_eq!(
            sample.net,
            Some(NetCounters {
                rx_bytes: 1700,
                tx_bytes: 130,
            })
        );
        assert_eq!(
            sample.block_io,
            Some(BlockIoCounters {
                read_bytes: 1_458_176,
                write_bytes: 15,
            })
        );
        assert_eq!(sample.pids, Some(3));
    }

    #[test]
    fn cgroup_v1_payload_subtracts_total_inactive_file() {
        let stats = payload(
            json!({
                "usage": 10_000u64,
                "limit": 100_000u64,
                "stats": memory_stats(&V1_KEYS, &[("total_inactive_file", 4_000), ("inactive_file", 1)])
            }),
            json!({}),
            json!([
                { "major": 8, "minor": 0, "op": "Read", "value": 300 },
                { "major": 8, "minor": 0, "op": "Write", "value": 200 },
                { "major": 8, "minor": 0, "op": "Total", "value": 500 }
            ]),
            Some(1_000),
        );

        let sample = sample_from_docker_stats(&stats);
        assert_eq!(sample.memory_used_bytes, Some(6_000));
        assert_eq!(sample.memory_limit_bytes, Some(100_000));
        assert_eq!(
            sample.block_io,
            Some(BlockIoCounters {
                read_bytes: 300,
                write_bytes: 200,
            })
        );
    }

    #[test]
    fn inactive_file_not_below_usage_keeps_raw_usage() {
        let stats = payload(
            json!({
                "usage": 1_000u64,
                "limit": 2_000u64,
                "stats": memory_stats(&V2_KEYS, &[("inactive_file", 5_000)])
            }),
            json!({}),
            Value::Null,
            Some(1),
        );
        assert_eq!(
            sample_from_docker_stats(&stats).memory_used_bytes,
            Some(1_000)
        );
    }

    #[test]
    fn missing_fields_stay_none() {
        // A stopped / network-less container: no usage, no limit, no networks,
        // no blkio entries, no host CPU counter, no pids.
        let mut stats = payload(json!({}), Value::Null, Value::Null, None);
        stats.pids_stats.current = None;

        let sample = sample_from_docker_stats(&stats);
        assert_eq!(sample.cpu, None);
        assert_eq!(sample.memory_used_bytes, None);
        assert_eq!(sample.memory_limit_bytes, None);
        assert_eq!(sample.net, None);
        assert_eq!(sample.block_io, None);
        assert_eq!(sample.pids, None);
    }
}
