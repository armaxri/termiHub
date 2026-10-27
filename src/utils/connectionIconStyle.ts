/**
 * Per-connection icon colour and emoji (#5008).
 *
 * A saved connection may carry an optional `iconColor` — a named entry of the
 * small theme-aware {@link ICON_COLOR_PALETTE} or a custom `#rrggbb` hex — and
 * an optional `iconEmoji` (exactly one emoji grapheme) that replaces the type
 * icon. Both are stored opaquely by the backend; this module owns validation
 * and resolution against the active theme.
 */
import { adjustForContrast, relativeLuminance } from "@/themes/contrast";
import type { ThemeColors } from "@/themes";
import { z } from "zod";

/** A named icon colour with one shade per background brightness. */
export interface IconPaletteEntry {
  /** Stored value, e.g. `"blue"`. */
  name: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Shade used on light surfaces. */
  light: string;
  /** Shade used on dark surfaces. */
  dark: string;
}

/**
 * The named icon colours. Each has a darker shade for light themes and a
 * lighter shade for dark themes so it reads at >= 3:1 on the built-in sidebar
 * and tab surfaces (pinned by `connectionIconStyle.test.ts`).
 */
export const ICON_COLOR_PALETTE: readonly IconPaletteEntry[] = [
  { name: "red", label: "Red", light: "#c62828", dark: "#ff6b6b" },
  { name: "orange", label: "Orange", light: "#b45000", dark: "#ffa94d" },
  { name: "yellow", label: "Yellow", light: "#8a6500", dark: "#ffd43b" },
  { name: "green", label: "Green", light: "#2e7d32", dark: "#69db7c" },
  { name: "teal", label: "Teal", light: "#00796b", dark: "#38d9a9" },
  { name: "blue", label: "Blue", light: "#1565c0", dark: "#4dabf7" },
  { name: "purple", label: "Purple", light: "#7b1fa2", dark: "#b197fc" },
  { name: "pink", label: "Pink", light: "#c2185b", dark: "#f783ac" },
  { name: "gray", label: "Gray", light: "#5f6368", dark: "#adb5bd" },
];

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** True for a `#rrggbb` hex string. */
export function isHexIconColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

/** The palette entry for a stored name, or `undefined`. */
export function findPaletteEntry(value: string): IconPaletteEntry | undefined {
  return ICON_COLOR_PALETTE.find((e) => e.name === value);
}

/** True when `value` is a palette name or a `#rrggbb` hex colour. */
export function isValidIconColor(value: string): boolean {
  return findPaletteEntry(value) !== undefined || isHexIconColor(value);
}

/** The theme surfaces a connection icon is drawn on (sidebar rows and tabs). */
export function iconSurfaces(colors: ThemeColors): string[] {
  return [colors.sidebarBg, colors.tabBg, colors.tabActiveBg];
}

/**
 * Resolve a stored icon colour to a concrete CSS colour for the given theme
 * surfaces: a palette name picks its light/dark shade by surface brightness,
 * a hex is used as-is; either is then nudged until it keeps >= 3:1 contrast
 * against every surface. Returns `undefined` for an unset or unrecognised
 * value so the icon keeps its default (inherited) colour.
 */
export function resolveIconColor(
  value: string | null | undefined,
  surfaces: string[]
): string | undefined {
  if (!value) return undefined;
  const entry = findPaletteEntry(value);
  if (!entry && !isHexIconColor(value)) return undefined;
  const lums = surfaces.map(relativeLuminance).filter((l): l is number => l !== null);
  const dark = lums.length > 0 && lums.reduce((a, b) => a + b, 0) / lums.length < 0.5;
  const base = entry ? (dark ? entry.dark : entry.light) : value;
  return adjustForContrast(base, surfaces, 3);
}

// `Intl.Segmenter` is ES2022; the repo's tsconfig lib is ES2020, so declare the
// slice used here (same approach as `testbridge/unicodeRoundTrip.test.ts`).
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
type SegmenterCtor = new (
  locale: string | undefined,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter;

/** Count user-perceived characters, falling back to code points. */
function graphemeCount(value: string): number {
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Ctor) return Array.from(value).length;
  return Array.from(new Ctor(undefined, { granularity: "grapheme" }).segment(value)).length;
}

/** Pictographs, flags (regional indicators) and keycaps (U+20E3). */
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** True when `value` is exactly one emoji grapheme (ZWJ sequences, flags, skin tones included). */
export function isSingleEmoji(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  return EMOJI_RE.test(value) && graphemeCount(value) === 1;
}

/**
 * Zod schema for a stored icon colour. Optional fields must accept `null`
 * (= unset) as well as `undefined` — the #2467 pitfall.
 */
export const iconColorSchema = z
  .string()
  .refine(isValidIconColor, { message: "Choose a palette color or a #rrggbb hex color." })
  .nullable()
  .optional();

/** Zod schema for a stored icon emoji (exactly one emoji grapheme, or unset). */
export const iconEmojiSchema = z
  .string()
  .refine(isSingleEmoji, { message: "Enter a single emoji." })
  .nullable()
  .optional();
