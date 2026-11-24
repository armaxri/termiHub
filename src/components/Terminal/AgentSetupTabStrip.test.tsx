/**
 * The agent setup tab says when its setup is over (#5865).
 *
 * After a setup the tab stayed open as a plain shell, with no sign whether
 * the agent was installed. The tab now shows the session-end strip of #5908:
 * installed, failed, cancelled, or (a tab that cannot report) commands sent,
 * each with Close tab. The outcome comes from the progress events and the
 * exit code of the shell the setup ends (POSIX `exec`, Windows `exit`, #5946),
 * never from the terminal output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentSetupTabStrip, agentSetupTabNotice, withSetupOutcome } from "./AgentSetupTabStrip";
import { TOP_NOTICE_INSET_VAR } from "./topNoticeInset";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import { useAgentSetupStatus, type AgentSetupTab } from "@/store/agentSetupStatus";
import type { TerminalExitInfo } from "@/types/terminal";

vi.mock("@/utils/panelTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/panelTree")>()),
  findLeafByTab: () => ({ id: "panel-1" }),
}));

const TAB = "tab-setup";

function setupTab(overrides: Partial<AgentSetupTab> = {}): AgentSetupTab {
  return {
    agentId: "agent-1",
    agentName: "build-box",
    reportsExit: true,
    progress: { kind: "running" },
    dismissed: false,
    ...overrides,
  };
}

const exit = (code: number | null): TerminalExitInfo => ({
  code,
  reason: code === null ? "dropped" : "clean",
});

describe("withSetupOutcome (#5980)", () => {
  it.each(["disconnected", "exited"] as const)(
    "reads a %s setup that exited 0 as finished",
    (s) => {
      expect(withSetupOutcome(s, setupTab(), exit(0))).toBe("finished");
      // Also after the user closed the strip.
      expect(withSetupOutcome(s, setupTab({ dismissed: true }), exit(0))).toBe("finished");
    }
  );

  it.each(["disconnected", "exited"] as const)(
    "keeps the red plug for a %s setup that did not",
    (s) => {
      const cancelled = setupTab({ progress: { kind: "cancelled" } });
      const failed = setupTab({ progress: { kind: "failed", message: "no" } });
      expect(withSetupOutcome(s, setupTab(), exit(2))).toBe("disconnected");
      expect(withSetupOutcome(s, cancelled, exit(0))).toBe("disconnected");
      expect(withSetupOutcome(s, failed, exit(0))).toBe("disconnected");
    }
  );

  it("keeps the status of a dropped link, a live setup and other tabs", () => {
    expect(withSetupOutcome("disconnected", setupTab(), exit(null))).toBe("disconnected");
    expect(withSetupOutcome("connected", setupTab(), undefined)).toBe("connected");
    expect(withSetupOutcome("exited", undefined, exit(0))).toBe("exited");
    expect(withSetupOutcome("disconnected", undefined, exit(0))).toBe("disconnected");
  });
});

describe("agentSetupTabNotice (#5865)", () => {
  it("shows nothing while the setup runs, for other tabs and once dismissed", () => {
    expect(agentSetupTabNotice(undefined, exit(0))).toBeNull();
    expect(agentSetupTabNotice(setupTab(), undefined)).toBeNull();
    expect(agentSetupTabNotice(setupTab({ dismissed: true }), exit(0))).toBeNull();
  });

  it("reads a POSIX run's outcome from the exit code of the shell it ended", () => {
    expect(agentSetupTabNotice(setupTab(), exit(0))).toEqual({ kind: "installed" });
    expect(agentSetupTabNotice(setupTab(), exit(1))).toEqual({
      kind: "failed",
      reason: "The setup script exited with code 1.",
    });
  });

  it("leaves a dropped link (no exit code) to the plain session-end strip", () => {
    expect(agentSetupTabNotice(setupTab(), exit(null))).toBeNull();
  });

  it("a backend failure or a cancel wins over a later exit", () => {
    const failed = setupTab({ progress: { kind: "failed", message: "SFTP connection failed" } });
    expect(agentSetupTabNotice(failed, undefined)).toEqual({
      kind: "failed",
      reason: "SFTP connection failed",
    });
    // The error script exits 1 after the failure was reported.
    expect(agentSetupTabNotice(failed, exit(0))).toEqual({
      kind: "failed",
      reason: "SFTP connection failed",
    });
    expect(agentSetupTabNotice(setupTab({ progress: { kind: "cancelled" } }), exit(0))).toEqual({
      kind: "cancelled",
    });
  });

  it("a tab that cannot report only says its commands were sent, even after an exit", () => {
    const silent = setupTab({ reportsExit: false, progress: { kind: "sent" } });
    expect(agentSetupTabNotice(silent, undefined)).toEqual({ kind: "sent" });
    expect(agentSetupTabNotice(silent, exit(0))).toEqual({ kind: "sent" });
  });
});

describe("AgentSetupTabStrip (#5865)", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const closeTab = vi.fn();
  const dismissTerminalDisconnect = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    host.className = "terminal-context-trigger";
    document.body.appendChild(host);
    root = createRoot(host);
    closeTab.mockReset();
    dismissTerminalDisconnect.mockReset();
    useAppStore.setState({ closeTab, dismissTerminalDisconnect });
    useAgentSetupStatus.setState({
      phases: { "agent-1": "installed" },
      tabs: { [TAB]: setupTab() },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(exitInfo: TerminalExitInfo | undefined, exited = exitInfo !== undefined) {
    const notice = agentSetupTabNotice(useAgentSetupStatus.getState().tabs[TAB], exitInfo);
    expect(notice).not.toBeNull();
    act(() =>
      root.render(
        withTooltip(<AgentSetupTabStrip tabId={TAB} notice={notice!} exited={exited} isActive />)
      )
    );
    const strip = host.querySelector<HTMLElement>("[data-testid='terminal-disconnect-overlay']");
    expect(strip).not.toBeNull();
    return strip!;
  }

  const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

  it("an installed agent reads 'Agent installed' with Close tab, in a top strip", () => {
    const strip = render(exit(0));
    expect(strip.dataset.variant).toBe("agent-setup-installed");
    expect(strip.classList).toContain("terminal-disconnect-strip");
    expect(strip.classList).toContain("terminal-disconnect-strip--neutral");
    expect(q("agent-setup-tab-strip")?.textContent).toContain("Agent installed");
    expect(strip.textContent).toContain('Connect "build-box" from the sidebar.');
    expect(q("agent-setup-tab-close-btn")?.textContent).toBe("Close tab");
    expect(q("agent-setup-tab-reason")).toBeNull();
    // The terminal is pushed down below it.
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toMatch(/^\d+px$/);
  });

  it("only the strip is a toast keep-clear zone", () => {
    const strip = render(exit(0));
    const avoid = host.querySelectorAll("[data-toast-avoid]");
    expect(avoid).toHaveLength(1);
    expect(avoid[0]).toBe(strip);
  });

  it("moves focus to Close tab once the shell is gone", () => {
    render(exit(0));
    expect(document.activeElement).toBe(q("agent-setup-tab-close-btn"));
  });

  it("Close tab closes the setup tab in its panel", () => {
    render(exit(0));
    act(() => q("agent-setup-tab-close-btn")!.click());
    expect(closeTab).toHaveBeenCalledWith(TAB, "panel-1");
  });

  it("a failed script is an error strip with the reason, and drops the row's 'installed'", () => {
    const strip = render(exit(1));
    expect(strip.dataset.variant).toBe("agent-setup-failed");
    expect(strip.classList).toContain("terminal-disconnect-strip--error");
    expect(strip.textContent).toContain("Agent setup failed");
    expect(q("agent-setup-tab-reason")?.textContent).toBe("The setup script exited with code 1.");
    expect(useAgentSetupStatus.getState().phases).toEqual({});
  });

  it("a backend failure on a live shell keeps the terminal's focus", () => {
    useAgentSetupStatus.setState({
      tabs: { [TAB]: setupTab({ progress: { kind: "failed", message: "Download failed" } }) },
    });
    const before = document.activeElement;
    render(undefined, false);
    expect(q("agent-setup-tab-reason")?.textContent).toBe("Download failed");
    expect(document.activeElement).toBe(before);
  });

  it("a Windows setup reads Installed or Failed from its commands' exit (#5946)", () => {
    // The Windows commands are sent ("done"), then end the shell with `exit`.
    useAgentSetupStatus
      .getState()
      .applyProgress("agent-1", "done", "Setup commands sent to terminal");
    let strip = render(exit(0));
    expect(strip.dataset.variant).toBe("agent-setup-installed");
    expect(strip.textContent).toContain("Agent installed");
    expect(strip.textContent).not.toContain("Setup commands sent");
    strip = render(exit(1));
    expect(strip.dataset.variant).toBe("agent-setup-failed");
    expect(strip.textContent).toContain("Agent setup failed");
    expect(q("agent-setup-tab-reason")?.textContent).toBe("The setup script exited with code 1.");
    expect(q("agent-setup-tab-close-btn")).not.toBeNull();
  });

  it("a cancelled setup and a tab that cannot report say so", () => {
    useAgentSetupStatus.setState({
      tabs: { [TAB]: setupTab({ progress: { kind: "cancelled" } }) },
    });
    expect(render(undefined, false).textContent).toContain("Agent setup cancelled");
    useAgentSetupStatus.setState({
      tabs: { [TAB]: setupTab({ reportsExit: false, progress: { kind: "sent" } }) },
    });
    const strip = render(undefined, false);
    expect(strip.dataset.variant).toBe("agent-setup-sent");
    expect(strip.textContent).toContain("Setup commands sent");
    expect(strip.textContent).toContain("check its output, then close the tab");
  });

  it("dismissing an ended tab hides the strip and goes to view mode", () => {
    render(exit(0));
    act(() => q("terminal-disconnect-dismiss-btn")!.click());
    expect(useAgentSetupStatus.getState().tabs[TAB].dismissed).toBe(true);
    expect(dismissTerminalDisconnect).toHaveBeenCalledWith(TAB);
  });

  it("dismissing on a live shell only hides the strip", () => {
    useAgentSetupStatus.setState({
      tabs: { [TAB]: setupTab({ reportsExit: false, progress: { kind: "sent" } }) },
    });
    render(undefined, false);
    act(() => q("terminal-disconnect-dismiss-btn")!.click());
    expect(useAgentSetupStatus.getState().tabs[TAB].dismissed).toBe(true);
    expect(dismissTerminalDisconnect).not.toHaveBeenCalled();
  });
});
