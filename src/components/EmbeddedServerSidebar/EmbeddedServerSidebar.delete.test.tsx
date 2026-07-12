/**
 * Delete-confirmation regression tests for the embedded-server sidebar (#1393).
 *
 * Deleting an embedded server used to fire instantly with no confirmation —
 * even when the server was running — which was inconsistent with tunnels and
 * workspaces. These tests pin the confirm-then-delete flow:
 *  - clicking Delete does NOT delete until the user confirms,
 *  - confirming runs the delete,
 *  - cancelling leaves the server untouched,
 *  - a running server's confirmation wording warns it will be stopped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerSidebar } from "./EmbeddedServerSidebar";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

// Network-interface enumeration used by the dialog is not available in jsdom.
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([{ name: "Loopback", addr: "127.0.0.1" }])),
}));

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function makeServer(id: string, name: string): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType: "http",
    rootDirectory: "/tmp",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
  };
}

function runningState(id: string): ServerState {
  return {
    serverId: id,
    status: "running",
    stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore(
  deleteEmbeddedServer: (serverId: string) => Promise<void>,
  servers: EmbeddedServerConfig[],
  states: Record<string, ServerState> = {}
) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    embeddedServers: servers,
    embeddedServerStates: states,
    saveEmbeddedServer: vi.fn(() => Promise.resolve()),
    deleteEmbeddedServer,
    startEmbeddedServer: vi.fn(),
    stopEmbeddedServer: vi.fn(),
  });
}

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

async function clickDelete(id: string) {
  const delBtn = container.querySelector<HTMLButtonElement>(`[data-testid="server-delete-${id}"]`);
  await act(async () => {
    delBtn!.click();
  });
  await flush();
}

async function clickConfirm() {
  const btn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]');
  await act(async () => {
    btn!.click();
  });
  await flush();
}

async function clickCancel() {
  const btn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-cancel"]');
  await act(async () => {
    btn!.click();
  });
  await flush();
}

describe("EmbeddedServerSidebar — delete confirmation (#1393)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does not delete until the user confirms", async () => {
    const deleteEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(deleteEmbeddedServer, [makeServer("srv-1", "Share")]);
    await renderSidebar();

    await clickDelete("srv-1");
    // Nothing deleted yet — a confirmation is required first.
    expect(deleteEmbeddedServer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).not.toBeNull();

    await clickConfirm();
    expect(deleteEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(deleteEmbeddedServer).toHaveBeenCalledWith("srv-1");
  });

  it("leaves the server untouched when the user cancels", async () => {
    const deleteEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(deleteEmbeddedServer, [makeServer("srv-1", "Share")]);
    await renderSidebar();

    await clickDelete("srv-1");
    await clickCancel();

    expect(deleteEmbeddedServer).not.toHaveBeenCalled();
    // Dialog closed.
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeNull();
  });

  it("warns that a running server will be stopped before deletion", async () => {
    const deleteEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(deleteEmbeddedServer, [makeServer("srv-1", "Share")], {
      "srv-1": runningState("srv-1"),
    });
    await renderSidebar();

    await clickDelete("srv-1");
    expect(document.body.textContent?.toLowerCase()).toContain("stop");
  });

  // #1427: the store's deleteEmbeddedServer used to swallow backend errors, so
  // this error path never fired. When the delete rejects, the user must see an
  // error toast and the server must remain listed.
  it("shows an error toast and keeps the server when the backend delete fails", async () => {
    const deleteEmbeddedServer = vi.fn(() => Promise.reject(new Error("boom")));
    seedStore(deleteEmbeddedServer, [makeServer("srv-1", "Share")]);
    await renderSidebar();

    await clickDelete("srv-1");
    await clickConfirm();

    expect(deleteEmbeddedServer).toHaveBeenCalledWith("srv-1");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Share"),
      expect.objectContaining({ description: "boom" })
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // The server row is still present (the store keeps it on failure).
    expect(container.querySelector('[data-testid="server-list"]')).not.toBeNull();
  });
});
