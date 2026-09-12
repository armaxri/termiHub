/**
 * Tests for the "Embedded Servers" section of the Open Connections panel
 * (SM-017): running embedded HTTP/FTP/TFTP servers were absent from the panel,
 * contradicting its "every live subsystem" mandate — a user could not see or
 * stop a running embedded server from the one place meant to show everything.
 * The section is driven by the store's `embeddedServers` config list + live
 * `embeddedServerStates` runtime map (the same single source of truth the
 * Services sidebar reads), listing each running server with a per-row Stop and a
 * Kill-All, both wired to the store's `stopEmbeddedServer` action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { EmbeddedServerConfig, ServerState, ServerStatus } from "@/types/embeddedServer";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts its trigger; shim them so tooltip-wrapped controls render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function config(id: string, name: string, serverType: EmbeddedServerConfig["serverType"]): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType,
    rootDirectory: "/srv",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: true,
  };
}

function serverState(id: string, status: ServerStatus): ServerState {
  return {
    serverId: id,
    status,
    stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
  };
}

function serverSection(): HTMLElement | null {
  const title = Array.from(document.querySelectorAll(".oc-section__title")).find(
    (t) => t.textContent === "Embedded Servers"
  );
  return (title?.closest("div")?.parentElement as HTMLElement) ?? null;
}

function serverRows(): Element[] {
  return Array.from(serverSection()?.querySelectorAll(".oc-row") ?? []);
}

describe("OpenConnectionsModal — Embedded Servers section", () => {
  let container: HTMLDivElement;
  let root: Root;
  const stopEmbeddedServer = vi.fn((_id: string) => Promise.resolve());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ stopEmbeddedServer });
    stopEmbeddedServer.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderModal() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("renders a row per running embedded server from the store", () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http"), config("s2", "Files FTP", "ftp")],
      embeddedServerStates: {
        s1: serverState("s1", "running"),
        s2: serverState("s2", "running"),
      },
    });

    renderModal();

    const titles = serverRows().map((r) => r.querySelector(".oc-row__title")?.textContent);
    expect(titles.some((t) => t?.includes("Docs HTTP"))).toBe(true);
    expect(titles.some((t) => t?.includes("Files FTP"))).toBe(true);
    // The row detail carries the protocol + bind address so the server is
    // identifiable at a glance.
    const details = serverRows().map((r) => r.querySelector(".oc-row__detail")?.textContent);
    expect(details.some((d) => d?.includes("HTTP") && d?.includes("127.0.0.1:8080"))).toBe(true);
  });

  it("stops a single server via the store's stopEmbeddedServer action", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "running") },
    });

    renderModal();

    const killBtn = serverRows()[0]?.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      killBtn.click();
    });

    expect(stopEmbeddedServer).toHaveBeenCalledWith("s1");
  });

  it("Kill-All stops every running server via stopEmbeddedServer", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http"), config("s2", "Files FTP", "ftp")],
      embeddedServerStates: {
        s1: serverState("s1", "running"),
        s2: serverState("s2", "running"),
      },
    });

    renderModal();

    const killAll = serverSection()?.querySelector(".oc-section__kill-all") as HTMLButtonElement;
    await act(async () => {
      killAll.click();
    });

    // Bulk teardown confirms first (#1343) — accept the dialog to proceed.
    const confirm = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm.click();
    });

    expect(stopEmbeddedServer).toHaveBeenCalledWith("s1");
    expect(stopEmbeddedServer).toHaveBeenCalledWith("s2");
  });

  it("renders no Embedded Servers section when no server is running", () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "stopped") },
    });

    renderModal();
    expect(serverSection()).toBeNull();
  });
});
