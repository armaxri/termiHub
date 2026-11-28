/**
 * The icon size scale (#6157, audit UI-028), in px, for lucide's `size` prop
 * and any component that draws a glyph at a size.
 *
 * Every icon names a tier — `<Plus size={ICON_SIZE.sm} />` — never a number;
 * `tokenDiscipline.test.ts` rejects a numeric `size={…}`. The same values are
 * `--icon-*` in variables.css, for glyphs sized in CSS.
 *
 * - `xs` 12: inline with small text (row markers, carets, a checkbox tick).
 * - `sm` 14: the default, in buttons, menus and rows.
 * - `md` 16: tree chevrons, connection-type icons, notices.
 * - `lg` 20: dialog headers and banners.
 * - `xl` 24: empty states and pickers.
 * - `hero` 32: a large standalone illustration.
 */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, hero: 32 } as const;

/** A tier of the icon scale. */
export type IconSizeTier = keyof typeof ICON_SIZE;
