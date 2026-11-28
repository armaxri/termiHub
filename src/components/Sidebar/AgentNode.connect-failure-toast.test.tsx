/**
 * A failed agent connect says why in its row and in a background toast, and
 * opens no dialog by itself (#6184). The full error stays one click away:
 * the row's and the toast's Details.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import { connectAgentWithCredentials } from "@/utils/connectAgent";

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
vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", { "data-testid": "connection-error-dialog" }) : null,
}));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

// The header's other action buttons wrap their icons in the Radix-backed
// Tooltip, which needs a TooltipProvider. Stub it to a passthrough so these
// isolated renders don't require the app-root provider — the Reconnect button
// carries its help text via a native `title`, not this primitive.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: Object.assign(vi.fn(), {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});
vi.mock("@/utils/connectAgent", () => ({ connectAgentWithCredentials: vi.fn() }));

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-connect-failure";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Edge gateway",
    config: { host: "edge.example", port: 22, username: "ops", authMethod: "password" },
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

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialog = () => document.querySelector('[data-testid="connection-error-dialog"]');
const toastError = async () => vi.mocked((await import("@/components/ui")).toast.error);

/** Click Connect and let the failed attempt settle. */
async function failConnect(error: string) {
  vi.mocked(connectAgentWithCredentials).mockRejectedValueOnce(new Error(error));
  await act(async () => {
    q(`agent-connect-${AGENT_ID}`)!.click();
  });
}

setupAgentsRegion();

describe("AgentNode — a failed connect shows the row and a toast, no dialog (#6184)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAgentSetupStatus.setState({ phases: {}, tabs: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens no dialog by itself and says why in the row", async () => {
    renderAgent(makeAgent());
    await failConnect("[thub-code:unreachable] connect timed out");
    expect(dialog()).toBeNull();
    expect(q(`agent-reason-${AGENT_ID}`)?.textContent).toContain("Could not reach edge.example.");
  });

  it("raises an error toast that names the agent and the reason, with Details", async () => {
    renderAgent(makeAgent());
    await failConnect("[thub-code:auth_failure] permission denied");
    const error = await toastError();
    expect(error).toHaveBeenCalledOnce();
    const [title, options] = error.mock.calls[0];
    expect(title).toBe("Could not connect to Edge gateway");
    expect(options?.description).toBe("edge.example refused the sign-in.");
    expect(options?.action?.label).toBe("Details");
    // The toast's Details opens the full error.
    await act(async () => {
      (options?.action as { onClick: () => void }).onClick();
    });
    expect(dialog()).not.toBeNull();
  });

  it("raises no toast for a host without the agent: the row offers Set up agent", async () => {
    renderAgent(makeAgent());
    await failConnect("[thub-code:agent_missing] not found");
    expect(await toastError()).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(q(`agent-reason-step-setup-${AGENT_ID}`)).not.toBeNull();
  });

  it("the row's Details still opens the full error", async () => {
    renderAgent(makeAgent());
    await failConnect("Broken pipe (os error 32)");
    expect(dialog()).toBeNull();
    act(() => q(`agent-reason-step-details-${AGENT_ID}`)!.click());
    expect(dialog()).not.toBeNull();
  });
});
