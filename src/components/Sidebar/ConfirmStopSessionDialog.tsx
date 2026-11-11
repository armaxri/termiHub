import { ConfirmDialog } from "@/components/ui";

interface ConfirmStopSessionDialogProps {
  /** Name of the persistent session pending a stop, or null when idle. */
  name: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The confirmation text for stopping the persistent session `name` (#5375). */
export function stopSessionMessage(name: string): string {
  return `Stop "${name}"? It is running in the background and will end.`;
}

/**
 * Confirm before stopping a persistent (background) session (#5375). Such a
 * session exists so that it survives closing its tabs, so a single click must
 * not end it. Shared by the connection tree, the agent tree and the Open
 * Connections panel so every Stop asks the same question.
 */
export function ConfirmStopSessionDialog({
  name,
  onConfirm,
  onCancel,
}: ConfirmStopSessionDialogProps) {
  return (
    <ConfirmDialog
      open={name !== null}
      title="Stop background session?"
      variant="danger"
      message={name !== null ? stopSessionMessage(name) : ""}
      confirmLabel="Stop session"
      confirmVariant="danger"
      testIdBase="confirm-stop-session"
      data-testid="confirm-stop-session-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
