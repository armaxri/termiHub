import { ArrowRight } from "lucide-react";
import { Checkbox } from "@/components/ui";
import type { AppSettings, MobaxtermGlobalAppearance } from "@/types/connection";
import {
  appearanceChanges,
  type GlobalAppearanceOptIn,
  MOBAXTERM_THEME_NAME,
} from "@/services/mobaxtermGlobalAppearance";
import { dedupeThemeName } from "@/themes/customThemes";

interface MobaxtermGlobalAppearanceSectionProps {
  /** MobaXterm's parsed global colours, font and cursor. */
  global: MobaxtermGlobalAppearance;
  /** termiHub's current settings, for the theme name and the before values. */
  settings: AppSettings;
  /** Which parts the user opted in to (both off by default). */
  optIn: GlobalAppearanceOptIn;
  onOptInChange: (optIn: GlobalAppearanceOptIn) => void;
}

/**
 * The global-appearance step of the MobaXterm import (#4880). Two separate,
 * off-by-default opt-ins: create a new custom theme from MobaXterm's
 * `[Colors]` (previewed as swatches, never overwriting an existing theme), and
 * apply its global font family, size and cursor style — listed as
 * before → after so the user sees exactly what will change.
 */
export function MobaxtermGlobalAppearanceSection({
  global,
  settings,
  optIn,
  onOptInChange,
}: MobaxtermGlobalAppearanceSectionProps) {
  const colors = global.colors;
  const changes = appearanceChanges(global, settings);
  if (!colors && changes.length === 0) return null;
  const themeName = dedupeThemeName(MOBAXTERM_THEME_NAME, settings.customThemes ?? []);
  const swatches = colors ? [colors.background, colors.foreground, ...colors.ansi] : [];

  return (
    <section className="mobaxterm-import__hostkeys" data-testid="mobaxterm-import-appearance">
      <h3 className="mobaxterm-import__skipped-title">Global appearance</h3>
      {colors && (
        <>
          <label className="bulk-ssh-import__selectall">
            <Checkbox
              checked={optIn.theme}
              onCheckedChange={(v) => onOptInChange({ ...optIn, theme: v === true })}
              data-testid="mobaxterm-import-theme-optin"
            />
            <span className="bulk-ssh-import__selectall-label">
              Create the theme “{themeName}” from MobaXterm’s colours and use it
            </span>
          </label>
          <div
            className="mobaxterm-import__swatches"
            aria-hidden
            data-testid="mobaxterm-import-theme-swatches"
          >
            {swatches.map((color, i) => (
              <span
                key={i}
                className="mobaxterm-import__swatch"
                style={color ? { backgroundColor: color } : undefined}
                data-empty={color ? undefined : "true"}
              />
            ))}
          </div>
          <p className="mobaxterm-import__reason mobaxterm-import__hostkeys-hint">
            A new theme is added; your existing themes are not changed.
          </p>
        </>
      )}
      {changes.length > 0 && (
        <>
          <label className="bulk-ssh-import__selectall">
            <Checkbox
              checked={optIn.appearance}
              onCheckedChange={(v) => onOptInChange({ ...optIn, appearance: v === true })}
              data-testid="mobaxterm-import-appearance-optin"
            />
            <span className="bulk-ssh-import__selectall-label">
              Use MobaXterm’s terminal font and cursor
            </span>
          </label>
          <ul
            className="mobaxterm-import__changes"
            data-testid="mobaxterm-import-appearance-changes"
          >
            {changes.map((change) => (
              <li key={change.key} className="mobaxterm-import__change">
                <span className="mobaxterm-import__change-label">{change.label}</span>
                <span>{change.before}</span>
                <ArrowRight size={12} aria-label="becomes" />
                <span className="mobaxterm-import__change-after">{change.after}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
