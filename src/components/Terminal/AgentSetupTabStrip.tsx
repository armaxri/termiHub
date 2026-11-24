import { useCallback, useEffect, useId } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleHelp,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { getComposedLayout } from "@/store/layoutHelpers";
import { useAgentSetupStatus, type AgentSetupTab } from "@/store/agentSetupStatus";
import { findLeafByTab } from "@/utils/panelTree";
import { Button, ContentOverlay } from "@/components/ui";
import type { TerminalExitInfo } from "@/types/terminal";
import { t } from "@/i18n/catalog";
import { DisconnectStrip, type DisconnectStripTone } from "./DisconnectStrip";
import "./TerminalDisconnectOverlay.css";

/**
 * How a setup tab's run ended, as its strip says it (#5865):
 * - `installed` — the POSIX script exited 0, or the backend found the uploaded
 *   agent running on a Windows host (#5992);
 * - `failed` — the backend reported a failure, or the POSIX script exited
 *   non-zero;
 * - `cancelled` — the user cancelled the setup;
 * - `checking` — the Windows tab's shell ended and the backend is still
 *   checking the host;
 * - `unknown` — that check could not tell.
 */
export type AgentSetupTabNotice =
  | { kind: "installed" }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" }
  | { kind: "checking" }
  | { kind: "unknown"; reason: string };

/**
 * The notice a setup tab shows, or `null` while the setup still runs, for a
 * tab that is no setup tab, and once the user dismissed it. `exit` is the
 * tab's session exit, when its session ended.
 *
 * The outcome comes from signals, never from reading the output: the backend's
 * progress events and, on POSIX only, the exit code of the shell the setup
 * script replaced (`exec sh setup.sh`). A Windows exit code is never read: the
 * server reports 0 for a failed setup too (#5992). A POSIX exit without a code
 * (a dropped link) says nothing about the setup, so the plain session-end strip
 * handles it.
 */
export function agentSetupTabNotice(
  tab: AgentSetupTab | undefined,
  exit: TerminalExitInfo | undefined
): AgentSetupTabNotice | null {
  if (!tab || tab.dismissed) return null;
  switch (tab.progress.kind) {
    case "installed":
      return { kind: "installed" };
    case "failed":
      return { kind: "failed", reason: tab.progress.message };
    case "unknown":
      return { kind: "unknown", reason: tab.progress.message };
    case "cancelled":
      return { kind: "cancelled" };
    case "running":
      break;
  }
  if (!exit) return null;
  if (!tab.reportsExit) return { kind: "checking" };
  if (exit.code === null) return null;
  return exit.code === 0
    ? { kind: "installed" }
    : { kind: "failed", reason: `The setup script exited with code ${exit.code}.` };
}

const TONES: Record<AgentSetupTabNotice["kind"], DisconnectStripTone> = {
  installed: "neutral",
  failed: "error",
  cancelled: "neutral",
  checking: "neutral",
  unknown: "neutral",
};

const HEADINGS: Record<AgentSetupTabNotice["kind"], string> = {
  installed: "Agent installed",
  failed: "Agent setup failed",
  cancelled: "Agent setup cancelled",
  checking: "Checking the agent…",
  unknown: "Agent setup outcome unknown",
};

const ICONS: Record<AgentSetupTabNotice["kind"], LucideIcon> = {
  installed: CheckCircle2,
  failed: AlertTriangle,
  cancelled: Ban,
  checking: SquareTerminal,
  unknown: CircleHelp,
};

const SCROLLBACK_KEPT = t("drop.overlay.scrollbackKept");

/** The strip's line under the heading. */
function subheadingFor(notice: AgentSetupTabNotice, agentName: string): string {
  switch (notice.kind) {
    case "installed":
      return `Connect "${agentName}" from the sidebar. ${SCROLLBACK_KEPT}`;
    case "failed":
      return `The output below says what went wrong. ${SCROLLBACK_KEPT}`;
    case "cancelled":
      return `Nothing more runs in this tab. ${SCROLLBACK_KEPT}`;
    case "checking":
      return "The setup ended. termiHub is checking whether the agent was installed.";
    case "unknown":
      return `Check the output below. ${SCROLLBACK_KEPT}`;
  }
}

interface AgentSetupTabStripProps {
  tabId: string;
  /** The notice to show (from {@link agentSetupTabNotice}). */
  notice: AgentSetupTabNotice;
  /** Whether the tab's session ended (its shell is gone). */
  exited: boolean;
  /** Whether this tab is the visible one: only then is focus moved to Close tab. */
  isActive?: boolean;
}

/**
 * The finished state of an agent setup tab (#5865): the session-end strip of
 * #5908 at the top of the pane, saying whether the agent was installed, the
 * setup failed or was cancelled, with **Close tab**. The tab is never closed
 * on its own, not even on success: the output says which version went where,
 * and a tab vanishing under the user is a surprise. The strip is the pane's
 * only toast keep-clear zone. Dismissing it ("x") leaves the scrollback (or
 * the live shell) in view.
 */
export function AgentSetupTabStrip({
  tabId,
  notice,
  exited,
  isActive = false,
}: AgentSetupTabStripProps) {
  const reasonId = useId();
  const tab = useAgentSetupStatus((s) => s.tabs[tabId]);
  const dismissSetupTab = useAgentSetupStatus((s) => s.dismissSetupTab);
  const clearAgentPhase = useAgentSetupStatus((s) => s.clear);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const closeTab = useAppStore((s) => s.closeTab);
  const agentId = tab?.agentId;
  const agentName = tab?.agentName ?? "";

  // A script that failed after it started leaves the agent row's "installed"
  // phase behind (the backend's "done" only means the script started): drop
  // it, so the row no longer reads as freshly installed.
  useEffect(() => {
    if (notice.kind === "failed" && agentId) clearAgentPhase(agentId);
  }, [notice.kind, agentId, clearAgentPhase]);

  const handleClose = useCallback(() => {
    const leaf = findLeafByTab(getComposedLayout(useAppStore.getState()).rootPanel, tabId);
    if (leaf) closeTab(tabId, leaf.id);
  }, [tabId, closeTab]);

  const handleDismiss = useCallback(() => {
    dismissSetupTab(tabId);
    // An ended session goes on to view mode, like any dismissed end strip.
    if (exited) dismissTerminalDisconnect(tabId);
  }, [tabId, exited, dismissSetupTab, dismissTerminalDisconnect]);

  const heading = HEADINGS[notice.kind];
  const reason = "reason" in notice ? notice.reason : "";
  const Icon = ICONS[notice.kind];
  const iconTone =
    notice.kind === "failed" ? "error" : notice.kind === "installed" ? "success" : "ended";

  return (
    <DisconnectStrip
      variant={`agent-setup-${notice.kind}`}
      tone={TONES[notice.kind]}
      onDismiss={handleDismiss}
      dismissLabel={exited ? "Dismiss and view scrollback" : "Dismiss setup notice"}
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        data-testid="agent-setup-tab-strip"
        icon={
          <Icon
            size={16}
            className={`terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--${iconTone}`}
          />
        }
        heading={heading}
        subheading={subheadingFor(notice, agentName)}
        announce={notice.kind === "failed" ? "assertive" : "polite"}
        announcement={reason ? `${heading}. ${reason}` : undefined}
        describedBy={reason ? reasonId : undefined}
        // A live shell (a failure before the setup ran) keeps its
        // focus: the user may be typing in it.
        autoFocusPrimaryAction={isActive && exited}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<X size={14} />}
            onClick={handleClose}
            data-testid="agent-setup-tab-close-btn"
          >
            Close tab
          </Button>
        }
      >
        {reason && (
          <div
            className="terminal-disconnect-overlay__error-box"
            data-testid="agent-setup-tab-reason"
          >
            <span id={reasonId} className="terminal-disconnect-overlay__error-text">
              {reason}
            </span>
          </div>
        )}
      </ContentOverlay>
    </DisconnectStrip>
  );
}
