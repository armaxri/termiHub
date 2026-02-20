# Phase 6: Monitoring

**Status: Implemented**

---

## Summary

Add system monitoring to the agent — CPU, memory, disk, and network stats for the agent's own host and for jump host targets. The agent collects data locally (reading `/proc/*`, running `df`, etc.) or remotely (SSH exec on jump targets), parses it, and streams results to the desktop as periodic notifications.

## Architecture

```
Desktop                   Agent Host                 Jump Target
┌─────────────┐          ┌─────────────┐            ┌──────────┐
│ Monitoring  │◄─────────│ Agent       │────SSH────►│ Target   │
│ Panel       │ periodic │ - Parse     │  exec cmds │ - top    │
│ (charts)    │ notifs   │ - Calculate │  (cat      │ - free   │
└─────────────┘          └─────────────┘  /proc/*)  │ - df     │
                                                     └──────────┘
```

- **Local host monitoring**: Read `/proc/stat`, `/proc/meminfo`, `df`, `/proc/net/dev` directly
- **Jump target monitoring**: Run commands over SSH, parse output
- **macOS support**: Use `sysctl`, `vm_stat`, `df` instead of `/proc`

## Protocol Methods

```
monitoring.subscribe   {host: "self" | connection_id, interval_ms: 2000}
monitoring.unsubscribe {host: "self" | connection_id}
```

## Notifications

```
monitoring.data {
    host: "self" | connection_id,
    cpu_percent: 78.5,
    memory_used_bytes: 4294967296,
    memory_total_bytes: 8589934592,
    disk: [{ mount: "/", used_bytes: ..., total_bytes: ... }],
    network: { rx_bytes_per_sec: 12000, tx_bytes_per_sec: 3000 }
}
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `agent/src/monitoring/mod.rs` | New | Monitoring module |
| `agent/src/monitoring/collector.rs` | New | Data collection (local + remote) |
| `agent/src/monitoring/parser.rs` | New | Parse system command output |
| `agent/src/protocol/methods.rs` | Edit | Add monitoring method types |
| `agent/src/handler/dispatch.rs` | Edit | Wire monitoring handlers |

## Dependencies

- Phase 3 (SSH) for monitoring jump targets via SSH exec
- Desktop monitoring UI (already exists for direct SSH — needs adaptation for agent RPC)
