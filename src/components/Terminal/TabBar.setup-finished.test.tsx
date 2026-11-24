/**
 * A finished agent setup tab's status icon (#5980).
 *
 * After "Agent installed" the setup tab kept the red disconnected plug, which
 * read as an error on a tab that finished correctly. A setup tab whose setup
 * exited 0 now shows a success check labelled "Finished"; a failed setup, a
 * dropped link and every other tab keep their status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useShellPromptStore } from "@/store/shellPromptStore";
import { TerminalTab } from "@/types/terminal";
import { useAgentSetupStatus, type AgentSetupTab } from "@/store/agentSetupStatus";
import {
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";

// Render the *real* Tab so we exercise the actual state-dot markup, but stub out
// the dnd-kit sortable wrapper and the terminal registry so the component mounts
// cleanly in jsdom.
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    clearTerminal: vi.fn(),
    saveTerminalToFile: vi.fn().mockResolvedValue(undefined),
    copyTerminalToClipboard: vi.fn().mockResolvedValue(undefined),
    openTerminalInEditor: vi.fn(),
  }),
}));

vi.mock("./ColorPickerDialog", () => ({ ColorPickerDialog: () => null }));
vi.mock("./RenameDialog", () => ({ RenameDialog: () => null }));

const PANEL_ID = "panel-1";

// The connecting/reconnecting AND disconnected(exited) status the dot reads is
// sourced purely from the projected `session-lifecycle` region (#2205 / #2625), so
// seed the region for those states. Only the failed dot still reads its `appStore`
// slice (`terminalSpawnErrors`).
const harness = installSessionLifecycleHarness();

function makeTerminalTab(id: string, isActive: boolean): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    // Concrete connection type — NOT "remote" (the old dead-code path).
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: PANEL_ID,
    isActive,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(tabs: TerminalTab[]) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBar panelId={PANEL_ID} tabs={tabs} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

/** Return the state-dot element for a given tab id, or null. */
function dotFor(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="tab-state-dot-${tabId}"]`);
}

function resetStore() {
  useAppStore.setState({
    terminalSpawnErrors: {},
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetStore();
  useShellPromptStore.setState({ awaitingFirstPrompt: {} });
  useAgentSetupStatus.setState({ phases: {}, tabs: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function registerSetupTab(tabId: string, overrides: Partial<AgentSetupTab> = {}) {
  useAgentSetupStatus.setState({
    tabs: {
      [tabId]: {
        agentId: "agent-1",
        agentName: "build-box",
        reportsExit: true,
        progress: { kind: "running" },
        dismissed: false,
        ...overrides,
      },
    },
  });
}

describe("TabBar — finished agent setup tab (#5980)", () => {
  it("shows a success check, not the red plug, once the setup exited 0", async () => {
    registerSetupTab("t1");
    harness.transport.setSession("t1", withExit(disconnected("unexpected"), exitInfo(0)));
    await render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    const dot = dotFor("t1");
    expect(dot?.className).toContain("tab__state-dot--finished");
    expect(dot?.getAttribute("aria-label")).toBe("Finished");
  });

  it("keeps the success check after the user closed the setup strip", async () => {
    registerSetupTab("t1", { dismissed: true });
    harness.transport.setSession("t1", withExit(disconnected("unexpected"), exitInfo(0)));
    await render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    expect(dotFor("t1")?.className).toContain("tab__state-dot--finished");
  });

  it("keeps the red plug for a setup that failed", async () => {
    registerSetupTab("t1");
    harness.transport.setSession("t1", withExit(disconnected("unexpected"), exitInfo(1)));
    await render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    expect(dotFor("t1")?.className).toContain("tab__state-dot--disconnected");
  });

  it("keeps the red plug for an ordinary tab that exited 0", async () => {
    harness.transport.setSession("t1", withExit(disconnected("unexpected"), exitInfo(0)));
    await render([makeTerminalTab("t1", true)]);
    await flushSessionRegion();
    expect(dotFor("t1")?.className).toContain("tab__state-dot--disconnected");
  });
});

function exitInfo(code: number) {
  return { code, reason: "clean" as const };
}
