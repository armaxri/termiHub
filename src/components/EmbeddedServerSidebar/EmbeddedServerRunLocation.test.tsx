/**
 * Where a file server runs (#2191, #6028): the choice is stored with the server,
 * a save that did not touch it leaves it out (an old list in another window must
 * not move the server), and a machine that cannot be read or is gone is never
 * shown as this computer. The selector lives in the editor, not on the row
 * (#5770): a row shows names, not settings.
 *
 * The Radix-backed selector is replaced with a trivial harness so the wiring is
 * tested without driving Radix's portal/pointer machinery in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
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
      data-value={value.kind === "agent" ? `agent:${value.agentId}` : value.kind}
    >
      <button data-testid="pick-agent" onClick={() => onChange({ kind: "agent", agentId: "a1" })}>
        agent
      </button>
      <button data-testid="pick-this" onClick={() => onChange({ kind: "thisComputer" })}>
        this
      </button>
    </div>
  ),
}));

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

function seedStore(servers = [makeServer("srv-1", "Docs")], states: Record<string, unknown> = {}) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    embeddedServers: servers,
    embeddedServerStates: states,
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
        <EmbeddedServerSidebar />
      </TooltipProvider>
    )
  );
  await flush();
}

async function openEditor() {
  act(() => q("server-edit-srv-1")!.click());
  await flush();
}

async function pickAndSave(pick?: "pick-agent" | "pick-this") {
  if (pick) act(() => q(pick)!.click());
  act(() => q("server-dialog-save")!.click());
  await flush();
}

describe("where a file server runs", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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

  it("saves the chosen agent with the server, in one save", async () => {
    await render();
    await openEditor();
    expect(q("server-dialog-runloc")?.getAttribute("data-value")).toBe("thisComputer");
    await pickAndSave("pick-agent");
    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(saveEmbeddedServer.mock.calls[0][0].host).toEqual({ kind: "agent", agentId: "a1" });
  });

  it("leaves the host out of a save that did not change it", async () => {
    seedStore([makeServer("srv-1", "Docs", { kind: "agent", agentId: "a1" })]);
    await render();
    await openEditor();
    expect(q("server-dialog-runloc")?.getAttribute("data-value")).toBe("agent:a1");
    await pickAndSave();
    expect(saveEmbeddedServer.mock.calls[0][0]).not.toHaveProperty("host");
  });

  it("moves it back to this computer only when the user picks that", async () => {
    seedStore([makeServer("srv-1", "Docs", { kind: "agent", agentId: "a1" })]);
    await render();
    await openEditor();
    await pickAndSave("pick-this");
    expect(saveEmbeddedServer.mock.calls[0][0].host).toEqual({ kind: "thisComputer" });
  });

  it("does not show a host it cannot read as this computer, and keeps it on save", async () => {
    seedStore([makeServer("srv-1", "Docs", { kind: "cluster", clusterId: "x" })]);
    await render();
    expect(q("server-item-srv-1")?.getAttribute("aria-description")).toContain(
      "termiHub cannot read where it runs"
    );
    await openEditor();
    expect(q("server-dialog-runloc")?.getAttribute("data-value")).toBe("unreadable");
    await pickAndSave();
    expect(saveEmbeddedServer.mock.calls[0][0]).not.toHaveProperty("host");
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

  it("warns that moving a running server stops it", async () => {
    seedStore([makeServer("srv-1", "Docs")], {
      "srv-1": {
        serverId: "srv-1",
        status: "running",
        stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
      },
    });
    await render();
    await openEditor();
    expect(q("server-dialog-move-hint")).toBeNull();
    act(() => q("pick-agent")!.click());
    expect(q("server-dialog-move-hint")?.textContent).toBe(
      "It is running. Saving stops it; start it again to run it on the machine you chose."
    );
  });
});
