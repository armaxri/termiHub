/**
 * Terminal output flow control (PERF2-002, #4307).
 *
 * xterm.js parses writes asynchronously. A program that floods output (`yes`,
 * `cat` of a huge file) can deliver bytes faster than xterm parses them, and
 * without flow control they pile up in the terminal's output buffer and in
 * xterm's own write queue (xterm throws and discards past 50 MB).
 *
 * This implements xterm's documented write-callback watermark pattern:
 *
 * - Every byte handed to `xterm.write` is counted until its write callback
 *   fires ("in flight"); bytes received but not yet handed over are "staged".
 * - When staged + in-flight exceeds the high watermark the backend is asked to
 *   pause. It then stops reading the session's output, so the PTY
 *   backpressures the program. Once xterm drains below the low watermark the
 *   backend is asked to resume.
 * - Staged output is only handed to xterm while its backlog is under the high
 *   watermark, so xterm's queue stays bounded too.
 * - Agent-hosted sessions pause the same way: the backend forwards the pause to
 *   the agent (`connection.output_flow`, #4416), which stops reading the
 *   session's output on the remote host.
 * - As a last-resort safety net the staged buffer is hard-capped. The cap is
 *   only reached when the producer ignores pause (a session on an agent older
 *   than protocol 0.27.0, which cannot be paused); the oldest staged output is
 *   then dropped, which is still better than xterm throwing it away wholesale.
 *
 * Input (Ctrl+C included) is a separate path and is never held back.
 */

import { setTerminalOutputPaused } from "@/services/api";
import type { SessionId } from "@/types/terminal";

/** Unparsed bytes above which the backend is paused. */
export const FLOW_HIGH_WATERMARK = 2 * 1024 * 1024;
/** Unparsed bytes below which a paused backend is resumed. */
export const FLOW_LOW_WATERMARK = 512 * 1024;
/** Hard cap on staged (not yet handed to xterm) bytes. */
export const FLOW_MAX_STAGED_BYTES = 32 * 1024 * 1024;

export interface TerminalOutputFlowOptions {
  highWatermark?: number;
  lowWatermark?: number;
  maxStagedBytes?: number;
  /** Called on every pause (`true`) / resume (`false`) transition. */
  onPausedChange: (paused: boolean) => void;
  /** Called with the byte count dropped when the staged hard cap is hit. */
  onOverflow?: (droppedBytes: number) => void;
}

/** Staged output plus xterm write-backlog accounting for one terminal. */
export class TerminalOutputFlow {
  private readonly high: number;
  private readonly low: number;
  private readonly maxStaged: number;
  private readonly onPausedChange: (paused: boolean) => void;
  private readonly onOverflow?: (droppedBytes: number) => void;

  private staged: Uint8Array[] = [];
  private stagedLen = 0;
  private inflight = 0;
  private isPaused = false;

  constructor(options: TerminalOutputFlowOptions) {
    this.high = options.highWatermark ?? FLOW_HIGH_WATERMARK;
    this.low = options.lowWatermark ?? FLOW_LOW_WATERMARK;
    this.maxStaged = options.maxStagedBytes ?? FLOW_MAX_STAGED_BYTES;
    this.onPausedChange = options.onPausedChange;
    this.onOverflow = options.onOverflow;
  }

  /** Bytes received but not yet handed to xterm. */
  get stagedBytes(): number {
    return this.stagedLen;
  }

  /** Bytes handed to xterm whose write callback has not fired yet. */
  get inflightBytes(): number {
    return this.inflight;
  }

  /** Whether the backend has been asked to pause. */
  get paused(): boolean {
    return this.isPaused;
  }

  /** Whether there is staged output waiting for a flush. */
  get hasStaged(): boolean {
    return this.staged.length > 0;
  }

  /** Stage a received output chunk. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.staged.push(chunk);
    this.stagedLen += chunk.length;
    this.enforceCap();
    if (!this.isPaused && this.stagedLen + this.inflight > this.high) {
      this.setPaused(true);
    }
  }

  /**
   * Take all staged output as one batch for `xterm.write`, counting it as in
   * flight. Returns `null` when nothing is staged or xterm's backlog is at the
   * high watermark (the next write callback makes room); `force` ignores the
   * backlog (final drain on teardown).
   */
  takeBatch(force = false): Uint8Array | null {
    if (this.staged.length === 0 || (!force && this.inflight >= this.high)) return null;
    let batch: Uint8Array;
    if (this.staged.length === 1) {
      batch = this.staged[0];
    } else {
      batch = new Uint8Array(this.stagedLen);
      let offset = 0;
      for (const chunk of this.staged) {
        batch.set(chunk, offset);
        offset += chunk.length;
      }
    }
    this.staged = [];
    this.stagedLen = 0;
    this.inflight += batch.length;
    return batch;
  }

  /** xterm's write callback fired for `bytes` previously taken. */
  written(bytes: number): void {
    this.inflight = Math.max(0, this.inflight - bytes);
    if (this.isPaused && this.stagedLen + this.inflight <= this.low) {
      this.setPaused(false);
    }
  }

  /** xterm refused a taken batch: put it back in front of the staged output. */
  restore(batch: Uint8Array): void {
    this.inflight = Math.max(0, this.inflight - batch.length);
    this.staged.unshift(batch);
    this.stagedLen += batch.length;
  }

  /** The terminal is going away: never leave the backend paused. */
  dispose(): void {
    if (this.isPaused) this.setPaused(false);
  }

  private enforceCap(): void {
    let dropped = 0;
    while (this.stagedLen > this.maxStaged && this.staged.length > 1) {
      const oldest = this.staged.shift() as Uint8Array;
      this.stagedLen -= oldest.length;
      dropped += oldest.length;
    }
    if (dropped > 0) this.onOverflow?.(dropped);
  }

  private setPaused(paused: boolean): void {
    this.isPaused = paused;
    this.onPausedChange(paused);
  }
}

/** A pause/resume signal sender; see {@link createFlowSignal}. */
export interface FlowSignal {
  (paused: boolean): void;
  /** Resolves once every signal sent so far has been delivered (tests). */
  settled(): Promise<void>;
}

/**
 * Wrap the pause/resume IPC so signals reach the backend one at a time and in
 * order. Two concurrent IPC calls could otherwise land out of order and leave
 * the backend paused after the frontend resumed. A failing send (the session
 * is already gone) is swallowed and does not block later signals.
 */
export function createFlowSignal(send: (paused: boolean) => Promise<void>): FlowSignal {
  let chain: Promise<void> = Promise.resolve();
  const signal = ((paused: boolean) => {
    chain = chain.then(() => send(paused)).catch(() => undefined);
  }) as FlowSignal;
  signal.settled = () => chain;
  return signal;
}

/**
 * A {@link TerminalOutputFlow} bound to a backend session: pause/resume go to
 * the backend over IPC, an overflow is reported through `log`. The backend is
 * told "not paused" up front, so a session reattached after a webview reload
 * never stays paused by a terminal that no longer exists.
 */
export function createSessionOutputFlow(
  sessionId: SessionId,
  log: (message: string) => void
): TerminalOutputFlow {
  const signal = createFlowSignal((paused) => setTerminalOutputPaused(sessionId, paused));
  signal(false);
  return new TerminalOutputFlow({
    onPausedChange: signal,
    onOverflow: (dropped) =>
      log(`output flow: dropped ${dropped} bytes past the staged cap session=${sessionId}`),
  });
}
