import type { PluginVersionChange } from "@/types/plugin";
import { ConfirmDialog } from "@/components/ui";

/** Props for {@link PluginVersionChangeDialog}. */
export interface PluginVersionChangeDialogProps {
  /** The version change the backend asked the user to confirm. */
  change: PluginVersionChange;
  /** Re-issue the install with the confirmation flag set. */
  onConfirm: () => Promise<void>;
  /** Abandon the replace; the installed plugin stays as it is. */
  onCancel: () => void;
}

/** Title, body and confirm-button label for one kind of risky version change. */
interface VersionChangeCopy {
  title: string;
  message: string;
  confirmLabel: string;
}

/** The installed version as displayed, tolerating an unreadable one. */
function installedLabel(change: PluginVersionChange): string {
  return change.installedVersion ?? "an unknown version";
}

/**
 * The prompt copy for a version change. Only the kinds the backend refuses
 * without confirmation reach this dialog; anything else falls back to the
 * generic "cannot compare" wording, which is the conservative reading.
 */
export function versionChangeCopy(change: PluginVersionChange): VersionChangeCopy {
  const name = change.pluginName;
  switch (change.kind) {
    case "downgrade":
      return {
        title: `Downgrade ${name}?`,
        message:
          `Replace ${name} ${installedLabel(change)} with older ${change.incomingVersion}? ` +
          "Downgrading can lose fixes or break settings saved by the newer version.",
        confirmLabel: "Downgrade",
      };
    case "sameVersionChanged":
      return {
        title: `Replace ${name} ${change.incomingVersion}?`,
        message:
          `This package is also version ${change.incomingVersion} but its contents differ ` +
          `from the installed copy of ${name}. Replace the installed build with this one?`,
        confirmLabel: "Replace",
      };
    default:
      return {
        title: `Replace ${name}?`,
        message:
          `termiHub cannot tell whether ${change.incomingVersion} is newer or older than the ` +
          `installed ${installedLabel(change)} of ${name}. Replace it anyway?`,
        confirmLabel: "Replace",
      };
  }
}

/**
 * Confirmation prompt shown when installing a package would replace an
 * installed plugin with an older version, a different build of the same
 * version, or a version that cannot be compared (PLG-012). The backend refused
 * the install and changed nothing; confirming re-issues it with the explicit
 * confirmation flag.
 */
export function PluginVersionChangeDialog({
  change,
  onConfirm,
  onCancel,
}: PluginVersionChangeDialogProps) {
  const copy = versionChangeCopy(change);
  return (
    <ConfirmDialog
      open
      variant="warn"
      title={copy.title}
      description={`Confirm replacing the installed ${change.pluginName}`}
      message={copy.message}
      confirmLabel={copy.confirmLabel}
      confirmVariant="primary"
      confirmErrorToast={false}
      testIdBase="plugin-version-change"
      data-testid="plugin-version-change-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
