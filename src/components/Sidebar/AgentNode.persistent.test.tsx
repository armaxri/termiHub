/**
 * Persistent-session row actions in the Remote Agents tree (#5322, COV-027).
 *
 * A persistent agent shell row carries inline Start / Attach / Stop buttons and
 * the matching context-menu items. Each one calls through to the real
 * persistent-session store actions (which reach the backend via the mocked
 * `@/services/api`), and each inline button stops the click from bubbling, so
 * pressing it never also selects the row underneath.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import {
  DEFAULT_AGENT_SETTINGS,
  type PersistentSessionEntry,
  type RemoteAgentDefinition,
} from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";
import { attachPersistentTab, startPersistentSession, stopPersistentSession } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { collectLiveTabs } from "@/store/layoutHelpers";

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

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  startPersistentSession: vi.fn(() => Promise.resolve("sess-new")),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  attachPersistentTab: vi.fn(() => Promise.resolve()),
  adoptPersistentSession: vi.fn(() => Promise.resolve()),
  updateAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-persistent-test";
const DEF_ID = "shell-1";
const CONNECTION_ID = `${AGENT_ID}:${DEF_ID}`;

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Persistent Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
  };
}

const DEFINITION: AgentDefinitionInfo = {
  id: DEF_ID,
  name: "Build Shell",
  sessionType: "shell",
  config: { shell: "bash" },
  persistent: true,
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function seed(entry?: PersistentSessionEntry) {
  useAppStore.setState(useAppStore.getInitialState());
  seedAgentsRegion({
    remoteAgents: [makeAgent()],
    agentDefinitions: { [AGENT_ID]: [DEFINITION] },
    agentFolders: { [AGENT_ID]: [] },
    agentSessions: {},
  });
  if (entry) useAppStore.setState({ persistentSessions: { [CONNECTION_ID]: entry } });
}

function runningEntry(): PersistentSessionEntry {
  return { connectionId: CONNECTION_ID, sessionId: "sess-1", state: "running", attachedTabIds: [] };
}

async function render() {
  await act(async () => {
    root.render(React.createElement(AgentNode, { agent: makeAgent() }));
  });
}

const q = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) as HTMLElement;
const row = () => q(`agent-definition-${DEF_ID}`);

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flushAsync();
}

async function openMenuItem(testId: string) {
  act(() => {
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  await flushAsync();
  const item = q(testId);
  expect(item).not.toBeNull();
  await click(item);
}

function remoteTabs() {
  return collectLiveTabs(useAppStore.getState()).filter(
    (t) => t.persistentConnectionId === CONNECTION_ID
  );
}

setupAgentsRegion();

describe("AgentNode — persistent-session row actions (#5322)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a plain row click selects the row (control for the stopPropagation checks)", async () => {
    seed();
    await render();
    await click(row());
    expect(row().getAttribute("aria-selected")).toBe("true");
  });

  it("Start calls startPersistentSession and does not select the row", async () => {
    seed();
    await render();
    expect(q(`persistent-attach-${DEF_ID}`)).toBeNull();

    await click(q(`persistent-start-${DEF_ID}`));

    expect(startPersistentSession).toHaveBeenCalledWith(
      CONNECTION_ID,
      "shell",
      { shell: "bash", title: "Build Shell", definitionId: DEF_ID },
      AGENT_ID
    );
    expect(useAppStore.getState().persistentSessions[CONNECTION_ID]).toMatchObject({
      sessionId: "sess-new",
      state: "starting",
    });
    expect(row().getAttribute("aria-selected")).toBe("false");
    // Start alone opens no tab.
    expect(attachPersistentTab).not.toHaveBeenCalled();
    expect(remoteTabs()).toHaveLength(0);
  });

  it("Start is offered again after the session stopped or errored", async () => {
    seed({ ...runningEntry(), state: "error", errorMessage: "boom" });
    await render();
    expect(q(`persistent-start-${DEF_ID}`)).not.toBeNull();
    expect(q(`persistent-stop-${DEF_ID}`)).toBeNull();
  });

  it("Attach opens a tab bound to the running session and does not select the row", async () => {
    seed(runningEntry());
    await render();
    expect(q(`persistent-start-${DEF_ID}`)).toBeNull();

    await click(q(`persistent-attach-${DEF_ID}`));

    // Already running: no second start, just a new attached tab.
    expect(startPersistentSession).not.toHaveBeenCalled();
    const tabs = remoteTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].sessionId).toBe("sess-1");
    expect(attachPersistentTab).toHaveBeenCalledWith(CONNECTION_ID, tabs[0].id);
    expect(useAppStore.getState().persistentSessions[CONNECTION_ID].attachedTabIds).toEqual([
      tabs[0].id,
    ]);
    expect(row().getAttribute("aria-selected")).toBe("false");
  });

  it("Stop calls stopPersistentSession and does not select the row", async () => {
    seed(runningEntry());
    await render();

    await click(q(`persistent-stop-${DEF_ID}`));

    expect(stopPersistentSession).toHaveBeenCalledWith(CONNECTION_ID);
    expect(useAppStore.getState().persistentSessions[CONNECTION_ID].state).toBe("stopping");
    expect(row().getAttribute("aria-selected")).toBe("false");
    // A stopping session offers neither Start nor Attach/Stop.
    expect(q(`persistent-start-${DEF_ID}`)).toBeNull();
    expect(q(`persistent-stop-${DEF_ID}`)).toBeNull();
  });

  it("double-clicking a stopped persistent row starts the session and attaches a tab", async () => {
    seed();
    await render();

    await act(async () => {
      row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await flushAsync();

    expect(startPersistentSession).toHaveBeenCalledTimes(1);
    const tabs = remoteTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].sessionId).toBe("sess-new");
    expect(attachPersistentTab).toHaveBeenCalledWith(CONNECTION_ID, tabs[0].id);
  });

  it("the context menu's Start item starts the session", async () => {
    seed();
    await render();
    await openMenuItem("context-agent-def-start-persistent");
    expect(startPersistentSession).toHaveBeenCalledTimes(1);
    expect(attachPersistentTab).not.toHaveBeenCalled();
  });

  it("the context menu's Attach and Stop items reach the running session", async () => {
    seed(runningEntry());
    await render();
    expect(q("context-agent-def-start-persistent")).toBeNull();

    await openMenuItem("context-agent-def-attach-persistent");
    expect(remoteTabs()).toHaveLength(1);
    expect(attachPersistentTab).toHaveBeenCalledTimes(1);

    await openMenuItem("context-agent-def-stop-persistent");
    expect(stopPersistentSession).toHaveBeenCalledWith(CONNECTION_ID);
  });
});
