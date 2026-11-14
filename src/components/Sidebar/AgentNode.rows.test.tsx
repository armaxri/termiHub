/**
 * Names, not settings (#5770): the Remote Agents tree shows each agent, saved
 * definition and live session by name, with markers only for what needs
 * attention. The agent's address and version are in the header tooltip; a
 * definition's session type is in its row tooltip; a running session is
 * routine and gets no marker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode, agentHeaderTooltip, agentSessionStatusLabel } from "./AgentNode";
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

vi.mock("@/hooks/useDesktopVersion", () => ({ useDesktopVersion: () => "1.4.0" }));
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
vi.mock("@/components/AgentUpdateBanner", () => ({ AgentUpdateBanner: () => null }));

// The header's action buttons wrap their icons in the Radix-backed Tooltip, which
// needs a TooltipProvider. Stub it to a passthrough so isolated renders don't
// require the app-root provider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-rows-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Build box",
    config: { host: "build.example.com", port: 2222, username: "ci", authMethod: "agent" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderAgent(agent: RemoteAgentDefinition) {
  seedAgentsRegion({
    agentDefinitions: {
      [AGENT_ID]: [
        {
          id: "def-1",
          name: "Build shell",
          sessionType: "shell",
          config: { shell: "bash" },
          persistent: false,
          folderId: null,
        },
      ],
    },
    agentFolders: { [AGENT_ID]: [] },
    agentSessions: {
      [AGENT_ID]: [
        {
          sessionId: "s-run",
          title: "Running one",
          type: "shell",
          status: "running",
          attached: false,
        },
        {
          sessionId: "s-exit",
          title: "Exited one",
          type: "shell",
          status: "exited",
          attached: false,
        },
      ],
    },
    remoteAgents: [agent],
  });
  act(() => {
    root.render(React.createElement(AgentNode, { agent }));
  });
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

setupAgentsRegion();

describe("AgentNode — names, not settings (#5770)", () => {
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

  it("keeps the address off the agent header and in its tooltip", () => {
    renderAgent(makeAgent());
    const header = q(`agent-header-${AGENT_ID}`)!;
    expect(header.textContent).toContain("Build box");
    expect(header.textContent).not.toContain("build.example.com");
    expect(header.getAttribute("title")).toBe("Build box\nci@build.example.com:2222");
  });

  it("hides the version badge of an up-to-date agent, keeps it when an update is due", () => {
    type Caps = RemoteAgentDefinition["capabilities"];
    renderAgent(makeAgent({ capabilities: { agentVersion: "1.4.0" } as Caps }));
    expect(q(`agent-version-badge-${AGENT_ID}`)).toBeNull();
    expect(q(`agent-header-${AGENT_ID}`)?.getAttribute("title")).toContain("Agent version 1.4.0");

    renderAgent(makeAgent({ capabilities: { agentVersion: "1.2.0" } as Caps }));
    expect(q(`agent-version-badge-${AGENT_ID}`)?.textContent).toContain("v1.2.0");
  });

  it("shows a saved definition by name, without its session type", () => {
    renderAgent(makeAgent());
    const row = q("agent-definition-def-1")!;
    expect(row.textContent).toContain("Build shell");
    expect(row.textContent).not.toContain("shell)");
    expect(row.querySelector(".connection-tree__type")).toBeNull();
  });

  it("marks only an exited live session", () => {
    renderAgent(makeAgent());
    expect(q("agent-session-status-s-run")).toBeNull();
    expect(q("agent-session-status-s-exit")?.textContent).toBe("Exited");
  });
});

describe("agentHeaderTooltip / agentSessionStatusLabel", () => {
  it("adds the version when the agent reported one", () => {
    expect(agentHeaderTooltip(makeAgent(), "1.2.3")).toBe(
      "Build box\nci@build.example.com:2222\nAgent version 1.2.3"
    );
  });

  it("capitalises the status word", () => {
    expect(agentSessionStatusLabel("exited")).toBe("Exited");
  });
});
