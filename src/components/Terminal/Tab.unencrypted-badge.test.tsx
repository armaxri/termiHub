/**
 * The "Unencrypted" badge on telnet tabs (#5749): telnet sends everything,
 * passwords included, in clear text, so its tabs carry a state badge. SSH and
 * other tabs carry none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";

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

function makeTab(config: ConnectionConfig, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: "Lab switch",
    connectionType: config.type,
    contentType: "terminal",
    config,
    panelId: "panel-1",
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

const badge = () => document.querySelector('[data-testid="tab-unencrypted-badge-t1"]');

describe("Tab — Unencrypted badge (#5749)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("marks a telnet tab as unencrypted", () => {
    root = renderTab(makeTab({ type: "telnet", config: { host: "10.0.0.7", port: 23 } }));
    expect(badge()?.textContent).toBe("Unencrypted");
    expect(badge()?.getAttribute("title")).toBe(
      "Telnet sends everything unencrypted, passwords included."
    );
    // #5740: primary text on the warning tint (UnencryptedBadge.css).
    expect(badge()?.classList.contains("unencrypted-badge")).toBe(true);
  });

  it("marks a telnet session on a remote agent", () => {
    root = renderTab(
      makeTab({ type: "remote-session", config: { sessionType: "telnet", agentId: "a1" } })
    );
    expect(badge()).not.toBeNull();
  });

  it("does not mark an SSH tab", () => {
    root = renderTab(makeTab({ type: "ssh", config: { host: "h", username: "u" } }));
    expect(badge()).toBeNull();
  });

  it("does not mark an agent shell session", () => {
    root = renderTab(
      makeTab({ type: "remote-session", config: { sessionType: "shell", agentId: "a1" } })
    );
    expect(badge()).toBeNull();
  });

  it("does not mark a non-terminal tab", () => {
    root = renderTab(
      makeTab({ type: "telnet", config: { host: "h" } }, { contentType: "connection-editor" })
    );
    expect(badge()).toBeNull();
  });
});
