/**
 * Session-logging status sync and per-tab stop (#5172, COV-013).
 *
 * The toolbar's "Log Session Output" toggle mirrors the backend: whenever the
 * active terminal changes, TerminalView re-queries `sessionLoggingStatus` so the
 * pressed state stays honest even when logging was started elsewhere or ended
 * with the session. These tests drive the real store and the real effect, with
 * only the Tauri API, xterm and the toolbar's dialogs stubbed:
 *
 * - the sync resolving (on / off), rejecting (warn, indicator unchanged), and
 *   resolving after unmount (no state update, no act warning);
 * - stopping logging across three tabs where one `sessionLoggingStop` rejects:
 *   the other two stop, the failure is surfaced once and that tab stays pressed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { sessionLoggingStart, sessionLoggingStatus, sessionLoggingStop } from "@/services/api";
import { frontendWarn } from "@/utils/frontendLog";
import { seedLayoutState } from "@/test/layoutState";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { SessionLogStatus } from "@/types/generated/SessionLogStatus";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./TerminalRegistry", () => ({
  TerminalPortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./TerminalCommandBridge", () => ({ TerminalCommandBridge: () => null }));
vi.mock("@/testbridge/TestBridge", () => ({ TestBridge: () => null }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@/components/ui", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Button: ({
    icon,
    children,
    className,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    ...rest
  }: {
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button className={className} {...rest}>
      {icon}
      {children}
    </button>
  ),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
vi.mock("./MacroRecordSaveDialog", () => ({ MacroRecordSaveDialog: () => null }));
vi.mock("./MacroPlaybackDialog", () => ({ MacroPlaybackDialog: () => null }));
vi.mock("./BroadcastScopeDialog", () => ({ BroadcastScopeDialog: () => null }));
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStart: vi.fn(() => Promise.resolve("/tmp/session.log")),
  sessionLoggingStop: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendWarn: vi.fn() }));

import { TerminalView } from "./TerminalView";

const STATUS: SessionLogStatus = { path: "/tmp/session.log", timestamps: true };
const PANEL = "panel-a";

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

function termTab(id: string, sessionId: string | null = `sess-${id}`): TerminalTab {
  return {
    id,
    sessionId,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: PANEL,
    isActive: false,
  } as TerminalTab;
}

/** One panel holding `tabs`, with `activeId` the active (and focused) tab. */
function seedTabs(tabs: TerminalTab[], activeId: string): void {
  const leaf: LeafPanel = {
    type: "leaf",
    id: PANEL,
    tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeId })),
    activeTabId: activeId,
  };
  seedLayoutState({
    rootPanel: leaf,
    activePanelId: PANEL,
    tabGroups: [{ id: "g1", name: "G1", rootPanel: leaf, activePanelId: PANEL }],
    activeTabGroupId: "g1",
  });
}

function loggingButton(): HTMLButtonElement {
  return container.querySelector(
    '[data-testid="terminal-view-toggle-logging"]'
  ) as HTMLButtonElement;
}

function pressed(): string | null {
  return loggingButton().getAttribute("aria-pressed");
}

/** Flush the microtasks a resolved/rejected API promise schedules. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderView(): void {
  act(() => root.render(<TerminalView />));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
  vi.clearAllMocks();
});

describe("TerminalView — session logging status sync (#5172)", () => {
  it("skips the status query when no terminal session is active", async () => {
    seedTabs([termTab("t1", null)], "t1");
    renderView();
    await flush();
    expect(sessionLoggingStatus).not.toHaveBeenCalled();
    expect(pressed()).toBe("false");
  });

  it("presses the toggle when the backend reports the active session is logging", async () => {
    vi.mocked(sessionLoggingStatus).mockResolvedValue(STATUS);
    seedTabs([termTab("t1")], "t1");
    renderView();
    await flush();

    expect(sessionLoggingStatus).toHaveBeenCalledWith("sess-t1");
    expect(pressed()).toBe("true");
    expect(loggingButton().getAttribute("aria-label")).toBe("Stop Logging Output");
  });

  it("clears the pressed state when a re-sync reports logging has ended", async () => {
    vi.mocked(sessionLoggingStatus).mockResolvedValue(STATUS);
    seedTabs([termTab("t1"), termTab("t2")], "t1");
    renderView();
    await flush();
    expect(pressed()).toBe("true");

    // Logging on t1 ended while the user looked at t2; returning re-queries.
    vi.mocked(sessionLoggingStatus).mockResolvedValue(null);
    act(() => seedTabs([termTab("t1"), termTab("t2")], "t2"));
    await flush();
    expect(pressed()).toBe("false");
    act(() => seedTabs([termTab("t1"), termTab("t2")], "t1"));
    await flush();

    expect(sessionLoggingStatus).toHaveBeenLastCalledWith("sess-t1");
    expect(pressed()).toBe("false");
  });

  it("leaves the indicator unchanged and warns when the status query rejects", async () => {
    vi.mocked(sessionLoggingStatus).mockRejectedValue(new Error("backend gone"));
    seedTabs([termTab("t1")], "t1");
    renderView();
    await flush();

    expect(pressed()).toBe("false");
    expect(frontendWarn).toHaveBeenCalledTimes(1);
    expect(frontendWarn).toHaveBeenCalledWith(
      "terminal_view",
      "session logging status sync failed: backend gone"
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("drops a status that resolves after unmount (no state update, no act warning)", async () => {
    const pending = deferred<SessionLogStatus | null>();
    vi.mocked(sessionLoggingStatus).mockReturnValue(pending.promise);
    seedTabs([termTab("t1")], "t1");
    renderView();
    act(() => root.unmount());

    await act(async () => {
      pending.resolve(STATUS);
      await pending.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
    // Re-create a root so afterEach's unmount has something to tear down.
    root = createRoot(container);
  });

  it("drops a stale status for a session the user already switched away from", async () => {
    const stale = deferred<SessionLogStatus | null>();
    vi.mocked(sessionLoggingStatus).mockReturnValueOnce(stale.promise).mockResolvedValue(null);
    seedTabs([termTab("t1"), termTab("t2")], "t1");
    renderView();
    act(() => seedTabs([termTab("t1"), termTab("t2")], "t2"));
    await flush();

    await act(async () => {
      stale.resolve(STATUS);
      await stale.promise;
    });

    // Back on t1: had the stale "logging" landed, t1 would now read pressed.
    vi.mocked(sessionLoggingStatus).mockReturnValue(new Promise(() => {}));
    act(() => seedTabs([termTab("t1"), termTab("t2")], "t1"));
    expect(pressed()).toBe("false");
  });
});

describe("TerminalView — stopping logging across tabs (#5172)", () => {
  const TABS = ["t1", "t2", "t3"];

  function focus(id: string): void {
    act(() =>
      seedTabs(
        TABS.map((t) => termTab(t)),
        id
      )
    );
  }

  async function clickToggle(): Promise<void> {
    await act(async () => {
      loggingButton().click();
      await Promise.resolve();
    });
    await flush();
  }

  it("stops the healthy sessions and surfaces the one failed stop once", async () => {
    // Every tab is already logging on the backend.
    vi.mocked(sessionLoggingStatus).mockResolvedValue(STATUS);
    vi.mocked(sessionLoggingStop).mockImplementation((sid) =>
      sid === "sess-t2" ? Promise.reject(new Error("disk full")) : Promise.resolve(STATUS.path)
    );
    seedTabs(
      TABS.map((t) => termTab(t)),
      "t1"
    );
    renderView();
    await flush();

    for (const id of TABS) {
      focus(id);
      await flush();
      expect(pressed()).toBe("true");
      await clickToggle();
    }

    expect(vi.mocked(sessionLoggingStop).mock.calls.map(([sid]) => sid)).toEqual([
      "sess-t1",
      "sess-t2",
      "sess-t3",
    ]);
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Failed to stop logging: disk full");

    // t3 (still focused) stopped; the indicator now follows each tab's real state.
    expect(pressed()).toBe("false");
    vi.mocked(sessionLoggingStatus).mockReturnValue(new Promise(() => {}));
    focus("t2");
    expect(pressed()).toBe("true");
    focus("t1");
    expect(pressed()).toBe("false");
  });

  it("starts logging and presses the toggle on success", async () => {
    seedTabs([termTab("t1")], "t1");
    renderView();
    await flush();

    await clickToggle();

    expect(sessionLoggingStart).toHaveBeenCalledWith("sess-t1", undefined, true);
    expect(toast.success).toHaveBeenCalledWith("Logging session output to /tmp/session.log");
    expect(pressed()).toBe("true");
  });

  it("surfaces a failed start and leaves the toggle released", async () => {
    vi.mocked(sessionLoggingStart).mockRejectedValueOnce(new Error("no permission"));
    seedTabs([termTab("t1")], "t1");
    renderView();
    await flush();

    await clickToggle();

    expect(toast.error).toHaveBeenCalledWith("Failed to start logging: no permission");
    expect(pressed()).toBe("false");
  });
});
