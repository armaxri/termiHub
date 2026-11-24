/**
 * Agent rows (#5851): the agent's name gets the row width, empty states name
 * their action, and a host without the agent is a neutral next step.
 *
 *  - R-015 / R-047: Connect / Reconnect are icon buttons; the description sits
 *    in the name's text column. jsdom does not lay out, so the narrow-width
 *    cases lock the structure and the CSS rules that let only the name shrink.
 *  - R-013: a connected agent with nothing saved says "No connections yet."
 *    with a "New connection" link, not "Right-click to create one."
 *  - R-095: a connect that finds no agent leaves the row neutral ("Agent not
 *    installed", grey dot) with Set up agent, not red + Reconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode, agentRowPresentation } from "./AgentNode";
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
vi.mock("./AgentSetupDialog", () => ({
  AgentSetupDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", { "data-testid": "setup-dialog-open" }) : null,
}));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("@/components/AgentUpdateBanner", () => ({
  AgentUpdateBanner: () => null,
  AgentUpdateMarker: () => null,
  countAgentSessionTabs: () => 0,
}));
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-rows-test";
const LONG_NAME = "sys-pr-agent-5d5f-with-a-long-name-the-user-gave";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: LONG_NAME,
    config: {
      host: "build-01.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
      password: "secret",
    },
    connectionState: "disconnected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderAgent(agent: RemoteAgentDefinition, width = 240) {
  container.style.width = `${width}px`;
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

const q = <T extends HTMLElement = HTMLElement>(id: string) =>
  container.querySelector<T>(`[data-testid="${id}"]`);

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The declarations of `selector`'s first rule in ConnectionList.css. */
function cssRule(selector: string): string {
  const css = readFileSync(resolve(__dirname, "ConnectionList.css"), "utf8");
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

setupAgentsRegion();

describe("AgentNode — agent rows (#5851)", () => {
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

  describe.each([160, 240, 320])("at a %ipx sidebar", (width) => {
    it.each([
      ["never connected", {}, "agent-connect"],
      ["failed", { lastError: "boom" }, "agent-reconnect"],
      ["connected", { connectionState: "connected" as const }, "agent-more"],
    ])("%s: the actions are text-free icons beside the full name", (_l, over, actionId) => {
      renderAgent(makeAgent(over), width);
      const name = q(`agent-name-${AGENT_ID}`);
      expect(name?.textContent).toBe(LONG_NAME);
      const action = q(`${actionId}-${AGENT_ID}`);
      expect(action).not.toBeNull();
      // An icon button: no visible text competes with the name for the row.
      expect(action!.textContent).toBe("");
      expect(action!.getAttribute("aria-label")).toBeTruthy();
      const actions = action!.closest(".connection-list__group-actions--inline");
      const row = name!.closest(".connection-list__group-row");
      expect(actions?.parentElement).toBe(row);
      // At most two buttons ever sit beside the name.
      expect(actions!.querySelectorAll("button").length).toBeLessThanOrEqual(2);
    });
  });

  it("lets only the name shrink: the text column flexes, markers and actions do not", () => {
    expect(cssRule(".connection-list__group-text")).toMatch(/flex: 1 1 auto/);
    expect(cssRule(".connection-list__group-text")).toMatch(/min-width: 0/);
    expect(cssRule(".connection-list__group-title")).toMatch(/text-overflow: ellipsis/);
    expect(
      cssRule(".connection-list__group-header--agent .connection-list__group-actions--inline")
    ).toMatch(/flex-shrink: 0/);
    // The description is no longer indented by a guessed padding (R-047).
    expect(cssRule(".connection-list__group-description")).not.toMatch(/padding-left/);
  });

  it("keeps the description under the name, in its text column", () => {
    renderAgent(makeAgent({ description: "Lab bench" }), 160);
    const desc = q(`agent-description-${AGENT_ID}`);
    expect(desc?.parentElement).toBe(q(`agent-name-${AGENT_ID}`)?.parentElement);
    expect(desc?.closest(".connection-list__group-row")?.className).toContain(
      "connection-list__group-row--described"
    );
  });

  describe("empty states name their action", () => {
    it("a connected agent with nothing saved offers New connection as a link", () => {
      const openEditor = vi.fn();
      useAppStore.setState({ openAgentDefinitionEditorTab: openEditor });
      renderAgent(makeAgent({ connectionState: "connected" }));
      const empty = q(`agent-empty-${AGENT_ID}`);
      expect(empty?.textContent).toBe("No connections yet. New connection");
      expect(empty?.textContent).not.toContain("Right-click");
      act(() => q(`agent-empty-new-connection-${AGENT_ID}`)!.click());
      expect(openEditor).toHaveBeenCalledWith(AGENT_ID, "new", null);
    });

    it("a disconnected agent offers Connect as a link", async () => {
      const connect = vi.fn().mockResolvedValue(undefined);
      useAppStore.setState({ connectRemoteAgent: connect });
      renderAgent(makeAgent());
      expect(q(`agent-empty-${AGENT_ID}`)?.textContent).toBe("Not connected. Connect");
      await act(async () => q(`agent-empty-connect-${AGENT_ID}`)!.click());
      await settle();
      expect(connect).toHaveBeenCalledWith(AGENT_ID, undefined);
    });
  });

  describe("not installed is a neutral next step (R-095)", () => {
    it("maps not-installed to a neutral presentation with Set up agent", () => {
      expect(agentRowPresentation("disconnected", true, true)).toEqual({
        tone: "disabled",
        label: "Agent not installed",
        action: "setup",
      });
      // A live connection always wins.
      expect(agentRowPresentation("connected", false, true).action).toBeNull();
    });

    it("a connect that finds no agent leaves the row neutral with Set up agent", async () => {
      useAppStore.setState({
        connectRemoteAgent: vi.fn().mockRejectedValue({
          code: "agent_missing",
          message: "termihub-agent: not found",
          details: null,
        }),
      });
      renderAgent(makeAgent());
      await act(async () => q(`agent-connect-${AGENT_ID}`)!.click());
      await settle();

      const dot = q(`agent-state-${AGENT_ID}`);
      expect(dot?.className).toContain("status-dot--disabled");
      expect(dot?.className).not.toContain("status-dot--disconnected");
      expect(dot?.getAttribute("aria-label")).toBe("Agent not installed");
      expect(q(`agent-reconnect-${AGENT_ID}`)).toBeNull();
      expect(q(`agent-setup-${AGENT_ID}`)?.getAttribute("aria-label")).toBe("Set up agent");
      expect(q(`agent-empty-${AGENT_ID}`)?.textContent).toBe(
        "The agent is not installed on build-01.example.com yet. Set up agent"
      );

      act(() => q(`agent-setup-${AGENT_ID}`)!.click());
      expect(document.querySelector('[data-testid="setup-dialog-open"]')).not.toBeNull();
    });

    it("a stored not-installed error stays neutral after a remount", () => {
      renderAgent(makeAgent({ lastError: "[thub-code:agent_missing] not found" }));
      expect(q(`agent-state-${AGENT_ID}`)?.className).toContain("status-dot--disabled");
      expect(q(`agent-setup-${AGENT_ID}`)).not.toBeNull();
    });

    it("any other failure is still red + Reconnect", async () => {
      useAppStore.setState({
        connectRemoteAgent: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      renderAgent(makeAgent());
      await act(async () => q(`agent-connect-${AGENT_ID}`)!.click());
      await settle();
      expect(q(`agent-state-${AGENT_ID}`)?.className).toContain("status-dot--disconnected");
      expect(q(`agent-reconnect-${AGENT_ID}`)).not.toBeNull();
      expect(q(`agent-setup-${AGENT_ID}`)).toBeNull();
    });
  });
});
