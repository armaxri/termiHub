/**
 * Terminal character-width tables (#4177).
 *
 * By default every terminal uses xterm's Unicode 11 width tables
 * (`@xterm/addon-unicode11`, `unicode.activeVersion = "11"`). Those have no
 * grapheme clustering: an emoji ZWJ family, a skin-tone modifier or a flag pair
 * occupies one cell group per component emoji — the same layout most shells and
 * line editors assume when they move the cursor.
 *
 * The experimental "Combine emoji" terminal setting switches a terminal to
 * `@xterm/addon-unicode-graphemes` (`activeVersion = "15-graphemes"`), which
 * lays out each grapheme cluster as one double-width glyph. A shell that still
 * counts the parts separately then disagrees with the terminal about where the
 * cursor is, so the setting is opt-in and off by default.
 *
 * Switching is live: it only changes which width provider xterm consults, so
 * output written **after** the switch uses the new layout while lines already
 * in the buffer keep the layout they were written with (xterm stores computed
 * widths per cell and does not re-lay out existing content).
 */
import type { Terminal as XTerm } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

/** xterm Unicode version with the app's default Unicode 11 width tables. */
export const UNICODE_VERSION_DEFAULT = "11";
/** xterm Unicode version registered by the graphemes addon (clustering on). */
export const UNICODE_VERSION_GRAPHEMES = "15-graphemes";

type UnicodeTerminal = Pick<XTerm, "loadAddon" | "unicode">;

/** Terminals that already have the graphemes addon loaded (it is loaded once, lazily). */
const graphemesLoaded = new WeakSet<UnicodeTerminal>();

/**
 * Select the width tables for one terminal. The Unicode 11 addon must already
 * be loaded. The graphemes addon is loaded into the terminal the first time the
 * setting is turned on and stays registered afterwards, so toggling back and
 * forth only flips `unicode.activeVersion`.
 */
export function applyCombineEmoji(xterm: UnicodeTerminal, combineEmoji: boolean): void {
  if (combineEmoji) {
    if (!graphemesLoaded.has(xterm)) {
      xterm.loadAddon(new UnicodeGraphemesAddon());
      graphemesLoaded.add(xterm);
    }
    xterm.unicode.activeVersion = UNICODE_VERSION_GRAPHEMES;
  } else {
    xterm.unicode.activeVersion = UNICODE_VERSION_DEFAULT;
  }
}
