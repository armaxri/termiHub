/**
 * Tab-strip "receiving macro" marker (#3446, follow-up to PROD-042 / #3443).
 *
 * While a macro plays into several terminals at once, every receiving tab is
 * badged in the tab strip so keystrokes going to multiple hosts are never
 * invisible. The marker is driven purely by `macroPlayback.targetTabIds`, which
 * the playback slice narrows as targets drop out and clears when the run ends
 * (finished, cancelled, or every target gone).
 *
 * Single-terminal playback is deliberately NOT marked: it types into exactly the
 * tab the user started it from, which already shows the in-terminal
 * "Stop Playback (n/m)" toolbar state — there is no multi-host risk to flag.
 */
import type { MacroPlaybackState } from "@/store/appStore";

/** What a receiving tab's marker shows. */
export interface MacroReceivingInfo {
  /** Name of the macro being played. */
  macroName: string;
  /** Steps injected so far. */
  played: number;
  /** Total steps in the macro. */
  total: number;
}

/**
 * The marker info for `tabId`, or `null` when the tab is not currently receiving
 * a multi-target macro.
 */
export function macroReceivingInfo(
  playback: MacroPlaybackState | null,
  tabId: string
): MacroReceivingInfo | null {
  const targets = playback?.targetTabIds;
  if (!playback || !targets || targets.length === 0) return null;
  if (!targets.includes(tabId)) return null;
  return { macroName: playback.macroName, played: playback.played, total: playback.total };
}

/** Human-readable (tooltip + accessible) label for a receiving tab's marker. */
export function macroReceivingLabel(info: MacroReceivingInfo): string {
  return `Receiving macro "${info.macroName}" (${info.played}/${info.total} steps)`;
}
