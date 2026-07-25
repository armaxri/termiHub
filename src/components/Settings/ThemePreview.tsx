import type { ThemeColors, ThemeDefinition } from "@/themes/types";
import "./ThemePreview.css";

/** The four representative colors shown when previewing a theme, in display order. */
const PREVIEW_SWATCHES: { key: keyof ThemeColors; label: string }[] = [
  { key: "terminalBg", label: "Terminal BG" },
  { key: "terminalFg", label: "Terminal FG" },
  { key: "accentColor", label: "Accent" },
  { key: "bgPrimary", label: "Background" },
];

export interface ThemePreviewProps {
  /**
   * A fully-resolved theme definition (built-in, or a custom theme run through
   * `resolveCustomTheme` so every color falls back to its base). Passing an
   * unresolved custom theme risks blank swatches for any missing color.
   */
  theme: ThemeDefinition;
  /** Test hook forwarded to the preview root. */
  "data-testid"?: string;
}

/**
 * A small, self-contained swatch card summarizing a theme: its name plus the
 * four representative colors (terminal background/foreground, accent, and app
 * background) as color chips with their hex values. Used as the hover-preview
 * content for theme options in Appearance settings.
 *
 * The chip fills use the theme's own color values (data, not design tokens);
 * all surrounding chrome is driven by tokens from `variables.css`.
 */
export function ThemePreview({ theme, ...rest }: ThemePreviewProps) {
  return (
    <div className="theme-preview" data-testid={rest["data-testid"]}>
      <div className="theme-preview__name">{theme.name}</div>
      <ul className="theme-preview__swatches">
        {PREVIEW_SWATCHES.map(({ key, label }) => {
          const value = theme.colors[key];
          return (
            <li key={key} className="theme-preview__row">
              <span
                className="theme-preview__chip"
                style={{ backgroundColor: value }}
                aria-hidden="true"
              />
              <span className="theme-preview__label">{label}</span>
              <span className="theme-preview__hex">{value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
