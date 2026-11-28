/**
 * Agent row during and after an agent setup (#5906).
 *
 * The setup installs the agent over its own SSH session, so the agent's
 * connection state and stored error do not change while it runs. The row must
 * still say what is happening:
 *
 *  1. While the setup runs: "Installing…" (a busy dot and a visible marker),
 *     never the red "Disconnected" + "Reconnect" failure state.
 *  2. After the setup reported success: the neutral "Not connected" + "Connect",
 *     even though the failed connect that offered the setup left a `lastError`.
 *  3. A failed or cancelled setup falls back to what the row showed before.
 *  4. Starting a new connect forgets the finished setup, so a later failure
 *     shows as one again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";

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
const setupButton = () => byTestId<HTMLButtonElement>(`agent-setup-${AGENT_ID}`);
const installingMarker = () => byTestId(`agent-installing-${AGENT_ID}`);

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const NOT_INSTALLED = "[thub-code:agent_missing] termihub-agent: not found";

function setPhase(phase: "installing" | "installed" | null): void {
  act(() => {
    if (phase === null) useAgentSetupStatus.getState().clear(AGENT_ID);
    else if (phase === "installing") useAgentSetupStatus.getState().markInstalling(AGENT_ID);
    else useAgentSetupStatus.getState().applyProgress(AGENT_ID, "done");
  });
}

function expectInstalling() {
  const cls = stateDot()?.className ?? "";
  expect(cls).toContain("status-dot--connecting");
  expect(cls).not.toContain("status-dot--disconnected");
  expect(stateDot()?.getAttribute("aria-label")).toBe("Installing…");
  expect(installingMarker()?.textContent).toBe("Installing…");
  expect(reconnectButton()).toBeNull();
  expect(connectButton()).toBeNull();
  expect(setupButton()).toBeNull();
}

function expectNeutral() {
  const cls = stateDot()?.className ?? "";
  expect(cls).toContain("status-dot--disabled");
  expect(cls).not.toContain("status-dot--disconnected");
  expect(stateDot()?.getAttribute("aria-label")).toBe("Not connected");
  expect(connectButton()?.getAttribute("aria-label")).toBe("Connect");
  expect(reconnectButton()).toBeNull();
  expect(installingMarker()).toBeNull();
}

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — row state during and after an agent setup (#5906)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAgentSetupStatus.setState({ phases: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows Installing… while the setup runs on a host without the agent", () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    setPhase("installing");
    expectInstalling();
  });

  it("offers no Connect in the menu while the setup runs (live product run, #5518)", async () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    setPhase("installing");
    await act(async () => {
      byTestId(`agent-header-${AGENT_ID}`)!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
    });
    await settle();
    // The menu is portalled out of the row's container.
    const item = document.querySelector('[data-testid="context-agent-connect"]');
    expect(item).not.toBeNull();
    expect(item!.hasAttribute("data-disabled")).toBe(true);
  });

  it("never shows the failure state while the setup runs, whatever the stored error", () => {
    renderAgent(makeAgent({ lastError: "boom" }));
    setPhase("installing");
    expectInstalling();
  });

  it("says what is happening in the expanded body while installing", () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED, isExpanded: true }));
    setPhase("installing");
    expect(byTestId(`agent-empty-${AGENT_ID}`)?.textContent).toBe(
      "Installing the agent on host.example.com…"
    );
  });

  it("shows the neutral Not connected + Connect once the setup succeeded", () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    setPhase("installing");
    setPhase("installed");
    expectNeutral();
  });

  it("stays neutral after a successful setup even with a generic stored error", () => {
    renderAgent(makeAgent({ lastError: "boom" }));
    setPhase("installed");
    expectNeutral();
  });

  it("falls back to 'Set up agent' when the setup failed", () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    setPhase("installing");
    act(() => useAgentSetupStatus.getState().applyProgress(AGENT_ID, "error"));
    expect(installingMarker()).toBeNull();
    expect(stateDot()?.getAttribute("aria-label")).toBe("Agent not installed");
    expect(setupButton()).not.toBeNull();
  });

  it.each([
    [NOT_INSTALLED, setupButton],
    ["boom", reconnectButton],
    [undefined, connectButton],
  ])(
    "claims neither installed nor failed when the outcome is unknown (%s, #5992)",
    (error, btn) => {
      renderAgent(makeAgent({ lastError: error }));
      setPhase("installing");
      act(() => useAgentSetupStatus.getState().applyProgress(AGENT_ID, "unknown"));
      expect(installingMarker()).toBeNull();
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("status-dot--disabled");
      expect(stateDot()?.getAttribute("aria-label")).toBe("Setup outcome unknown");
      expect(btn()).not.toBeNull();
    }
  );

  it("a Windows setup found failed on the host does not clear the row's failure", () => {
    renderAgent(makeAgent({ lastError: "boom" }));
    setPhase("installing");
    act(() => useAgentSetupStatus.getState().applyProgress(AGENT_ID, "sent"));
    expectInstalling();
    act(() => useAgentSetupStatus.getState().applyProgress(AGENT_ID, "failed"));
    expect(reconnectButton()).not.toBeNull();
    expect(stateDot()?.className).toContain("status-dot--disconnected");
  });

  it("forgets the finished setup when a new connect starts", async () => {
    useAppStore.setState({ connectRemoteAgent: vi.fn(() => Promise.resolve()) as never });
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    setPhase("installed");
    act(() => connectButton()?.click());
    await settle();
    expect(useAgentSetupStatus.getState().phases[AGENT_ID]).toBeUndefined();
  });

  it("ignores another agent's setup", () => {
    renderAgent(makeAgent({ lastError: NOT_INSTALLED }));
    act(() => useAgentSetupStatus.getState().markInstalling("some-other-agent"));
    expect(installingMarker()).toBeNull();
    expect(setupButton()).not.toBeNull();
  });
});
