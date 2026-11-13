/**
 * Agent row presentation (#5621):
 *
 *  1. The agent name renders exactly as entered — the header toggle carries no
 *     `text-transform`, so a lowercase name is never shown in ALL CAPS.
 *  2. A never-connected agent reads as neutral "Not connected": a grey dot and a
 *     "Connect" action. Red + "Reconnect" are reserved for a real failure — a
 *     stored `lastError`, a failed connect attempt, or an unexpected drop.
 *  3. A user-initiated disconnect is not a failure: it returns to the neutral
 *     state.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

// --- mocks required by AgentNode --------------------------------------------

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

// The header's other action buttons wrap their icons in the Radix-backed
// Tooltip, which needs a TooltipProvider. Stub it to a passthrough so these
// isolated renders don't require the app-root provider — the Reconnect button
// carries its help text via a native `title`, not this primitive.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-row-state-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "sys-pr-agent-5c12d808",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
      password: "secret",
    },
    connectionState: "disconnected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderAgent(agent: RemoteAgentDefinition) {
  seedAgentsRegion({
    agentDefinitions: { [AGENT_ID]: [] },
    agentFolders: { [AGENT_ID]: [] },
    agentSessions: { [AGENT_ID]: [] },
    remoteAgents: [agent],
  });
  act(() => {
    root.render(React.createElement(AgentNode, { agent }));
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

const stateDot = () => byTestId(`agent-state-${AGENT_ID}`);
const connectButton = () => byTestId<HTMLButtonElement>(`agent-connect-${AGENT_ID}`);
const reconnectButton = () => byTestId<HTMLButtonElement>(`agent-reconnect-${AGENT_ID}`);

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectNeutral() {
  const cls = stateDot()?.className ?? "";
  expect(cls).toContain("status-dot--disabled");
  expect(cls).not.toContain("status-dot--disconnected");
  expect(stateDot()?.getAttribute("aria-label")).toBe("Not connected");
  expect(connectButton()?.textContent).toBe("Connect");
  expect(reconnectButton()).toBeNull();
}

function expectFailed() {
  const cls = stateDot()?.className ?? "";
  expect(cls).toContain("status-dot--disconnected");
  expect(stateDot()?.getAttribute("aria-label")).toBe("Disconnected");
  expect(reconnectButton()?.textContent).toBe("Reconnect");
  expect(connectButton()).toBeNull();
}

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — row state + name presentation (#5621)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the agent name exactly as entered", () => {
    renderAgent(makeAgent({ name: "sys-pr-agent-MiXeD" }));
    expect(byTestId(`agent-name-${AGENT_ID}`)?.textContent).toBe("sys-pr-agent-MiXeD");
  });

  it("never text-transforms the agent header (only section titles may be uppercase)", () => {
    const css = readFileSync("src/components/Sidebar/ConnectionList.css", "utf8");
    const rule = css.match(
      /\.connection-list__group-header--agent \.connection-list__group-toggle\s*\{([^}]*)\}/
    );
    expect(rule, "agent header toggle rule").not.toBeNull();
    expect(rule![1]).toMatch(/text-transform:\s*none/);
    expect(rule![1]).toMatch(/letter-spacing:\s*normal/);
  });

  it("shows a never-connected agent as neutral with a Connect action", () => {
    renderAgent(makeAgent());
    expectNeutral();
  });

  it("shows red + Reconnect when the agent carries a lastError", () => {
    renderAgent(makeAgent({ lastError: "Failed to reconnect after 10 attempts" }));
    expectFailed();
    expect(reconnectButton()?.getAttribute("title")).toContain("Failed to reconnect");
  });

  it("Connect runs the normal connect path", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ connectRemoteAgent: connect });
    renderAgent(makeAgent());
    await act(async () => {
      connectButton()!.click();
    });
    await settle();
    expect(connect).toHaveBeenCalledWith(AGENT_ID, undefined);
  });

  it("turns red + Reconnect after a failed connect attempt", async () => {
    useAppStore.setState({
      connectRemoteAgent: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });
    renderAgent(makeAgent());
    await act(async () => {
      connectButton()!.click();
    });
    await settle();
    expectFailed();
  });

  it("turns red + Reconnect when a connected agent drops unexpectedly", () => {
    renderAgent(makeAgent({ connectionState: "connected" }));
    renderAgent(makeAgent({ connectionState: "disconnected" }));
    expectFailed();
  });

  it("returns to neutral after a user-initiated disconnect", async () => {
    useAppStore.setState({ disconnectRemoteAgent: vi.fn().mockResolvedValue(undefined) });
    renderAgent(makeAgent({ connectionState: "connected" }));
    await act(async () => {
      byTestId<HTMLButtonElement>(`agent-disconnect-${AGENT_ID}`)!.click();
    });
    await settle();
    renderAgent(makeAgent({ connectionState: "disconnected" }));
    expectNeutral();
  });

  it("clears a drop's failure once the agent connects again", async () => {
    useAppStore.setState({ disconnectRemoteAgent: vi.fn().mockResolvedValue(undefined) });
    renderAgent(makeAgent({ connectionState: "connected" }));
    renderAgent(makeAgent({ connectionState: "disconnected" }));
    expectFailed();
    renderAgent(makeAgent({ connectionState: "connecting" }));
    renderAgent(makeAgent({ connectionState: "connected" }));
    expect(stateDot()?.className).toContain("status-dot--connected");
    // A later deliberate disconnect is neutral again — the old drop is gone.
    await act(async () => {
      byTestId<HTMLButtonElement>(`agent-disconnect-${AGENT_ID}`)!.click();
    });
    await settle();
    renderAgent(makeAgent({ connectionState: "disconnected" }));
    expectNeutral();
  });
});
