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
import { __emitSettingsViewForTest, stopSettingsSubscription } from "@/store/settingsBridge";
import { TooltipProvider } from "@/components/ui";
import { ServicesSidebar } from "./ServicesSidebar";
import { serviceMenuItem } from "@/test/serviceMenu";

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
  useAppStore.getState = () => state;
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
    tunnels: [],
    tunnelStates: {},
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
        <ServicesSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

async function clickDelete(id: string) {
  const delBtn = serviceMenuItem(`server-delete-${id}`);
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

describe("Services, file servers — delete confirmation (#1393)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSettingsSubscription();
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
    // The folder is not what is deleted, and it can be undone (#6076).
    expect(document.body.textContent).toContain(
      "It is running. Deleting stops it. The folder and its files stay. You can undo it right after."
    );
  });

  describe("like a tunnel, it can be deleted without asking (#6076)", () => {
    const updateSettings = vi.fn(() => Promise.resolve());
    const optOut = () =>
      document.querySelector<HTMLElement>('[data-testid="confirm-dialog-dont-ask-again"]');
    const setup = async (states: Record<string, ServerState> = {}) => {
      const remove = vi.fn(() => Promise.resolve());
      seedStore(remove, [makeServer("srv-1", "Share")], states);
      (useAppStore as unknown as { setState: (p: object) => void }).setState({ updateSettings });
      await renderSidebar();
      await clickDelete("srv-1");
      return remove;
    };

    it("once that is ticked and confirmed, not when it is cancelled", async () => {
      const remove = await setup();
      await act(async () => optOut()!.click());
      await clickCancel();
      await clickDelete("srv-1");
      await clickConfirm();
      expect(remove).toHaveBeenCalledOnce();
      expect(updateSettings).not.toHaveBeenCalled();
      await clickDelete("srv-1");
      await act(async () => optOut()!.click());
      await clickConfirm();
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ confirmUndoableDelete: false })
      );
    });

    const optedOut = () =>
      act(() =>
        __emitSettingsViewForTest(
          {
            version: "1",
            externalConnectionFiles: [],
            powerMonitoringEnabled: true,
            fileBrowserEnabled: true,
            confirmUndoableDelete: false,
          },
          1
        )
      );

    it("a stopped one, not a running one", async () => {
      optedOut();
      expect(await setup()).toHaveBeenCalledWith("srv-1");
      const running = await setup({ "srv-1": runningState("srv-1") });
      expect(running).not.toHaveBeenCalled();
      expect(optOut()).toBeNull();
      await clickConfirm();
      expect(running).toHaveBeenCalledWith("srv-1");
    });
  });

  it("says how many open connections break (#6076)", async () => {
    const state = runningState("srv-1");
    state.stats.activeConnections = 1;
    seedStore(
      vi.fn(() => Promise.resolve()),
      [makeServer("srv-1", "Share")],
      { "srv-1": state }
    );
    await renderSidebar();
    await clickDelete("srv-1");
    expect(document.body.textContent).toContain("stops it and breaks 1 open connection.");
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
    expect(container.querySelector('[data-testid="services-list"]')).not.toBeNull();
  });
});
