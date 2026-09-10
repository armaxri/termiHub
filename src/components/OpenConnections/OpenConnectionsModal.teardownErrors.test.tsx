/**
 * Regression tests for surfacing swallowed teardown failures in the Open
 * Connections panel (UX-033 / FEC-009 / WA-FE-005). Previously the kill /
 * disconnect / stop actions did `.catch(() => {})` while optimistically removing
 * the row, so a failed teardown left the user believing a still-live connection
 * was gone with no toast and no log.
 *
 * Each test drives a rejecting backend call and asserts that the failure now
 * (a) lands in the LogViewer via `frontendError`, (b) surfaces a `toast.error`,
 * and (c) does NOT drop the row (the resource is still live).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { LocalSessionInfo } from "@/services/api";

const toastError = vi.fn();
const frontendErrorMock = vi.fn();

const closeTerminal = vi.fn<(id: string, intentional?: boolean) => Promise<void>>();
const xServerStop = vi.fn<() => Promise<void>>();
const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: (id: string, intentional?: boolean) => closeTerminal(id, intentional),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve(true)),
  pruneDeadAgents: vi.fn(() => Promise.resolve([])),
  xServerStatus: vi.fn(() =>
    Promise.resolve({
      state: "running",
      platform: "windows",
      managed: true,
      displayNumber: 0,
      sessionCount: 0,
    })
  ),
  xServerStop: () => xServerStop(),
}));

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorStopAll: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, error: (m: string) => toastError(m), success: vi.fn() },
  };
});

vi.mock("@/utils/frontendLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/frontendLog")>();
  return {
    ...actual,
    frontendError: (target: string, message: string) => frontendErrorMock(target, message),
  };
});

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function localSession(id: string, title: string): LocalSessionInfo {
  return { id, title, connectionType: "local", alive: true, spawned: false };
}

function rowsMatching(text: string): Element[] {
  return Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(text)
  );
}

describe("OpenConnectionsModal — swallowed teardown failures are surfaced", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    toastError.mockClear();
    frontendErrorMock.mockClear();
    closeTerminal.mockReset();
    xServerStop.mockReset();
    listLocalSessions.mockReset();
    listLocalSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("keeps the row, logs, and toasts when a single local-session kill fails", async () => {
    listLocalSessions.mockResolvedValue([localSession("sess-1", "My Shell")]);
    closeTerminal.mockRejectedValue(new Error("backend down"));
    await renderModal();

    const row = rowsMatching("My Shell")[0];
    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    await act(async () => {
      killBtn.click();
      await Promise.resolve();
    });
    await flush();

    // The kill still routed the intentional-kill flag to the backend...
    expect(closeTerminal).toHaveBeenCalledWith("sess-1", true);
    // ...but since it rejected, the row is NOT dropped (the session is still live).
    expect(rowsMatching("My Shell")).toHaveLength(1);
    // And the failure is surfaced both ways.
    expect(frontendErrorMock).toHaveBeenCalledWith(
      "open_connections",
      expect.stringContaining("sess-1")
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("drops only the sessions whose bulk kill succeeded and keeps the failed one", async () => {
    listLocalSessions.mockResolvedValue([
      localSession("sess-ok", "Good Shell"),
      localSession("sess-bad", "Bad Shell"),
    ]);
    closeTerminal.mockImplementation((id: string) =>
      id === "sess-bad" ? Promise.reject(new Error("stuck")) : Promise.resolve()
    );
    await renderModal();

    // "Kill All" for the Local Sessions section, then confirm the dialog.
    const killAll = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Kill All Local Sessions"
    ) as HTMLButtonElement;
    expect(killAll).not.toBeNull();
    await act(async () => killAll.click());
    const confirm = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    await flush();

    // The succeeded session is gone; the failed one is still listed + killable.
    expect(rowsMatching("Good Shell")).toHaveLength(0);
    expect(rowsMatching("Bad Shell")).toHaveLength(1);
    expect(frontendErrorMock).toHaveBeenCalledWith(
      "open_connections",
      expect.stringContaining("sess-bad")
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("keeps the X server row, logs, and toasts when the stop fails", async () => {
    xServerStop.mockRejectedValue(new Error("cannot stop"));
    await renderModal();

    const stopBtn = document.querySelector(
      '[data-testid="open-connections-x-server-stop"]'
    ) as HTMLButtonElement;
    expect(stopBtn).not.toBeNull();
    await act(async () => {
      stopBtn.click();
      await Promise.resolve();
    });
    await flush();

    expect(xServerStop).toHaveBeenCalledTimes(1);
    // The X server row is NOT removed — it is still running.
    expect(document.querySelector('[data-testid="open-connections-x-server-row"]')).not.toBeNull();
    expect(frontendErrorMock).toHaveBeenCalledWith(
      "open_connections",
      expect.stringContaining("X server")
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
