/**
 * The Open connections panel shows how an SSH session's X11 forwarding runs
 * (#5586), from the backend's `LocalSessionInfo.x11Forwarding`, and nothing
 * for a session without X11 forwarding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { LocalSessionInfo } from "@/services/api";

const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  pruneDeadAgents: vi.fn(() => Promise.resolve([])),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false, sessionCount: 0 })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorStopAll: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

const FORWARDED: LocalSessionInfo = {
  id: "sess-fwd",
  title: "build-box",
  connectionType: "ssh",
  alive: true,
  x11Forwarding: "serverForwarded",
};

const FALLBACK: LocalSessionInfo = {
  id: "sess-fallback",
  title: "legacy-box",
  connectionType: "ssh",
  alive: true,
  x11Forwarding: "fallbackRefused",
};

const NO_X11: LocalSessionInfo = {
  id: "sess-plain",
  title: "plain-box",
  connectionType: "ssh",
  alive: true,
};

describe("OpenConnectionsModal — X11 forwarding mode (#5586)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    listLocalSessions.mockReset();
    listLocalSessions.mockResolvedValue([FORWARDED, FALLBACK, NO_X11]);
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

  const chipFor = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid="oc-x11-mode-${id}"]`);

  it("shows the mode on each SSH session row with X11 forwarding", async () => {
    await renderModal();
    expect(chipFor("sess-fwd")?.textContent).toBe("X11");
    expect(chipFor("sess-fallback")?.textContent).toBe("X11 fallback");
  });

  it("shows nothing on a session without X11 forwarding", async () => {
    await renderModal();
    expect(chipFor("sess-plain")).toBeNull();
    const row = Array.from(document.querySelectorAll(".oc-row")).find((r) =>
      r.textContent?.includes("plain-box")
    );
    expect(row?.querySelector(".oc-x11")).toBeNull();
  });

  it("keeps the chip inside its own row", async () => {
    await renderModal();
    const row = chipFor("sess-fallback")?.closest(".oc-row");
    expect(row?.querySelector(".oc-row__title")?.textContent).toContain("legacy-box");
  });
});
