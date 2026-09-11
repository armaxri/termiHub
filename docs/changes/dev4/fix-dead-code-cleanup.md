### Internal

- Removed proven-dead Rust code flagged by the pre-release audit (PERF-010,
  DEAD-013 removable subset), with no change to runtime behaviour:
  - `OutputCoalescer::try_coalesce` and its dedicated unit tests — the method
    was never called by production code (the session output reader uses
    `push`/`pending_len`/`flush` only) and carried a latent O(n²) remainder
    copy (PERF-010). Its now-orphaned `max_batch_bytes` field and the
    corresponding `new()` parameter were removed as well; the coalescer's doc
    comment now states the real behaviour — `flush()` drains the whole pending
    buffer and never splits at a batch cap, so a single emit can exceed the
    nominal cap (the caller bounds accumulation via its own `MAX_COALESCE_BYTES`
    guard).
  - The never-constructed `TerminalError` variants `SerialError`, `TelnetError`,
    and `DockerError` (DEAD-013). The `ConnectionFailed` variant, flagged by the
    audit but in fact constructed in several command/session paths, was kept.
  - The write-only `agent_version` / `protocol_version` fields on the internal
    `AgentConnection` struct, which were stored at connect time but never read
    (DEAD-013). The `AgentRpcClient` trait, also flagged by the audit, was kept:
    it is live, consumed as `Arc<dyn AgentRpcClient>` across the command,
    session, network, tunnel, and embedded-server layers.
