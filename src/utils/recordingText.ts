/** What recordings say about themselves (#5818, slice 8). All **pure**. */
import { macroPreviewLines } from "@/components/AutomationEditor/keysFormat";
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";

/** The longest default name taken from what was typed. */
const MAX_NAME = 40;

/** "1 key" / "14 keys". */
export function recordedKeys(count: number): string {
  return `${count} key${count === 1 ? "" : "s"}`;
}

/** "3.2 s" / "2 min 5 s". */
export function recordedTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** `base`, or `base 2`, `base 3`, … when an automation is called that already. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * The name a recording is offered: the first line it types, or the terminal it
 * was made in. `chunks` must not hold what was typed at a password prompt.
 */
export function recordingName(
  chunks: readonly TypeKeysChunk[],
  tabTitle: string,
  taken: readonly string[]
): string {
  const [line] = macroPreviewLines([...chunks], MAX_NAME);
  return uniqueName(line?.trim() || `Recording in ${tabTitle}`, taken);
}
