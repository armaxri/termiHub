import { FileTypeSettings } from "./FileTypeSettings";
import { LanguagePackagesSettings } from "./LanguagePackagesSettings";
import { CustomGrammarsSettings } from "./CustomGrammarsSettings";

interface EditorSettingsSectionProps {
  visibleFields?: Set<string>;
}

/**
 * The "Editor" settings category: file-type/language mapping, installable Shiki
 * language packages, and custom TextMate grammars.
 *
 * These three panels are grouped into this single component so that
 * `SettingsPanel` can load them as one lazy chunk via `React.lazy` (PERF-001).
 * They are the only Settings panels that statically pull in Monaco / Shiki
 * (`getAvailableLanguages`, `registerAdditionalLanguagePackages`,
 * `registerCustomGrammars`, the bundled-languages metadata list); code-splitting
 * them here keeps that machinery out of the eager Settings/entry chunk, so it is
 * fetched only when the user actually opens the Editor settings category. The
 * panels themselves are unchanged — this is purely a code-split boundary.
 */
export function EditorSettingsSection({ visibleFields }: EditorSettingsSectionProps) {
  return (
    <>
      <FileTypeSettings visibleFields={visibleFields} />
      <LanguagePackagesSettings visibleFields={visibleFields} />
      <CustomGrammarsSettings visibleFields={visibleFields} />
    </>
  );
}
