/** What recordings say about themselves (#5818, slice 8). All **pure**. */
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";

/** The longest default name taken from what was typed. */
const MAX_NAME = 40;

const ESC = String.fromCharCode(0x1b);
/** A key or paste marker as a terminal sends it: CSI, SS3, or a bare escape. */
const ESCAPE_SEQUENCE = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|O.|)`, "g");

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

/** The text a typed line leaves behind: no control keys, backspaces applied. */
function typedText(line: string): string {
  const kept: string[] = [];
  for (const char of line.replace(ESCAPE_SEQUENCE, "")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x7f || code === 0x08) kept.pop();
    else if (code >= 0x20) kept.push(char);
  }
  return kept.join("").trim();
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
  const lines = chunks
    .map((chunk) => chunk.data)
    .join("")
    .split(/[\r\n]/)
    .map(typedText);
  const chars = Array.from(lines.find(Boolean) ?? `Recording in ${tabTitle}`);
  const name =
    chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join("")}…` : chars.join("");
  return uniqueName(name, taken);
}
