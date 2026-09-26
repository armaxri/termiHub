import { ConfirmDialog } from "@/components/ui";
import { resolveUiLocale } from "@/utils/locale";

interface LargePasteDialogProps {
  open: boolean;
  charCount: number;
  /**
   * Set (> 1) for a multi-line paste that broadcast input would send to several
   * terminals at once (#3443). The dialog then leads with the target count.
   */
  broadcastTargetCount?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog shown before a risky paste: text larger than the
 * threshold, or a multi-line paste that broadcast input would fan out to several
 * terminals (where every line may run as a command on every host). Composes the
 * shared {@link ConfirmDialog} primitive so it inherits the safe-default
 * focus/Enter wiring (Cancel focused on open) and standard footer.
 */
export function LargePasteDialog({
  open,
  charCount,
  broadcastTargetCount,
  onConfirm,
  onCancel,
}: LargePasteDialogProps) {
  const chars = charCount.toLocaleString(resolveUiLocale());
  const isBroadcast = broadcastTargetCount !== undefined && broadcastTargetCount > 1;
  return (
    <ConfirmDialog
      open={open}
      title={isBroadcast ? `Paste to ${broadcastTargetCount} terminals?` : "Large Paste"}
      variant={isBroadcast ? "warn" : "default"}
      message={
        isBroadcast
          ? `Broadcast is on: this multi-line paste (${chars} characters) will be sent to ${broadcastTargetCount} terminals at once, and each line may run as a command on every one of them.`
          : `You are about to paste ${chars} characters into the terminal. Are you sure?`
      }
      confirmLabel={isBroadcast ? `Paste to ${broadcastTargetCount} terminals` : "Paste"}
      confirmVariant={isBroadcast ? "danger" : "primary"}
      testIdBase="large-paste"
      data-testid="large-paste-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
