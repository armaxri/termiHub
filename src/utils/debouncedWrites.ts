/**
 * Writes that wait a moment so that a burst of changes is written once (#6094): the
 * layout, the last session, the window's layout report. Keyed: a new write of a key
 * replaces the one that waits.
 *
 * Closing the window or quitting writes what waits at once ({@link flushDebouncedWrites}),
 * so the last change of the layout is not lost. A write that fails, at once or later,
 * is logged and never thrown out of a timer.
 */
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

type Write = () => void | Promise<unknown>;

const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; write: Write }>();

/** Run `write`; what it throws or rejects with is logged. */
async function run(key: string, write: Write): Promise<void> {
  try {
    await write();
  } catch (err) {
    frontendLog("debounced_write", `writing ${key} failed: ${errorMessage(err)}`);
  }
}

/** Write `write` under `key` in `ms`, unless another write of `key` comes first. */
export function debounceWrite(key: string, ms: number, write: Write): void {
  cancelDebouncedWrite(key);
  const timer = setTimeout(() => {
    waiting.delete(key);
    void run(key, write);
  }, ms);
  waiting.set(key, { timer, write });
}

/** Drop the write of `key` that waits, if any. */
export function cancelDebouncedWrite(key: string): void {
  const entry = waiting.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  waiting.delete(key);
}

/** Write everything that waits, now, and wait for it. */
export async function flushDebouncedWrites(): Promise<void> {
  const entries = [...waiting.entries()];
  for (const [key] of entries) cancelDebouncedWrite(key);
  await Promise.all(entries.map(([key, { write }]) => run(key, write)));
}

/** Drop everything that waits: the end of a test, whose mocks are gone after it. */
export function cancelDebouncedWrites(): void {
  for (const key of [...waiting.keys()]) cancelDebouncedWrite(key);
}
