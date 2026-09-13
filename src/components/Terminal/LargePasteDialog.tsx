import { ConfirmDialog } from "@/components/ui";
import { resolveUiLocale } from "@/utils/locale";

interface LargePasteDialogProps {
  open: boolean;
  charCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog shown when pasting text larger than the threshold.
 * Composes the shared {@link ConfirmDialog} primitive so it inherits the
 * safe-default focus/Enter wiring and standard footer.
 */
export function LargePasteDialog({ open, charCount, onConfirm, onCancel }: LargePasteDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Large Paste"
      message={`You are about to paste ${charCount.toLocaleString(
        resolveUiLocale()
      )} characters into the terminal. Are you sure?`}
      confirmLabel="Paste"
      confirmVariant="primary"
      testIdBase="large-paste"
      data-testid="large-paste-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
