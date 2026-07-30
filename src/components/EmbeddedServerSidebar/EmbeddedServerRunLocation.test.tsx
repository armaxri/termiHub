/**
 * Wiring tests for the per-server "Run on" run-location selector (#2191):
 * picking an agent records the preference on the desktop backend and mirrors it
 * in the run-location store, and a backend rejection rolls the mirror back.
 *
 * The Radix-backed selector is replaced with a trivial harness so the wiring is
 * tested without driving Radix's portal/pointer machinery in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import { setEmbeddedServerRunLocation } from "@/services/embeddedServerApi";
import { useRunLocationStore } from "@/store/runLocationStore";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerSidebar } from "./EmbeddedServerSidebar";

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

vi.mock("@/components/RunLocationSelect", () => ({
  RunLocationSelect: ({
    value,
    onChange,
    ...rest
  }: {
    value: { kind: string; agentId?: string };
    onChange: (loc: { kind: string; agentId?: string }) => void;
    "data-testid"?: string;
  }) => (
    <div
      data-testid={rest["data-testid"]}
      data-value={value.kind === "agent" ? `agent:${value.agentId}` : "this"}
    >
      <button data-testid="pick-agent" onClick={() => onChange({ kind: "agent", agentId: "a1" })}>
        agent
      </button>
    </div>
  ),
}));

vi.mock("@/services/embeddedServerApi", () => ({
  setEmbeddedServerRunLocation: vi.fn(() => Promise.resolve()),
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

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore() {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    embeddedServers: [makeServer("srv-1", "Docs")],
    embeddedServerStates: {},
    remoteAgents: [
      {
        id: "a1",
        name: "build-server",
        config: {},
        agentSettings: {},
        isExpanded: false,
        connectionState: "connected",
      },
    ],
    saveEmbeddedServer: vi.fn(() => Promise.resolve()),
    deleteEmbeddedServer: vi.fn(() => Promise.resolve()),
    startEmbeddedServer: vi.fn(() => Promise.resolve()),
    stopEmbeddedServer: vi.fn(() => Promise.resolve()),
  });
}

describe("EmbeddedServer run-location wiring", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedStore();
    useRunLocationStore.setState({ networkToolLocations: {}, serverLocations: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("records an agent choice on the backend and mirrors it in the store", async () => {
    act(() =>
      root.render(
        <TooltipProvider>
          <EmbeddedServerSidebar />
        </TooltipProvider>
      )
    );
    act(() => {
      (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(setEmbeddedServerRunLocation).toHaveBeenCalledWith("srv-1", {
      kind: "agent",
      agentId: "a1",
    });
    expect(useRunLocationStore.getState().serverLocations["srv-1"]).toEqual({
      kind: "agent",
      agentId: "a1",
    });
  });

  it("rolls back the mirrored choice when the backend rejects it", async () => {
    (setEmbeddedServerRunLocation as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("agent unavailable")
    );
    act(() =>
      root.render(
        <TooltipProvider>
          <EmbeddedServerSidebar />
        </TooltipProvider>
      )
    );
    act(() => {
      (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
    });
    await flush();

    expect(useRunLocationStore.getState().serverLocations["srv-1"]).toEqual({
      kind: "thisComputer",
    });
    expect(toastError).toHaveBeenCalled();
  });
});
