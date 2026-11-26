/**
 * Tests for the "Embedded servers" section of the Open connections panel
 * (SM-017): running embedded HTTP/FTP/TFTP servers were absent from the panel,
 * contradicting its "every live subsystem" mandate — a user could not see or
 * stop a running embedded server from the one place meant to show everything.
 * The section is driven by the store's `embeddedServers` config list + live
 * `embeddedServerStates` runtime map (the same single source of truth the
 * Services sidebar reads), listing each running server with a per-row Stop and a
 * Kill-All, both wired to the store's `stopEmbeddedServer` action.
 */
import { useEditorViews } from "@/components/ServiceEditor/editorView";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
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

function config(
  id: string,
  name: string,
  serverType: EmbeddedServerConfig["serverType"]
): EmbeddedServerConfig {
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
    (t) => t.textContent === "Services"
  );
  return (title?.closest("div")?.parentElement as HTMLElement) ?? null;
}

function serverRows(): Element[] {
  return Array.from(serverSection()?.querySelectorAll(".oc-row") ?? []);
}

describe("OpenConnectionsModal — Embedded servers section", () => {
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

  async function renderModal(onOpenChange: (open: boolean) => void = () => {}) {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={onOpenChange} />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  it("renders a row per running embedded server from the store", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http"), config("s2", "Files FTP", "ftp")],
      embeddedServerStates: {
        s1: serverState("s1", "running"),
        s2: serverState("s2", "running"),
      },
    });

    await renderModal();

    const titles = serverRows().map((r) => r.querySelector(".oc-row__title")?.textContent);
    expect(titles.some((t) => t?.includes("Docs HTTP"))).toBe(true);
    expect(titles.some((t) => t?.includes("Files FTP"))).toBe(true);
    // The row detail carries the protocol + bind address so the server is
    // identifiable at a glance.
    const details = serverRows().map((r) => r.querySelector(".oc-row__detail")?.textContent);
    expect(details.some((d) => d?.includes("HTTP") && d?.includes("127.0.0.1:8080"))).toBe(true);
    // And the machine that holds the port (#6028).
    expect(details.some((d) => d?.includes("this computer"))).toBe(true);
  });

  it("stops a single server via the store's stopEmbeddedServer action", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "running") },
    });

    await renderModal();

    const killBtn = serverRows()[0]?.querySelector(
      '[data-testid="open-connections-embedded-server-stop-s1"]'
    ) as HTMLButtonElement;
    await act(async () => {
      killBtn.click();
    });

    expect(stopEmbeddedServer).toHaveBeenCalledWith("s1");
  });

  it("offers the server's Activity, which opens its editor there (#6028, slice 10)", async () => {
    const openServerEditorTab = vi.fn();
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "running") },
      openServerEditorTab,
    });
    const onOpenChange = vi.fn();
    await renderModal(onOpenChange);
    await act(async () => {
      (
        serverRows()[0]?.querySelector(
          '[data-testid="oc-service-s1-activity"]'
        ) as HTMLButtonElement
      ).click();
    });
    expect(openServerEditorTab).toHaveBeenCalledWith("s1");
    expect(useEditorViews.getState().views.s1).toBe("activity");
    // The panel makes way for the editor.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Kill-All stops every running server via stopEmbeddedServer", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http"), config("s2", "Files FTP", "ftp")],
      embeddedServerStates: {
        s1: serverState("s1", "running"),
        s2: serverState("s2", "running"),
      },
    });

    await renderModal();

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

  it("lists a server whose agent is offline as not reachable, with Stop (#6028)", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http"), config("s2", "Waits", "http")],
      embeddedServerStates: {
        s1: serverState("s1", "notReachable"),
        // Nothing of it is open anywhere.
        s2: serverState("s2", "waiting"),
      },
    });
    await renderModal();
    const rows = serverRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".oc-row__badge")?.textContent).toBe("not reachable");
    expect(rows[0].querySelector(".oc-row__kill")).not.toBeNull();
  });

  it("lists file servers and tunnels in one Services section, stopped together (#6028)", async () => {
    const stopTunnel = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      stopTunnel,
      tunnels: [
        {
          id: "t1",
          name: "DB",
          sshConnectionId: "c",
          tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
        } as never,
      ],
      tunnelStates: {
        t1: {
          tunnelId: "t1",
          status: "connected",
          stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
        },
      },
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "running") },
    });
    await renderModal();
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).toContain("Services");
    expect(titles).not.toContain("SSH tunnels");
    expect(titles).not.toContain("Embedded servers");
    expect(
      document.querySelector('[data-testid="open-connections-services-section"] .oc-section__count')
        ?.textContent
    ).toBe("2");
  });

  it("renders no Embedded servers section when no server is running", async () => {
    useAppStore.setState({
      embeddedServers: [config("s1", "Docs HTTP", "http")],
      embeddedServerStates: { s1: serverState("s1", "stopped") },
    });

    await renderModal();
    expect(serverSection()).toBeNull();
  });
});
