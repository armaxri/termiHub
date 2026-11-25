import { useEffect } from "react";
import { Hand, KeyRound } from "lucide-react";
import { Button } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { getActiveTab, useAppStore } from "@/store/appStore";
import { useLayoutRenderTree, useLayoutTabGroups } from "@/store/layoutSelectors";
import {
  SHOW_WAITING_TERMINAL_EVENT,
  type AutomationWait,
} from "@/store/slices/automationWaitSlice";
import { useProjectedSessionLifecycleMaps } from "@/store/useSessionLifecycle";
import { formatTimeOfDay } from "@/utils/formatters";
import { showTerminal } from "@/utils/showTerminal";
import "./WaitingRunBar.css";

/** What to do now: in the terminal, or first to see it. */
function waitText(wait: AutomationWait, hidden: boolean): string {
  const message = wait.message?.trim().replace(/[.!]+$/, "");
  const password = message === t("automation.wait.password");
  if (hidden) {
    if (password) return t("automation.wait.passwordHidden");
    return message ? tf("automation.wait.hidden", { message }) : t("automation.wait.messageHidden");
  }
  if (wait.checking) return t("automation.wait.checking");
  if (wait.elsewhere) return t("automation.wait.elsewhere");
  if (wait.unchecked) return t("automation.wait.unchecked");
  if (wait.stillAsking) return t("automation.wait.stillAsking");
  if (wait.answered) return t("automation.wait.answered");
  if (password) return t("automation.wait.passwordThen");
  return message ? tf("automation.wait.then", { message }) : t("automation.wait.messageThen");
}

/**
 * The strip above the terminals while an automation waits for the user (#6025):
 * which one, where, what to do there, and Continue and Stop. The terminal keeps
 * the focus, so the user types at once. While the terminal does not show, the bar offers to show
 * it and nothing else. Nothing but Continue goes on, and not while the terminal still
 * shows a password prompt unless it is pressed again.
 */
export function WaitingRunBar() {
  const waits = useAppStore((s) => s.automationWaits);
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id);
  const continueWait = useAppStore((s) => s.continueAutomationWait);
  const stop = useAppStore((s) => s.cancelWorkflowRun);
  const recheck = useAppStore((s) => s.recheckWaitingPrompts);
  const follow = useAppStore((s) => s.followWaitingTerminals);
  // A change of the layout or of a session may be the end of the terminal.
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const lifecycle = useProjectedSessionLifecycleMaps();
  const waiting = waits.length > 0;
  useEffect(() => {
    if (waiting) follow();
  }, [waiting, follow, rootPanel, tabGroups, lifecycle]);

  // Once the password is typed, Continue is the way on, and the bar says so.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(recheck, 500);
    return () => window.clearInterval(timer);
  }, [waiting, recheck]);

  useEffect(() => {
    const onShow = (e: Event) => showTerminal((e as CustomEvent<{ tabId: string }>).detail.tabId);
    window.addEventListener(SHOW_WAITING_TERMINAL_EVENT, onShow);
    return () => window.removeEventListener(SHOW_WAITING_TERMINAL_EVENT, onShow);
  }, []);

  if (!waiting) return null;
  return (
    <div className="waiting-runs" data-testid="automation-waits">
      {waits.map((wait) => {
        const hidden = wait.tabId !== activeTabId;
        const insist = wait.stillAsking || wait.unchecked === true;
        return (
          <div
            key={wait.runId}
            className="waiting-run"
            role="group"
            aria-label={tf("automation.wait.title", {
              name: wait.automationName,
              tab: wait.tabTitle,
            })}
            data-testid={`automation-wait-${wait.tabId}`}
          >
            {wait.stillAsking ? (
              <KeyRound size={14} aria-hidden="true" />
            ) : (
              <Hand size={14} aria-hidden="true" />
            )}
            <span className="waiting-run__text" role="status">
              <span className="waiting-run__title">
                {tf("automation.wait.title", { name: wait.automationName, tab: wait.tabTitle })}
              </span>{" "}
              <span data-testid={`automation-wait-message-${wait.tabId}`}>
                {waitText(wait, hidden)}
              </span>{" "}
              <span>
                {tf("automation.wait.until", { time: formatTimeOfDay(new Date(wait.until)) })}
              </span>
            </span>
            <span className="waiting-run__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => stop(wait.runId)}
                data-testid={`automation-wait-stop-${wait.tabId}`}
              >
                Stop
              </Button>
              {/* Continue types into a terminal: only with that terminal in view (B-001). */}
              {hidden ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => showTerminal(wait.tabId)}
                  data-testid={`automation-wait-show-${wait.tabId}`}
                >
                  {tf("automation.wait.show", { tab: wait.tabTitle })}
                </Button>
              ) : (
                <Button
                  variant={insist ? "secondary" : "primary"}
                  size="sm"
                  disabled={wait.checking === true}
                  onClick={() => continueWait(wait.runId)}
                  data-testid={`automation-wait-continue-${wait.tabId}`}
                >
                  {insist ? "Continue anyway" : "Continue"}
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
