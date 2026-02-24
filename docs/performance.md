# Performance Profiling Guide

## Overview

termiHub targets 40 concurrent terminal sessions. This guide covers how to profile the application, what metrics to capture, and how to detect regressions.

## Architecture Optimizations

### Singleton Event Dispatcher

The frontend uses a single global Tauri event listener per event type (`terminal-output`, `terminal-exit`) instead of per-terminal listeners. Events are routed to the correct terminal via O(1) `Map` lookup by `session_id`.

**Location**: `src/services/events.ts` — `TerminalOutputDispatcher` class

### Output Batching (requestAnimationFrame)

Terminal output chunks are buffered and flushed in a single `requestAnimationFrame` callback. This reduces the number of `xterm.write()` calls when multiple terminals produce output simultaneously.

**Location**: `src/components/Terminal/Terminal.tsx` — `setupTerminal()` function

### Backend Output Coalescing

The Rust backend coalesces pending output chunks (up to 32 KB) into a single Tauri event emission, reducing IPC overhead.

**Location**: `src-tauri/src/terminal/manager.rs` — `spawn_output_reader()` function

### Bounded Channels

Backend output channels use `sync_channel(64)` instead of unbounded channels, providing backpressure when a terminal produces output faster than the frontend can consume it.

**Location**: `src-tauri/src/terminal/backend.rs` — `OUTPUT_CHANNEL_CAPACITY`

## Profiling with Chrome DevTools

1. Start the app in development mode:

   ```bash
   pnpm tauri dev
   ```

2. Open Chrome DevTools by right-clicking in the app window and selecting **Inspect** (or pressing `F12` if enabled in Tauri config).

3. Use the following DevTools panels:

### Performance Panel

- Click **Record**, perform the action you want to profile (e.g., open 10 terminals), then **Stop**.
- Look for long tasks (>50ms) in the flame chart.
- Check for layout thrashing or excessive paint operations.

### Memory Panel

- Take a **Heap Snapshot** before and after creating terminals.
- Compare snapshots to find leaked objects.
- Use **Allocation instrumentation on timeline** to watch real-time allocations.

### Performance Monitor (real-time)

- Open via DevTools → More tools → Performance monitor.
- Watch **JS heap size**, **DOM nodes**, **Event listeners**, and **Layouts/sec**.

## Baseline Metrics to Capture

When profiling, record these metrics with N=1 terminal and N=40 terminals:

| Metric                            | N=1 baseline | N=40 target                 | How to measure                      |
| --------------------------------- | ------------ | --------------------------- | ----------------------------------- |
| Terminal creation time            | —            | <500ms per terminal         | DevTools Performance panel          |
| JS heap size                      | —            | <500 MB                     | `performance.memory.usedJSHeapSize` |
| Event listener count              | 2 global     | 2 global (not 80)           | DevTools → Performance monitor      |
| Tauri event throughput            | —            | No dropped events           | Check terminal output completeness  |
| Rust thread count                 | ~5           | ~85 (2 per terminal + base) | Task Manager or `ps`                |
| Input latency (keystroke to echo) | <50ms        | <100ms                      | Manual measurement                  |

## Memory Leak Detection Checklist

After creating and closing 40 terminals, verify:

1. **JS heap returns to baseline**: Take a heap snapshot before creating terminals, another after closing them all. The delta should be minimal (<10 MB).

2. **No detached DOM nodes**: In the Memory panel, search for "Detached" after closing all terminals. There should be no detached xterm containers.

3. **Event listeners cleaned up**: The singleton dispatcher's callback maps should be empty after all terminals are closed. Check via console:

   ```javascript
   // In DevTools console (if exposed for debugging)
   // The dispatcher's maps should have 0 entries
   ```

4. **Rust threads cleaned up**: After closing all terminals, the thread count should return to baseline. Check via Task Manager or system tools.

5. **No channel leaks**: The bounded channels should be dropped when terminals close, freeing any queued `Vec<u8>` allocations.

## Automated Performance Tests

Run the E2E performance test suite:

```bash
# Requires a built app (pnpm tauri build) and tauri-driver
pnpm test:e2e:perf
```

The suite covers:

- **PERF-01**: Create 40 terminals, verify tab count
- **PERF-02**: UI responsiveness with 40 terminals open (41st creation <5s)
- **PERF-03**: JS heap memory under 500 MB
- **PERF-04**: Cleanup after closing all terminals

## Session Limit

The backend enforces a maximum of 50 concurrent sessions (`MAX_SESSIONS` in `manager.rs`). Attempting to create more returns an error displayed in the terminal.

## Troubleshooting Performance Issues

### High memory usage

- Check if output batching is working: in DevTools Performance panel, `xterm.write()` calls should be infrequent (once per animation frame, not once per output chunk).
- Check for unbounded terminal scrollback: xterm.js default scrollback is 1000 lines. Consider reducing if memory is tight.

### Slow terminal creation

- Check if the session limit is close: creating sessions near the limit incurs a mutex lock check.
- Check shell startup: some shells (especially zsh with plugins) have slow startup times.

### Laggy input

- Check if the bounded channel is full: this causes the backend write thread to block, which can delay output but shouldn't affect input. If input feels laggy, the issue is likely in the frontend event loop.
- Check if too many terminals are producing heavy output simultaneously.
