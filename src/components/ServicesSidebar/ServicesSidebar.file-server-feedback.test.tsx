/**
 * Feedback tests for embedded-server save & duplicate (#1342).
 *
 * `saveEmbeddedServer` used to swallow failures to `console.error` while the
 * dialog closed as if the save had worked. These tests pin that:
 *  - a successful save surfaces a success toast and closes the dialog,
 *  - a failing save surfaces an error toast and keeps the dialog open,
 *  - duplicate confirms success / surfaces failure via toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
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

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore(
  saveEmbeddedServer: (config: EmbeddedServerConfig) => Promise<void>,
  servers: EmbeddedServerConfig[] = []
) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    sidebarView: "services",
    tunnels: [],
    tunnelStates: {},
    embeddedServers: servers,
    embeddedServerStates: {},
    saveEmbeddedServer,
    deleteEmbeddedServer: vi.fn(),
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

describe("EmbeddedServerSidebar — save & duplicate feedback (#1342)", () => {
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

  it("raises no toast when duplication succeeds (#5859)", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(saveEmbeddedServer, [makeServer("srv-1", "Original")]);
    await renderSidebar();

    const dupBtn = serviceMenuItem("server-duplicate-srv-1");
    await act(async () => {
      dupBtn!.click();
    });
    await flush();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when duplication fails", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.reject(new Error("disk full")));
    seedStore(saveEmbeddedServer, [makeServer("srv-1", "Original")]);
    await renderSidebar();

    const dupBtn = serviceMenuItem("server-duplicate-srv-1");
    await act(async () => {
      dupBtn!.click();
    });
    await flush();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("copies where the server runs, and not its auto-start (#6028, F-4)", async () => {
    const saveEmbeddedServer = vi.fn((_c: EmbeddedServerConfig) => Promise.resolve());
    const host = { kind: "agent", agentId: "a1" } as const;
    seedStore(saveEmbeddedServer, [{ ...makeServer("srv-1", "Original"), host, autoStart: true }]);
    await renderSidebar();
    const item = serviceMenuItem("server-duplicate-srv-1")!;
    await act(async () => item.click());
    await flush();
    const copy = saveEmbeddedServer.mock.calls[0][0];
    expect(copy).toMatchObject({ name: "Copy of Original", host, autoStart: false });
    expect(copy.id).not.toBe("srv-1");
  });

  it.each([
    { serverType: "http", httpAuth: { username: "web", password: "" } },
    { serverType: "ftp", ftpAuth: { type: "credentials", username: "u", password: "" } },
  ] as const)(
    "a copy that needs a password opens in the editor instead of being saved (#6028, F-4)",
    async (auth) => {
      const saveEmbeddedServer = vi.fn((_c: EmbeddedServerConfig) => Promise.resolve());
      const openServerEditorTab = vi.fn();
      seedStore(saveEmbeddedServer, [
        { ...makeServer("srv-1", "Original"), ...auth } as EmbeddedServerConfig,
      ]);
      (useAppStore as unknown as { setState: (p: object) => void }).setState({
        openServerEditorTab,
      });
      await renderSidebar();
      const item = serviceMenuItem("server-duplicate-srv-1")!;
      await act(async () => item.click());
      await flush();
      expect(saveEmbeddedServer).not.toHaveBeenCalled();
      expect(openServerEditorTab).toHaveBeenCalledWith(null, { copyOf: "srv-1" });
    }
  );
});
