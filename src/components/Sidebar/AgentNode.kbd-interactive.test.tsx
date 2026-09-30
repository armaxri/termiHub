/**
 * #3377: connecting an agent host configured with keyboard-interactive auth
 * (OTP / 2FA) must not raise the pre-connect password prompt — the server's
 * challenges are answered in the in-app keyboard-interactive dialog that the
 * SSH connect itself raises. Password auth without a stored password still
 * prompts.
 */
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
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
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

const AGENT_ID = "agent-kbd-interactive-test";

function makeAgent(config: RemoteAgentDefinition["config"]): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Bastion Agent",
    config,
    connectionState: "disconnected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
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

async function clickConnect() {
  const btn = container.querySelector<HTMLButtonElement>(
    `[data-testid="agent-reconnect-${AGENT_ID}"]`
  );
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — keyboard-interactive agent host (#3377)", () => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockRequestPassword = vi.fn().mockResolvedValue("typed-pw");

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockConnect.mockClear();
    mockRequestPassword.mockClear();
    // The connect handler captures these at render time.
    useAppStore.setState({
      connectRemoteAgent: mockConnect,
      requestPassword: mockRequestPassword,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("connects without a password prompt", async () => {
    renderAgent(
      makeAgent({
        host: "bastion.example.com",
        port: 22,
        username: "ops",
        authMethod: "keyboard-interactive",
      })
    );

    await clickConnect();

    expect(mockRequestPassword).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledWith(AGENT_ID, undefined);
  });

  it("still prompts for a missing password with password auth", async () => {
    renderAgent(
      makeAgent({ host: "bastion.example.com", port: 22, username: "ops", authMethod: "password" })
    );

    await clickConnect();

    expect(mockRequestPassword).toHaveBeenCalledWith("bastion.example.com", "ops");
    expect(mockConnect).toHaveBeenCalledWith(AGENT_ID, "typed-pw");
  });
});
