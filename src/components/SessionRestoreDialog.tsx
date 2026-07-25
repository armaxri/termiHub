import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Checkbox, ConfirmDialog } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import type { RestoreTabInfo } from "@/utils/restoreMode";
import "./SessionRestoreDialog.css";

/**
 * Whether a tab is selected for restore. Defaults follow reachability — an
 * unreachable target starts unchecked (per the concept mockups) — but an
 * explicit user toggle in `overrides` always wins. Because reachability arrives
 * asynchronously, deriving the default this way lets tabs the user has not
 * touched flip to reflect a late "unreachable" result without an effect.
 */
function isTabChecked(tab: RestoreTabInfo, override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  return tab.reachability !== "unreachable";
}

/**
 * Startup "Restore Previous Session?" dialog shown when the restore mode is
 * `ask` and a previous session is stored (see `resolveRestoreMode`).
 *
 * Self-contained: it reads the pending {@link RestorePrompt} from the store and
 * resolves it through `confirmRestorePrompt` / `dismissRestorePrompt`. The
 * "Remember my choice" opt-out persists the mode (`always` on Restore, `never`
 * on Start Fresh) so the dialog is not shown again.
 *
 * Per-tab selection (#1931): each tab has a checkbox so the user restores only a
 * subset; the chosen indices are passed to `confirmRestorePrompt`. Tabs whose
 * connection target is unavailable (device offline / host unreachable) show a
 * warning icon and start unchecked.
 *
 * Composes the shared {@link ConfirmDialog}: "Restore" is the primary confirm,
 * "Start Fresh" is the cancel, and the opt-out rides the `dontAskAgain` slot.
 */
export function SessionRestoreDialog(): React.ReactElement | null {
  const restorePrompt = useAppStore((s) => s.restorePrompt);
  const confirmRestorePrompt = useAppStore((s) => s.confirmRestorePrompt);
  const dismissRestorePrompt = useAppStore((s) => s.dismissRestorePrompt);
  const [remember, setRemember] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});

  if (!restorePrompt) return null;

  const { tabCount, tabs } = restorePrompt;
  const tabWord = tabCount === 1 ? "tab" : "tabs";

  const selectedIndices = tabs
    .map((_, i) => i)
    .filter((i) => isTabChecked(tabs[i], overrides[i]));
  const selectedCount = selectedIndices.length;
  const confirmLabel =
    selectedCount === tabCount ? "Restore" : `Restore ${selectedCount} Selected`;

  return (
    <ConfirmDialog
      open
      title="Restore Previous Session?"
      description="Choose which tabs to reopen from your previous session."
      message={`You had ${tabCount} ${tabWord} open when termiHub last closed:`}
      confirmLabel={confirmLabel}
      cancelLabel="Start Fresh"
      confirmVariant="primary"
      confirmErrorToast={false}
      confirmDisabled={selectedCount === 0}
      dontAskAgain={{
        checked: remember,
        onChange: setRemember,
        label: "Remember my choice",
        "data-testid": "session-restore-remember",
      }}
      testIdBase="session-restore"
      onConfirm={() => confirmRestorePrompt(remember, selectedIndices)}
      onCancel={() => dismissRestorePrompt(remember)}
      data-testid="session-restore-dialog"
    >
      <ul className="session-restore__tabs" data-testid="session-restore-tabs">
        {tabs.map((tab, index) => {
          const checked = isTabChecked(tab, overrides[index]);
          const unreachable = tab.reachability === "unreachable";
          return (
            <li
              key={index}
              className="session-restore__tab"
              data-testid={`session-restore-tab-${index}`}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  setOverrides((prev) => ({ ...prev, [index]: next }))
                }
                aria-label={`Restore ${tab.title}`}
                data-testid={`session-restore-tab-checkbox-${index}`}
              />
              <span className="session-restore__tab-title">{tab.title}</span>
              {unreachable && (
                <span
                  className="session-restore__tab-warning"
                  data-testid={`session-restore-tab-warning-${index}`}
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span className="session-restore__tab-warning-text">
                    {tab.unreachableReason ?? "unavailable"}
                  </span>
                </span>
              )}
              <span className="session-restore__tab-type">{tab.typeLabel}</span>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
