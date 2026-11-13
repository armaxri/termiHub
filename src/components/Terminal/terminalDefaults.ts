/**
 * Effective terminal defaults used when neither the tab, the connection nor the
 * app settings set a value. Shared by the terminal and the settings UI, so the
 * value Settings shows as "Default" is the one the terminal actually uses (#5554).
 */

/** Terminal font size in pixels. */
export const DEFAULT_FONT_SIZE = 14;

/** Line height of 1.0 ensures box-drawing characters connect without gaps. */
export const DEFAULT_LINE_HEIGHT = 1.0;

/** Lines kept in the terminal scrollback. */
export const DEFAULT_SCROLLBACK = 10000;
