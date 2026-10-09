import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";

/**
 * App-level confirmation shown before a workspace launch tears down live
 * sessions (UX-026 / UX2-002). Renders the store's `pendingWorkspaceLaunch`,
 * raised by `requestLaunchWorkspace` — the one guarded entry point the sidebar,
 * command palette and forwarded `--workspace` all call — so no launch path can
 * skip it. Renders nothing when no launch is pending.
 */
export function ConfirmWorkspaceLaunchDialog() {
  const pending = useAppStore((s) => s.pendingWorkspaceLaunch);
  const setPending = useAppStore((s) => s.setPendingWorkspaceLaunch);
  const launchWorkspace = useAppStore((s) => s.launchWorkspace);

  if (!pending) return null;

  const handleConfirm = () => {
    setPending(null);
    void launchWorkspace(pending.id);
  };

  return (
    <ConfirmDialog
      open
      variant="danger"
      title="Close live sessions?"
      message={
        `Launching "${pending.name}" will close ${pending.count} open ` +
        `session${pending.count === 1 ? "" : "s"} and replace your current layout. Continue?`
      }
      confirmLabel="Launch"
      confirmVariant="danger"
      testIdBase="confirm-launch-workspace"
      data-testid="confirm-launch-workspace-dialog"
      onConfirm={handleConfirm}
      onCancel={() => setPending(null)}
    />
  );
}
