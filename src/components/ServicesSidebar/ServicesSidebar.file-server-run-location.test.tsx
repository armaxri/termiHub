/**
 * Where a file server runs (#2191, #6028), as its row tells it: a machine that
 * cannot be read or is gone is never shown as this computer. The choice is in the
 * editor (`FileServerEditor.test.tsx`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import { ServicesSidebar } from "./ServicesSidebar";

const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([{ name: "Loopback", addr: "127.0.0.1" }])),
}));

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function makeServer(id: string, name: string, host?: unknown): EmbeddedServerConfig {
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
    ...(host === undefined ? {} : { host: host as EmbeddedServerConfig["host"] }),
  };
}

const saveEmbeddedServer = vi.fn((_config: EmbeddedServerConfig) => Promise.resolve());

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

setupAgentsRegion();

function seedStore(servers = [makeServer("srv-1", "Docs")], states: Record<string, unknown> = {}) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    tunnels: [],
    tunnelStates: {},
    embeddedServers: servers,
    embeddedServerStates: states,
    saveEmbeddedServer,
    deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
    startEmbeddedServer: vi.fn(() => Promise.resolve()),
    stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  });
}

function q(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function render() {
  act(() =>
    root.render(
      <TooltipProvider>
        <ServicesSidebar />
      </TooltipProvider>
    )
  );
  await flush();
}

describe("where a file server runs", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedAgentsRegion({ remoteAgents: [{ id: "a1", name: "build-server" } as any] });
    seedStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("has no Run on selector on the row", async () => {
    await render();
    expect(q("server-runloc-srv-1")).toBeNull();
    expect(q("server-item-srv-1")?.textContent).not.toContain("Run on");
  });

  it("says when nobody can read where it runs", async () => {
    seedStore([makeServer("srv-1", "Docs", { kind: "moon" })]);
    await render();
    expect(q("server-item-srv-1")?.getAttribute("aria-description")).toContain(
      "termiHub cannot read where it runs"
    );
  });

  it.each([
    [undefined, "Runs on this computer"],
    [{ kind: "agent", agentId: "a1" }, "Runs on agent build-server"],
    [{ kind: "agent", agentId: "gone" }, "Runs on an agent that was removed"],
  ])("says on the row where it runs (%j)", async (host, text) => {
    seedStore([makeServer("srv-1", "Docs", host)]);
    await render();
    expect(q("server-item-srv-1")?.getAttribute("aria-description")).toContain(text);
  });

  it("shows why it was not started on the row", async () => {
    const error = "Not started: agent build-server is not connected. Connect it, then start again.";
    seedStore([makeServer("srv-1", "Docs", { kind: "agent", agentId: "a1" })], {
      "srv-1": {
        serverId: "srv-1",
        status: "error",
        error,
        stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
      },
    });
    await render();
    expect(q("server-item-srv-1")?.textContent).toContain(error);
  });
});
