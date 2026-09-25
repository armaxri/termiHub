# Performance audit — summary

Static analysis (no profiling) of termiHub's highest-frequency and largest-data paths:
terminal output, projection/IPC event volume, monitoring pollers, transfer progress, large
file/directory handling, and bundle/startup. Method: trace each hot path end-to-end and
reason about work-per-event × event-rate, plus memory bounds.

**Headline:** the two paths the audit brief called "strong" hold up. The terminal-output
hot path is genuinely well-engineered — base64 IPC (not JSON number arrays, #2072), a 32 KB
opportunistic coalescer, an O(1) singleton dispatcher, RAF-batched merged xterm writes,
WebGL rendering, and deduped resize. The core `RingBuffer` and `OutputCoalescer` data
structures are sound. **The real costs are elsewhere**, as expected: the file editor's
large-data path, the projection substrate's per-update serialization/cloning, bundle/startup
cost, and background pollers that run unobserved.

## Hot paths mapped (cost read)

| Path | Frequency | Cost read |
| --- | --- | --- |
| PTY read → coalesce → `emit("terminal-output")` → dispatcher → RAF → xterm | per output batch (≤32 KB) | **Good.** base64 wire, batched, O(1) route. Two nits: global broadcast to all windows (PERF-004); double byte-copy per read (PERF-012). |
| Projection diff: fold → `store.snapshot()` → `json_patch::diff` → emit → `applyPatch` → view rebuild → re-render | per state change (2s/monitor sample; 100ms/transfer) | **Weak.** Backend re-serializes the *whole region* per sample → O(N²) (PERF-006); frontend *deep-clones the whole region* per diff (PERF-005); many samples are serialized *twice* via a legacy dual-write (PERF-007). Wire diffs themselves are minimal — good. |
| Monitoring pollers (CPU/mem/disk, SSH/agent) | 2s default, 500ms floor | **Good.** Proper `tokio::interval`, no busy loops. Minor: paused SSH monitor wakes every 200ms. |
| HTTP monitors | ≥1s, per saved monitor | **Weak.** Auto-started at launch for every saved monitor, polls with no subscribers, forever (PERF-008). |
| Transfer progress (SFTP/FTP) | 100ms-throttled | **Good** throttle; but dual-write serializes each sample twice (PERF-007). |
| File editor open/save | on demand | **Weak.** Whole file in memory, no size guard; remote bytes cross IPC as `number[]` (PERF-002). |
| Directory listing (FileBrowser) | on nav | **Good.** react-virtual windowing; sort O(n log n) + filter O(n), both memoized. |
| Cold start / bundle | once | **Weak.** Monaco + shiki eagerly bundled via always-mounted SplitView (PERF-001); no `manualChunks`, monolithic entry chunk (PERF-003). |

## Systemic issues (ranked)

1. **Projection substrate does whole-region work per update, on both ends.** Backend
   snapshots + structurally diffs the entire region on every fold (PERF-006, O(N²) in entry
   count); frontend deep-clones the entire region view on every diff (PERF-005, O(view) per
   update). Individually mild, together they mean each monitor stats sample / transfer tick
   pays for the size of the *whole* region, not the change. This is the highest-leverage
   systemic fix (incremental serialize + structural-sharing patch).
2. **Editor / large-file path is unbounded and uses number-array IPC.** No size guard +
   `number[]` byte transport = multi-× memory and IPC blowup, worst case an OOM/freeze on a
   large file (PERF-002). The same `number[]` transport affects scrollback replay (PERF-009)
   and plugin file reads.
3. **Bundle/startup carries the whole feature set eagerly.** Monaco+shiki+all dialogs in one
   entry chunk inflates cold start for the common terminal-first launch (PERF-001, PERF-003).
4. **Background work runs unobserved.** HTTP monitors poll from launch regardless of UI
   (PERF-008); legacy dual-write emits duplicate every hot-path sample (PERF-007).

## Top opportunities (ranked by impact/effort)

1. **PERF-002** — add a file-size guard to the editor and switch remote file bytes off
   `number[]` (base64/binary). Bounds worst-case memory; small change. *(high)*
2. **PERF-001 / PERF-003** — lazy-load Monaco/shiki and add `manualChunks`. Direct cold-start
   win on the common path; well-trodden change. *(high / medium)*
3. **PERF-005 + PERF-006** — make projection updates incremental (structural-sharing patch
   apply on the client; per-entry serialize/diff on the server). Removes O(view)/O(N²) work
   from every sample. *(medium, higher effort but systemic)*
4. **PERF-007** — retire the legacy `emit` dual-writes now that regions are authoritative.
   Halves serialization + IPC on the monitoring/transfer paths; mostly deletion. *(medium)*
5. **PERF-008** — gate HTTP-monitor polling on subscription / make background monitoring
   explicit. Removes steady idle CPU/network. *(medium)*

## Findings index

| ID | Sev | Title |
| --- | --- | --- |
| PERF-001 | high | Monaco + shiki eagerly bundled into main chunk via always-mounted SplitView |
| PERF-002 | high | FileEditor loads whole files with no size guard; remote files cross IPC as `number[]` |
| PERF-003 | medium | No code-splitting — monolithic entry bundle, all dialogs/tools eager |
| PERF-004 | medium | Terminal output emitted as a global broadcast to every window |
| PERF-005 | medium | Every projection diff deep-clones the entire region view (frontend) |
| PERF-006 | medium | Every projection publish re-serializes the entire region → O(N²) (backend) |
| PERF-007 | medium | Stats/status/transfer serialized twice (legacy emit + projection) — *workaround* |
| PERF-008 | medium | HTTP monitors poll continuously with no subscribers, auto-started at launch |
| PERF-009 | medium | Scrollback-replay / agent-buffer IPC ships up to 1 MiB as JSON `number[]` |
| PERF-010 | low | `OutputCoalescer::try_coalesce` is dead code with an O(n²) remainder copy — *workaround* |
| PERF-011 | low | DOM-renderer terminals force a full-viewport repaint after every flush — *workaround* |
| PERF-012 | low | Output reader copies each 4 KB PTY read at least twice before emit |

## Notes / non-findings (checked, healthy)
- Terminal output IPC encoding is base64, not number-array (#2072) — optimal for JSON IPC.
- Frontend output write path is RAF-batched, merged into one xterm write, WebGL-rendered,
  resize-deduped, and pre-subscribe buffered with a 256 KB cap (no unbounded growth).
- Directory listing is virtualized (react-virtual); sort/filter are O(n log n)/O(n), memoized.
- Monitoring pollers use proper `tokio::interval`; no busy-poll loops found in production.
- Transfer progress is 100 ms-throttled (not per-chunk).
- Projection *wire* frames are minimal RFC-6902 diffs; a no-op publish emits nothing.
</content>
