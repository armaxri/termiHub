import { useState } from "react";
import { ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import "./SessionRestoreDialog.css";

/**
 * Startup "Restore Previous Session?" dialog shown when the restore mode is
 * `ask` and a previous session is stored (see `resolveRestoreMode`).
 *
 * Self-contained: it reads the pending {@link RestorePrompt} from the store and
 * resolves it through `confirmRestorePrompt` / `dismissRestorePrompt`. The
 * "Remember my choice" opt-out persists the mode (`always` on Restore, `never`
 * on Start Fresh) so the dialog is not shown again.
 *
 * Composes the shared {@link ConfirmDialog}: "Restore" is the primary confirm,
 * "Start Fresh" is the cancel, and the opt-out rides the `dontAskAgain` slot.
 */
export function SessionRestoreDialog(): React.ReactElement | null {
  const restorePrompt = useAppStore((s) => s.restorePrompt);
  const confirmRestorePrompt = useAppStore((s) => s.confirmRestorePrompt);
  const dismissRestorePrompt = useAppStore((s) => s.dismissRestorePrompt);
  const [remember, setRemember] = useState(false);

  if (!restorePrompt) return null;

  const { tabCount, tabs } = restorePrompt;
  const tabWord = tabCount === 1 ? "tab" : "tabs";

  return (
    <ConfirmDialog
      open
      title="Restore Previous Session?"
      description="Choose whether to reopen the tabs from your previous session."
      message={`You had ${tabCount} ${tabWord} open when termiHub last closed:`}
      confirmLabel="Restore"
      cancelLabel="Start Fresh"
      confirmVariant="primary"
      confirmErrorToast={false}
      dontAskAgain={{
        checked: remember,
        onChange: setRemember,
        label: "Remember my choice",
        "data-testid": "session-restore-remember",
      }}
      testIdBase="session-restore"
      onConfirm={() => confirmRestorePrompt(remember)}
      onCancel={() => dismissRestorePrompt(remember)}
      data-testid="session-restore-dialog"
    >
      <ul className="session-restore__tabs" data-testid="session-restore-tabs">
        {tabs.map((tab, index) => (
          <li key={index} className="session-restore__tab">
            <span className="session-restore__tab-title">{tab.title}</span>
            <span className="session-restore__tab-type">{tab.typeLabel}</span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
