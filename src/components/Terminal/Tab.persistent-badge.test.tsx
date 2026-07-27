/**
 * Persistence marker on the tab (#2099).
 *
 * The ∞ badge — signalling that closing the tab detaches (not terminates) the
 * background process — appears ONLY on agent persistent shells: tabs opened as
 * a `remote-session`, whose session lives on the remote agent and survives app
 * close + machine restart.
 *
 * A desktop-local tab (an ssh/docker/wsl/serial tab whose process runs inside
 * the app) is multi-instance and dies with the window, so it shows NO marker at
 * all — no ∞ and no hourglass. A tab with no `persistentConnectionId` likewise
 * shows nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";

// Stub the dnd-kit sortable wrapper so the Tab mounts without a DndContext.
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

const PANEL_ID = "panel-1";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: "My Session",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "example.com" } },
    panelId: PANEL_ID,
    isActive: true,
    ...overrides,
  };
}

function renderTab(tab: TerminalTab) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab tab={tab} onActivate={() => {}} onClose={() => {}} />
      </TooltipProvider>
    );
  });
  return root;
}

describe("Tab — tiered persistence badge (#2086)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("shows the ∞ badge for an agent-backed (remote-session) persistent tab", () => {
    root = renderTab(
      makeTab({
        connectionType: "remote-session",
        config: { type: "remote-session", config: { agentId: "a1", sessionType: "shell" } },
        persistentConnectionId: "a1:def-1",
      })
    );
    const badge = document.querySelector(".tab__persistent-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("∞");
    // Never the desktop-local marker for an agent-backed tab.
    expect(document.querySelector(".tab__local-persistent-badge")).toBeNull();
    // Tooltip makes the strong (cross-restart) claim.
    expect(badge?.getAttribute("title") ?? "").toContain("restarting this machine");
  });

  it("shows NO marker for a desktop-local persistent tab (#2099)", () => {
    root = renderTab(
      makeTab({
        connectionType: "ssh",
        config: { type: "ssh", config: { host: "example.com" } },
        persistentConnectionId: "ssh-1",
      })
    );
    // A desktop-local tab dies with the window, so it carries no persistence
    // marker — neither the ∞ nor the old hourglass.
    expect(document.querySelector(".tab__persistent-badge")).toBeNull();
    expect(document.querySelector(".tab__local-persistent-badge")).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("∞");
  });

  it("shows no marker for a non-persistent tab", () => {
    root = renderTab(makeTab({ persistentConnectionId: undefined }));
    expect(document.querySelector(".tab__persistent-badge")).toBeNull();
    expect(document.querySelector(".tab__local-persistent-badge")).toBeNull();
  });
});
