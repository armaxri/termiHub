export { SettingsPanel } from "./SettingsPanel";
export { SettingsNav } from "./SettingsNav";
export { SettingsSearch } from "./SettingsSearch";
export { GeneralSettings } from "./GeneralSettings";
export { AppearanceSettings } from "./AppearanceSettings";
export { TerminalSettings } from "./TerminalSettings";
export { AccessibilitySettings } from "./AccessibilitySettings";
export { ExternalFilesSettings } from "./ExternalFilesSettings";
export { SecuritySettings } from "./SecuritySettings";
// NOTE: FileTypeSettings, LanguagePackagesSettings and CustomGrammarsSettings are
// intentionally NOT re-exported here. They statically pull in Monaco / Shiki, and
// this barrel is imported by always-eager components (SplitView, ConnectionEditor);
// without a `sideEffects: false` package flag, re-exporting them would keep that
// (side-effectful) editor machinery in the eager entry chunk even though nothing
// imports them by name from the barrel (PERF-001). They are loaded lazily by
// SettingsPanel via EditorSettingsSection; import them from their own modules.
export { CustomizeLayoutDialog } from "./CustomizeLayoutDialog";
export { LayoutPreview } from "./LayoutPreview";
