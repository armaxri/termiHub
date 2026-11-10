/**
 * #5156: an agent's saved password that the server rejects is never deleted.
 * The re-prompt says it is kept and offers "Replace saved password"; a
 * replacement is written only after the retry connects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { removeCredential, storeCredential } from "@/services/api";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";

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

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
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

const AGENT_ID = "agent-cred-rejection-test";

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

const AUTH_FAILED = new Error("[thub-code:auth_failed] Authentication failed");

describe("AgentNode — rejected saved password (#5156)", () => {
  const mockConnect = vi.fn();
  const mockRequestPassword = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.mocked(removeCredential).mockClear();
    vi.mocked(storeCredential).mockClear();
    mockConnect.mockReset();
    mockRequestPassword.mockReset();
    vi.mocked(resolveConnectionCredential).mockResolvedValue({
      usedStoredCredential: true,
      password: "saved-pw",
      credentialType: "password",
    } as Awaited<ReturnType<typeof resolveConnectionCredential>>);
    useAppStore.setState({
      connectRemoteAgent: mockConnect,
      requestPassword: mockRequestPassword,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const agent = () =>
    makeAgent({
      host: "bastion.example.com",
      port: 22,
      username: "ops",
      authMethod: "password",
      savePassword: true,
    });

  it("keeps the saved password and re-prompts with the replace choice", async () => {
    mockConnect.mockRejectedValueOnce(AUTH_FAILED).mockResolvedValueOnce(undefined);
    mockRequestPassword.mockResolvedValue(null);
    renderAgent(agent());

    await clickConnect();

    expect(removeCredential).not.toHaveBeenCalled();
    expect(mockRequestPassword).toHaveBeenCalledWith(
      "bastion.example.com",
      "ops",
      expect.stringContaining("It is kept"),
      "password",
      { savedRejected: true, label: "Bastion Agent" }
    );
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it("replaces the saved password only after the retry connects", async () => {
    mockConnect.mockRejectedValueOnce(AUTH_FAILED).mockResolvedValueOnce(undefined);
    mockRequestPassword.mockResolvedValue({ password: "new-pw", shouldSave: true });
    renderAgent(agent());

    await clickConnect();

    expect(mockConnect).toHaveBeenLastCalledWith(AGENT_ID, "new-pw");
    expect(storeCredential).toHaveBeenCalledWith(AGENT_ID, "password", "new-pw");
    expect(removeCredential).not.toHaveBeenCalled();
  });

  it("never saves a retry password the server also rejects (a typo)", async () => {
    mockConnect.mockRejectedValue(AUTH_FAILED);
    mockRequestPassword.mockResolvedValue({ password: "typo-pw", shouldSave: true });
    renderAgent(agent());

    await clickConnect();

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(storeCredential).not.toHaveBeenCalled();
    expect(removeCredential).not.toHaveBeenCalled();
  });

  it("uses an unticked retry password for this connect only", async () => {
    mockConnect.mockRejectedValueOnce(AUTH_FAILED).mockResolvedValueOnce(undefined);
    mockRequestPassword.mockResolvedValue({ password: "once-pw", shouldSave: false });
    renderAgent(agent());

    await clickConnect();

    expect(mockConnect).toHaveBeenLastCalledWith(AGENT_ID, "once-pw");
    expect(storeCredential).not.toHaveBeenCalled();
    expect(removeCredential).not.toHaveBeenCalled();
  });
});
