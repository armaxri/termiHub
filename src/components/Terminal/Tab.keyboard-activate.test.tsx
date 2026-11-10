/**
 * Keyboard activation of a focused tab (#5182, UX-008).
 *
 * The strip follows the WAI-ARIA tabs pattern with *manual* activation: arrows
 * move focus, Enter/Space activates the focused tab. Delete/Backspace still
 * close it, and Shift+F10 / the ContextMenu key open its context menu.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";
import { flushAsync } from "@/test/flushAsync";

const dndKeyDown = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: { onKeyDown: dndKeyDown },
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: "web-01",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "panel-1",
    isActive: false,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let onActivate: ReturnType<typeof vi.fn<() => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function renderTab(tab: TerminalTab = makeTab()) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <div role="tablist" aria-label="Open sessions">
          <Tab tab={tab} onActivate={onActivate} onClose={onClose} />
        </div>
      </TooltipProvider>
    );
  });
}

const tabEl = () => container.querySelector<HTMLElement>('[data-testid="tab-t1"]')!;

function keydown(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onActivate = vi.fn<() => void>();
  onClose = vi.fn<() => void>();
  dndKeyDown.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("Tab — keyboard activation (#5182)", () => {
  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("%s on the focused tab activates it", (_name, key) => {
    renderTab();
    tabEl().focus();
    const ev = keydown(tabEl(), { key });
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Space must not scroll the strip, and neither key may reach anything else.
    expect(ev.defaultPrevented).toBe(true);
    expect(dndKeyDown).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not propagate Enter/Space past the tab", () => {
    renderTab();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      keydown(tabEl(), { key: "Enter" });
      keydown(tabEl(), { key: " " });
    } finally {
      document.removeEventListener("keydown", outer);
    }
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])(
    "ignores Enter with a modifier (%o)",
    (mods) => {
      renderTab();
      keydown(tabEl(), { key: "Enter", ...mods });
      expect(onActivate).not.toHaveBeenCalled();
    }
  );

  it("ignores Enter fired from a descendant", () => {
    renderTab();
    const title = tabEl().querySelector<HTMLElement>(".tab__title")!;
    keydown(title, { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("advertises Enter, Space and Delete as keyboard shortcuts", () => {
    renderTab();
    expect(tabEl().getAttribute("aria-keyshortcuts")).toBe("Enter Space Delete");
  });

  it("keeps Delete/Backspace closing the tab", () => {
    renderTab();
    keydown(tabEl(), { key: "Delete" });
    keydown(tabEl(), { key: "Backspace" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("still forwards other keys to the dnd-kit listener", () => {
    renderTab();
    keydown(tabEl(), { key: "a" });
    expect(dndKeyDown).toHaveBeenCalledTimes(1);
  });

  it("keeps mouse click activation", () => {
    renderTab();
    act(() => tabEl().click());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("Tab — keyboard context menu (#5182)", () => {
  it.each([
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["ContextMenu", { key: "ContextMenu" }],
  ])("%s opens the tab's context menu", async (_name, init) => {
    renderTab();
    tabEl().focus();
    const ev = keydown(tabEl(), init);
    await flushAsync();
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-testid="tab-context-close"]')).not.toBeNull();
  });

  it("ignores plain F10", async () => {
    renderTab();
    keydown(tabEl(), { key: "F10" });
    await flushAsync();
    expect(document.querySelector('[data-testid="tab-context-close"]')).toBeNull();
  });
});
