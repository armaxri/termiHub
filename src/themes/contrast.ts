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
 * mixed in `stepPercent` steps (10% by default) towards white when the
 * backgrounds are dark, or towards black when they are light, so it keeps its
 * hue as long as possible.
 *
 * Returns the input unchanged when it already passes, when it is not a hex
 * colour, or when no background is a hex colour (nothing to measure against).
 */
export function adjustForContrast(
  color: string,
  backgrounds: string[],
  minRatio = 3,
  stepPercent = 10
): string {
  const rgb = parseHex(color);
  const bgs = backgrounds.filter((b) => relativeLuminance(b) !== null);
  if (!rgb || bgs.length === 0) return color;
  const worst = (c: string) => Math.min(...bgs.map((b) => contrastRatio(c, b)));
  if (worst(color) >= minRatio) return color;

  const avgLum = bgs.reduce((sum, b) => sum + (relativeLuminance(b) ?? 0), 0) / bgs.length;
  const target = avgLum < 0.5 ? 255 : 0;
  let best = color;
  const steps = Math.ceil(100 / stepPercent);
  for (let step = 1; step <= steps; step++) {
    const t = Math.min(1, (step * stepPercent) / 100);
    const mixed = toHex(rgb.map((c) => c + (target - c) * t) as [number, number, number]);
    best = mixed;
    if (worst(mixed) >= minRatio) break;
  }
  return best;
}

/** WCAG 2.2 AA minimum contrast for normal-size text. */
export const AA_NORMAL_TEXT = 4.5;

/**
 * Derive `textMutedOnSelection` (#5200): the muted text colour for hints drawn
 * on a hovered (`bgHover`) or selected (`bgActive`) row. Those row surfaces sit
 * closer to the muted tone than the plain backgrounds, so `textMuted` is nudged
 * in 1% steps — keeping its hue — until it reaches AA on both. A `textMuted`
 * that already passes is returned unchanged.
 */
export function deriveTextMutedOnSelection(colors: {
  textMuted: string;
  bgHover: string;
  bgActive: string;
}): string {
  return adjustForContrast(colors.textMuted, [colors.bgHover, colors.bgActive], AA_NORMAL_TEXT, 1);
}

/**
 * Derive `textSecondaryOnSelection` (#5249): the secondary text colour for row
 * labels drawn on a hovered (`bgHover`) or selected (`bgActive`) row. Same
 * approach as {@link deriveTextMutedOnSelection}: `textSecondary` is nudged in
 * 1% steps, keeping its hue, until it reaches AA on both row backgrounds. A
 * `textSecondary` that already passes is returned unchanged.
 */
export function deriveTextSecondaryOnSelection(colors: {
  textSecondary: string;
  bgHover: string;
  bgActive: string;
}): string {
  return adjustForContrast(
    colors.textSecondary,
    [colors.bgHover, colors.bgActive],
    AA_NORMAL_TEXT,
    1
  );
}

/** Minimum contrast every ANSI colour keeps against the terminal background (#5191). */
export const ANSI_MIN_CONTRAST = 3;

/** The sixteen ANSI palette tokens, normal then bright. */
export const ANSI_COLOR_KEYS = [
  "ansiBlack",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
  "ansiBlue",
  "ansiMagenta",
  "ansiCyan",
  "ansiWhite",
  "ansiBrightBlack",
  "ansiBrightRed",
  "ansiBrightGreen",
  "ansiBrightYellow",
  "ansiBrightBlue",
  "ansiBrightMagenta",
  "ansiBrightCyan",
  "ansiBrightWhite",
] as const;

/** One of the sixteen ANSI palette token keys. */
export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number];

/** sRGB channel (0-1) to linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light to an sRGB channel (0-1). */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** 0-255 sRGB to OKLab `[L, a, b]`. */
function rgbToOklab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map((c) => srgbToLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH to linear sRGB (channels may fall outside 0-1 when out of gamut). */
function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/**
 * OKLCH to a `#rrggbb` string. A colour outside the sRGB gamut keeps its
 * lightness and hue and gives up only as much chroma as it must.
 */
function oklchToHex(L: number, C: number, h: number): string {
  let chroma = C;
  if (!inGamut(oklchToLinearRgb(L, chroma, h))) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb(L, mid, h))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  const rgb = oklchToLinearRgb(L, chroma, h).map(
    (c) => linearToSrgb(Math.min(1, Math.max(0, c))) * 255
  ) as [number, number, number];
  return toHex(rgb);
}

/**
 * Nudge `color` until it reaches `minRatio` contrast against `background`,
 * changing only its perceptual lightness (OKLCH L) so hue and chroma — the
 * colour's identity — are kept (#5191, #5192). L moves in 0.1% steps away from
 * the background (lighter on a dark background, darker on a light one), so the
 * result is the smallest change that passes.
 *
 * Returns the input unchanged when it already passes, when either value is not
 * a hex colour, or when no lightness reaches the ratio.
 */
export function adjustLightnessForContrast(
  color: string,
  background: string,
  minRatio = ANSI_MIN_CONTRAST
): string {
  const rgb = parseHex(color);
  const ratio = contrastRatio(color, background);
  if (!rgb || Number.isNaN(ratio) || ratio >= minRatio) return color;
  const [L, a, b] = rgbToOklab(rgb);
  const C = Math.hypot(a, b);
  const h = Math.atan2(b, a);
  const dir =
    contrastRatio(TEXT_ON_ACCENT_LIGHT, background) >=
    contrastRatio(TEXT_ON_ACCENT_DARK, background)
      ? 1
      : -1;
  for (let step = 1; step <= 1000; step++) {
    const next = L + (dir * step) / 1000;
    if (next < 0 || next > 1) break;
    const candidate = oklchToHex(next, C, h);
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return color;
}

/**
 * Apply the ANSI contrast floor (#5191): every ANSI colour is nudged with
 * {@link adjustLightnessForContrast} until it reaches {@link ANSI_MIN_CONTRAST}
 * against `terminalBg`. Built-in palettes already pass, so this is a no-op for
 * them; it guarantees the same for custom, imported and plugin themes, where an
 * `ansiWhite` equal to a white background would otherwise print invisibly.
 */
export function applyAnsiContrastFloor(
  colors: Record<AnsiColorKey | "terminalBg", string>
): Record<AnsiColorKey, string> {
  const out = {} as Record<AnsiColorKey, string>;
  for (const key of ANSI_COLOR_KEYS) {
    out[key] = adjustLightnessForContrast(colors[key], colors.terminalBg, ANSI_MIN_CONTRAST);
  }
  return out;
}
