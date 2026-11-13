import { createContext, useContext } from "react";
import { Check } from "lucide-react";

/**
 * Inline "Saved" feedback for auto-saved settings (#5562).
 *
 * The panel auto-saves after a short debounce. Its acknowledgment used to sit
 * in the build-info footer, far from the control that changed. Each
 * {@link SettingsField} now tags its wrapper with {@link SETTINGS_FIELD_ATTR};
 * the panel remembers which field the user last interacted with and, once the
 * save lands, names it here so that field shows the tick beside its label.
 */

/** Wrapper attribute carrying a {@link SettingsField}'s id. */
export const SETTINGS_FIELD_ATTR = "data-settings-field";

/** The field currently acknowledging a save, or `null` for none. */
export const SettingsSavedFieldContext = createContext<string | null>(null);

/** The id of the field showing the "Saved" tick right now, or `null`. */
export function useSavedFieldId(): string | null {
  return useContext(SettingsSavedFieldContext);
}

/**
 * The {@link SettingsField} id that owns `node`, if `node` sits inside a field
 * within `container`. Nodes outside `container` (e.g. a select's portalled
 * option list) yield `undefined`, so the caller can keep its last answer.
 */
export function settingsFieldIdFor(
  node: EventTarget | null,
  container: HTMLElement | null
): string | null | undefined {
  if (!container || !(node instanceof Element) || !container.contains(node)) return undefined;
  return node.closest(`[${SETTINGS_FIELD_ATTR}]`)?.getAttribute(SETTINGS_FIELD_ATTR) ?? null;
}

/**
 * The visual tick shown beside a field's label. Decorative: the panel's
 * persistent live region announces the save to assistive tech.
 */
export function SettingsSavedMark() {
  return (
    <span
      className="settings-panel__saved-mark"
      data-testid="settings-saved-mark"
      aria-hidden="true"
    >
      <Check size={12} />
      Saved
    </span>
  );
}
