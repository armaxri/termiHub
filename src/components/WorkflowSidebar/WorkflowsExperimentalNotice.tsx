import { FlaskConical, Settings } from "lucide-react";
import { Button } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

/** The notice's sentence: workflows are still behind the experimental switch (#5954). */
export const WORKFLOWS_EXPERIMENTAL_TEXT = "Workflows are still experimental and turned off.";

/** The notice's one action, which opens Settings ▸ General (#5954). */
export const WORKFLOWS_EXPERIMENTAL_ACTION = "Turn on in Settings";

/**
 * The experimental note for the Workflows view (#5954).
 *
 * Workflows are the one sidebar view still behind Settings ▸ General ▸ Allow
 * experimental features. The note lives here, in the view it is about, and not
 * in the Connections empty state, where it read as if connections needed the
 * switch (#5938 placed it there). It shows only while the switch is off — the
 * view stays open when the user turns the switch off while on it. Its one
 * action is a real secondary button, not plain text, and opens the General
 * category, where the switch is.
 */
export function WorkflowsExperimentalNotice() {
  const experimental = useExperimentalFeatures();
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  if (experimental) return null;

  return (
    <div className="workflow-sidebar__experimental" data-testid="workflow-experimental-notice">
      <p className="workflow-sidebar__experimental-text" data-testid="workflow-experimental-text">
        <FlaskConical
          size={14}
          aria-hidden="true"
          className="workflow-sidebar__experimental-icon"
        />
        {WORKFLOWS_EXPERIMENTAL_TEXT}
      </p>
      <Button
        variant="secondary"
        size="sm"
        icon={<Settings size={14} />}
        className="workflow-sidebar__experimental-action"
        title={`Opens ${EXPERIMENTAL_SETTING_PATH}`}
        onClick={() => openSettingsTab({ category: "general" })}
        data-testid="workflow-experimental-action"
      >
        {WORKFLOWS_EXPERIMENTAL_ACTION}
      </Button>
    </div>
  );
}
