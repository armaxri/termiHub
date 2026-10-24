/**
 * Raw terminal-output tap for the test bridge (#4931).
 *
 * `readTerminal` reads xterm's *buffer*, which only holds what is still there:
 * text a session painted and then erased (a screen clear, a reset, an
 * alternate-screen switch) is gone from it. That is exactly a "flash" — setup
 * or banner bytes that appear for a moment before the prompt. This tap records
 * the raw stream every registered terminal is handed through `xterm.write`, so
 * the harness can assert on what was delivered, escapes and all, not only on
 * what survived.
 *
 * Bounded so a flood (`yes`) cannot grow it: each tab keeps the first
 * {@link OUTPUT_TAP_HEAD_LIMIT} characters (the start of a session is what the
 * flash grades read) and only counts the rest, and at most
 * {@link OUTPUT_TAP_MAX_TABS} tabs are tracked (the oldest is dropped).
 *
 * Installed only by the lazily loaded test bridge, through the registry's
 * register observer, so a production bundle never contains it.
 */
import type { TerminalOutputTap } from "./protocol";

/** Characters of the start of each tab's output stream that are retained. */
export const OUTPUT_TAP_HEAD_LIMIT = 64 * 1024;

/** Tabs whose streams are tracked at once; the oldest is dropped past this. */
export const OUTPUT_TAP_MAX_TABS = 64;

/** The part of an xterm instance the tap wraps. */
export interface WritableTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
}

interface TapRecord {
  head: string;
  /** Data units written: characters for string writes, bytes for binary ones. */
  written: number;
  writes: number;
  truncated: boolean;
  lastWriteAt: number | null;
  decoder: TextDecoder;
}

const records = new Map<string, TapRecord>();
const wrapped = new WeakSet<object>();

function recordFor(tabId: string): TapRecord {
  let record = records.get(tabId);
  if (!record) {
    record = {
      head: "",
      written: 0,
      writes: 0,
      truncated: false,
      lastWriteAt: null,
      decoder: new TextDecoder("utf-8"),
    };
    records.set(tabId, record);
    while (records.size > OUTPUT_TAP_MAX_TABS) {
      const oldest = records.keys().next();
      if (oldest.done) break;
      records.delete(oldest.value);
    }
  }
  return record;
}

function capture(tabId: string, data: string | Uint8Array, now: number): void {
  const record = recordFor(tabId);
  record.writes += 1;
  record.written += data.length;
  record.lastWriteAt = now;
  if (record.head.length >= OUTPUT_TAP_HEAD_LIMIT) {
    record.truncated = true;
    return;
  }
  const text = typeof data === "string" ? data : record.decoder.decode(data, { stream: true });
  const head = record.head + text;
  record.truncated = head.length > OUTPUT_TAP_HEAD_LIMIT;
  record.head = record.truncated ? head.slice(0, OUTPUT_TAP_HEAD_LIMIT) : head;
}

/**
 * Start recording everything written to `xterm` under `tabId`.
 *
 * Wraps the instance's `write` once (a re-registration of the same instance is
 * a no-op); a remounted terminal's new instance keeps appending to the same
 * tab's record. Recording never throws into the write path.
 */
export function tapTerminalOutput(
  tabId: string,
  xterm: WritableTerminal,
  now: () => number = () => performance.now()
): void {
  if (wrapped.has(xterm)) return;
  wrapped.add(xterm);
  recordFor(tabId);
  const write = xterm.write.bind(xterm);
  xterm.write = (data: string | Uint8Array, callback?: () => void) => {
    try {
      capture(tabId, data, now());
    } catch {
      // A recording failure must never break terminal output.
    }
    write(data, callback);
  };
}

/** The tab's recorded stream, or `undefined` when it was never tapped. */
export function readTerminalOutput(
  tabId: string,
  now: () => number = () => performance.now()
): TerminalOutputTap | undefined {
  const record = records.get(tabId);
  if (!record) return undefined;
  return {
    output: record.head,
    written: record.written,
    writes: record.writes,
    truncated: record.truncated,
    msSinceLastWrite: record.lastWriteAt === null ? null : now() - record.lastWriteAt,
  };
}

/** Forget every recorded stream (unit tests only). */
export function resetTerminalOutputTaps(): void {
  records.clear();
}
