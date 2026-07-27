/**
 * Tiered persistence badge on the tab (#2086).
 *
 * A tab attached to a persistent session carries a marker signalling that
 * closing it will detach (not terminate) the background process — but the
 * marker differs by persistence tier:
 *
 *  - **Agent-backed** (the tab was opened as a `remote-session`) → the ∞ badge,
 *    because the session lives on the agent and survives app close + machine
 *    restart.
 *  - **Desktop-local** (an ssh/docker/wsl/serial tab whose process runs inside
 *    the app) → a distinct, lesser Hourglass marker, because it only lives
 *    while the app is open.
 *
 * A tab with no `persistentConnectionId` shows neither.
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

  it("shows the lesser Hourglass marker — NOT the ∞ — for a desktop-local persistent tab", () => {
    root = renderTab(
      makeTab({
        connectionType: "ssh",
        config: { type: "ssh", config: { host: "example.com" } },
        persistentConnectionId: "ssh-1",
      })
    );
    const marker = document.querySelector(".tab__local-persistent-badge");
    expect(marker).not.toBeNull();
    // The ∞ badge must not render on a desktop-local tab.
    expect(document.querySelector(".tab__persistent-badge")).toBeNull();
    // Tooltip does not overclaim.
    expect(marker?.getAttribute("title") ?? "").toContain("Runs while the app is open");
  });

  it("shows neither marker for a non-persistent tab", () => {
    root = renderTab(makeTab({ persistentConnectionId: undefined }));
    expect(document.querySelector(".tab__persistent-badge")).toBeNull();
    expect(document.querySelector(".tab__local-persistent-badge")).toBeNull();
  });
});
