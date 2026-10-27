/**
 * WCAG 2.x colour-contrast helpers for the theme engine.
 *
 * Shared by the built-in palette regression test (`contrast.test.ts`, #2070)
 * and by {@link deriveTextOnAccent}, which picks a readable foreground for the
 * accent surface of custom and plugin themes (UI2-003, #4356).
 */

/** Dark foreground used on a light accent. */
export const TEXT_ON_ACCENT_DARK = "#000000";
/** Light foreground used on a dark or mid-tone accent (the built-in default). */
export const TEXT_ON_ACCENT_LIGHT = "#ffffff";

/**
 * Minimum contrast white must keep against the accent before the derived
 * foreground flips to dark. 3:1 is the WCAG 2.2 AA minimum for large text and
 * UI components; it keeps the established white-on-blue look of every
 * built-in theme (whose accents sit between 3:1 and 4.5:1 against white) while
 * catching genuinely light accents such as yellows and pastels.
 */
const WHITE_ON_ACCENT_MIN_CONTRAST = 3;

/** Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` into 0-255 RGB, or `null`. */
function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length <= 4) {
    hex = hex
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(hex.slice(0, 6), 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/**
 * sRGB relative luminance per WCAG 2.x, from a hex colour string. Returns
 * `null` for a value that is not a hex colour.
 */
export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two hex colours (always >= 1). Returns `NaN`
 * when either value is not a hex colour.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return NaN;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick the foreground for text and icons drawn on the accent colour. White is
 * kept while it reaches {@link WHITE_ON_ACCENT_MIN_CONTRAST} against the
 * accent; below that the higher-contrast of white and black wins, so a light
 * accent gets dark text. An unparseable accent keeps the white default.
 */
export function deriveTextOnAccent(accent: string): string {
  const white = contrastRatio(TEXT_ON_ACCENT_LIGHT, accent);
  if (Number.isNaN(white) || white >= WHITE_ON_ACCENT_MIN_CONTRAST) {
    return TEXT_ON_ACCENT_LIGHT;
  }
  const black = contrastRatio(TEXT_ON_ACCENT_DARK, accent);
  return black > white ? TEXT_ON_ACCENT_DARK : TEXT_ON_ACCENT_LIGHT;
}

/** Format 0-255 RGB channels as a lowercase `#rrggbb` string. */
function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Nudge a foreground colour until it reaches `minRatio` contrast against every
 * colour in `backgrounds` (#5008: per-connection icon colours). The colour is
 * mixed in 10% steps towards white when the backgrounds are dark, or towards
 * black when they are light, so it keeps its hue as long as possible.
 *
 * Returns the input unchanged when it already passes, when it is not a hex
 * colour, or when no background is a hex colour (nothing to measure against).
 */
export function adjustForContrast(color: string, backgrounds: string[], minRatio = 3): string {
  const rgb = parseHex(color);
  const bgs = backgrounds.filter((b) => relativeLuminance(b) !== null);
  if (!rgb || bgs.length === 0) return color;
  const worst = (c: string) => Math.min(...bgs.map((b) => contrastRatio(c, b)));
  if (worst(color) >= minRatio) return color;

  const avgLum = bgs.reduce((sum, b) => sum + (relativeLuminance(b) ?? 0), 0) / bgs.length;
  const target = avgLum < 0.5 ? 255 : 0;
  let best = color;
  for (let step = 1; step <= 10; step++) {
    const t = step / 10;
    const mixed = toHex(rgb.map((c) => c + (target - c) * t) as [number, number, number]);
    best = mixed;
    if (worst(mixed) >= minRatio) break;
  }
  return best;
}
