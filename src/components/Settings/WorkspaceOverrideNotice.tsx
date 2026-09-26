import { Layers } from "lucide-react";

import { Button, toast } from "@/components/ui";
import {
  clearWorkspaceOverride,
  isOverriddenByWorkspace,
  useActiveWorkspace,
  type WorkspaceOverridableKey,
} from "@/services/workspaceSettings";
import { errorMessage } from "@/utils/errorMessage";
import "./WorkspaceOverrideNotice.css";

interface WorkspaceOverrideNoticeProps {
  /** The global setting the active workspace may override. */
  settingKey: WorkspaceOverridableKey;
  /** Human label of the setting, used in the reset feedback. */
  label: string;
}

/**
 * "Overridden in workspace X" indicator for a global setting (PROD-052). Shown
 * only while the active workspace overrides `settingKey`; the global value below
 * it is still editable but does not take effect until the override is reset.
 */
export function WorkspaceOverrideNotice({ settingKey, label }: WorkspaceOverrideNoticeProps) {
  const workspace = useActiveWorkspace();

  if (!workspace || !isOverriddenByWorkspace(workspace, settingKey)) return null;

  const handleReset = async () => {
    try {
      await clearWorkspaceOverride(workspace.id, settingKey);
      toast.success(`${label} now follows the global setting`);
    } catch (err) {
      throw new Error(`Could not reset the workspace override: ${errorMessage(err)}`);
    }
  };

  return (
    <div
      className="workspace-override-notice"
      role="status"
      data-testid={`workspace-override-${settingKey}`}
    >
      <Layers className="workspace-override-notice__icon" size={13} aria-hidden="true" />
      <span className="workspace-override-notice__text">
        Overridden in workspace <strong>{workspace.name}</strong> — the value below applies when
        no workspace overrides it.
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={handleReset}
        data-testid={`workspace-override-reset-${settingKey}`}
      >
        Reset to global
      </Button>
    </div>
  );
}
