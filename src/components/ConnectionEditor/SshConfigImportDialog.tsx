import { Modal } from "@/components/ui";
import type { JumpHostConfig } from "@/types/connection";
import "./SshConfigImportDialog.css";

interface SshConfigImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the selected host's resolved hop chain. */
  onImport: (hops: JumpHostConfig[]) => void;
}

/**
 * Picker for importing a `ProxyJump` chain from the user's `~/.ssh/config`
 * (#1702). Implemented in the follow-up feat commit; this stub only renders the
 * dialog shell so the tests have a mount point.
 */
export function SshConfigImportDialog({ open, onOpenChange }: SshConfigImportDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import from ~/.ssh/config"
      data-testid="ssh-config-import-dialog"
    >
      <p className="ssh-config-import__status" data-testid="ssh-config-import-loading">
        Reading ~/.ssh/config…
      </p>
    </Modal>
  );
}
