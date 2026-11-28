/**
 * When the Settings panel shows its page list as the icon rail (#6153): below
 * this panel width the form column next to a labelled list is cramped, as at
 * the 800×600 minimum window with the sidebar open.
 */
export const SETTINGS_COMPACT_BELOW_PX = 640;

/** Whether a Settings panel `width` px wide shows the icon rail. */
export function isCompactSettingsWidth(width: number): boolean {
  return width < SETTINGS_COMPACT_BELOW_PX;
}
