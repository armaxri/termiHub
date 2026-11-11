/**
 * Minimum contrast every terminal glyph keeps against its own cell background
 * (#5191, #5309).
 *
 * Passed to xterm.js as `minimumContrastRatio`. xterm adjusts only the
 * foreground colour of a cell, at render time, and only when that cell's
 * foreground/background pair falls below the ratio. Both the WebGL renderer and
 * the DOM fallback honour it. Powerline and box-drawing glyphs are exempt by
 * design, and dim text is held to half the ratio.
 *
 * Why render time and not the palette: the ANSI palette paints both foreground
 * and background cells. Lifting `ansiBlack` to 3:1 in the palette (#5274) also
 * turned every ANSI-black *background* grey, so powerline/Agnoster segments and
 * TUI panels no longer blended into the terminal (#5309). The palette therefore
 * stays canonical, and readability is enforced per cell here.
 *
 * 3:1 is the WCAG 1.4.11 / large-text floor #5191 chose. It leaves any theme
 * colour that already passes untouched, so a user's or a plugin's theme renders
 * exactly as authored wherever it is readable.
 */
export const TERMINAL_MIN_CONTRAST_RATIO = 3;
