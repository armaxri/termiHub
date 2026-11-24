/**
 * #5960: "Active sessions" marks the row whose session an open tab shows, and
 * activating that row focuses the tab instead of opening a second one. The
 * row keeps its name only (copy-style); the marker is an icon with an
 * accessible name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentSessionInfo } from "@/services/api";
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
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
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
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  agentSessionIds: (...a: unknown[]) => mockAgentSessionIds(...a),
}));

const mockAgentSessionIds = vi.fn();

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: () => null,
}));

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-open-marker-test";
const DEFINITION_ID = "def-shell-1";
const AGENT_SESSION_ID = "agent-sess-42";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
      password: "secret",
    },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

function makeDefinition(): AgentDefinitionInfo {
  return {
    id: DEFINITION_ID,
    name: "Build Shell",
    sessionType: "shell",
    config: {},
    persistent: true,
    folderId: null,
  };
}

function makeSession(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    sessionId: AGENT_SESSION_ID,
    title: "Build Shell",
    type: "shell",
    status: "running",
    attached: false,
    definitionId: DEFINITION_ID,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

const OTHER_SESSION_ID = "agent-sess-other";
const DESKTOP_SESSION_ID = "desk-1";

setupAgentsRegion();

function openAgentTab(): string {
  return useAppStore
    .getState()
    .addTab(
      "Build Shell",
      "remote-session",
      { type: "remote-session", config: { agentId: AGENT_ID, sessionType: "shell" } },
      { contentType: "terminal", sessionId: DESKTOP_SESSION_ID }
    );
}

async function renderNode() {
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(AgentNode, { agent: makeAgent() }),
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function row(sessionId: string): HTMLButtonElement {
  const label = container.querySelector(`[data-testid="agent-session-label-${sessionId}"]`);
  const button = label?.closest("button");
  if (!button) throw new Error(`no row for ${sessionId}`);
  return button as HTMLButtonElement;
}

describe("AgentNode — the session an open tab shows (#5960)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockAgentSessionIds.mockReset();
    mockAgentSessionIds.mockResolvedValue({ [DESKTOP_SESSION_ID]: AGENT_SESSION_ID });
    seedAgentsRegion({
      agentDefinitions: { [AGENT_ID]: [makeDefinition()] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: {
        [AGENT_ID]: [
          makeSession(),
          makeSession({ sessionId: OTHER_SESSION_ID, title: "Logs", definitionId: undefined }),
        ],
      },
      remoteAgents: [makeAgent()],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("marks only the row an open tab shows, with an accessible name", async () => {
    openAgentTab();
    await renderNode();

    expect(mockAgentSessionIds).toHaveBeenCalledWith([DESKTOP_SESSION_ID]);
    const marker = container.querySelector(
      `[data-testid="agent-session-open-${AGENT_SESSION_ID}"]`
    );
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-label")).toBe("Open in a tab");
    expect(
      container.querySelector(`[data-testid="agent-session-open-${OTHER_SESSION_ID}"]`)
    ).toBeNull();
    // The row's text stays the session's name.
    expect(
      container.querySelector(`[data-testid="agent-session-label-${AGENT_SESSION_ID}"]`)
        ?.textContent
    ).toBe("Build Shell");
  });

  it("clicking the marked row focuses its tab instead of opening another", async () => {
    const adopt = vi.fn().mockResolvedValue(undefined);
    const setActiveTab = vi.fn();
    const tabId = openAgentTab();
    useAppStore.setState({ adoptAndAttachAgentPersistentSession: adopt, setActiveTab });
    await renderNode();

    act(() => {
      row(AGENT_SESSION_ID).click();
    });
    expect(setActiveTab).toHaveBeenCalledWith(tabId, expect.any(String));

    act(() => {
      row(AGENT_SESSION_ID).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true })
      );
    });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("an unmarked row still opens its session in a new tab", async () => {
    const adopt = vi.fn().mockResolvedValue(undefined);
    openAgentTab();
    useAppStore.setState({ adoptAndAttachAgentPersistentSession: adopt });
    await renderNode();

    act(() => {
      row(OTHER_SESSION_ID).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true })
      );
    });
    expect(adopt).toHaveBeenCalledWith(AGENT_ID, expect.anything(), OTHER_SESSION_ID);
  });

  it("asks nothing when no tab on the agent is open", async () => {
    await renderNode();
    expect(mockAgentSessionIds).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid^="agent-session-open-"]')).toBeNull();
  });
});
