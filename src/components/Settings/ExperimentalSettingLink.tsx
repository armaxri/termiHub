import { useAppStore } from "@/store/appStore";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

/** Props for {@link ExperimentalSettingLink}. */
export interface ExperimentalSettingLinkProps {
  /** Class for the inline link button; defaults to the shared empty-state link style. */
  className?: string;
  /** Test id of the link button. */
  "data-testid"?: string;
}

/**
 * Inline link that names the experimental-features toggle by its real path
 * ("Settings ▸ General ▸ Allow Experimental Features") and opens Settings ▸
 * General when clicked (#5363). Copy that refers to a surface hidden behind the
 * toggle uses this instead of naming the hidden surface as if it were visible.
 */
export function ExperimentalSettingLink({
  className = "ui-empty__link",
  "data-testid": testId,
}: ExperimentalSettingLinkProps) {
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  return (
    <button
      type="button"
      className={className}
      onClick={() => openSettingsTab({ category: "general" })}
      data-testid={testId}
    >
      {EXPERIMENTAL_SETTING_PATH}
    </button>
  );
}
