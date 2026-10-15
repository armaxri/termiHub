/**
 * Accessibility regressions for the terminal tab (#4351).
 *
 * - A11Y2-010: the unsaved, broadcast and persistent badges carry accessible
 *   text (role="img" + aria-label), so tab state is announced, not just drawn.
 * - A11Y2-011: no interactive control is nested inside `role="tab"`. The close
 *   glyph and the controlled-by-window badge are pointer-only affordances;
 *   keyboard users close the focused tab with Delete/Backspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";
import { checkA11y } from "@/test/axe";
import { getByRole, queryAllByRole, accessibleName } from "@/test/accessibleRoles";

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

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: "web-01",
    connectionType: "remote-session",
    contentType: "terminal",
    config: { type: "remote-session", config: {} },
    panelId: "panel-1",
    isActive: true,
    persistentConnectionId: "agent-1",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

interface RenderOpts {
  tab?: TerminalTab;
  onClose?: () => void;
  onFocusOwningWindow?: (label: string) => void;
}

function renderTab({ tab = makeTab(), onClose = () => {}, onFocusOwningWindow }: RenderOpts = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <div role="tablist" aria-label="Open sessions">
          <Tab
            tab={tab}
            onActivate={() => {}}
            onClose={onClose}
            isDirty
            isBroadcast
            status="connected"
            controlledByWindow={{ label: "win-2", name: "Window 2" }}
            onFocusOwningWindow={onFocusOwningWindow}
          />
        </div>
      </TooltipProvider>
    );
  });
}

const tabEl = () => container.querySelector<HTMLElement>('[data-testid="tab-t1"]')!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Tab badges have accessible text (A11Y2-010)", () => {
  it("announces the unsaved, broadcast and persistent badges as labelled images", () => {
    renderTab();
    expect(getByRole("img", "Unsaved changes", container)).toBe(
      container.querySelector('[data-testid="tab-dirty-dot-t1"]')
    );
    expect(
      getByRole("img", "Broadcast target: input is sent to all group members", container)
    ).toBe(container.querySelector('[data-testid="tab-broadcast-badge-t1"]'));
    expect(getByRole("img", "Persistent session", container)).toBe(
      container.querySelector('[data-testid="tab-persistent-badge-t1"]')
    );
  });

  it("hides the decorative icon and glyph inside each badge", () => {
    renderTab();
    const broadcast = container.querySelector('[data-testid="tab-broadcast-badge-t1"]')!;
    expect(broadcast.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const persistent = container.querySelector('[data-testid="tab-persistent-badge-t1"]')!;
    expect(persistent.querySelector("[aria-hidden]")?.textContent).toBe("∞");
  });

  it("folds the badge state into the tab's accessible name, without 'infinity' or 'Close'", () => {
    renderTab();
    const name = accessibleName(tabEl());
    expect(name).toContain("Unsaved changes");
    expect(name).toContain("web-01");
    expect(name).toContain("Broadcast target");
    expect(name).toContain("Persistent session");
    expect(name).not.toContain("∞");
    expect(name).not.toMatch(/close/i);
  });
});

describe("Tab has no nested interactive controls (A11Y2-011)", () => {
  it("contains no button or focusable descendant inside role=tab", () => {
    renderTab();
    const tab = getByRole("tab", undefined, container);
    expect(queryAllByRole("button", undefined, tab)).toHaveLength(0);
    expect(
      tab.querySelectorAll("button, [tabindex], a[href], input, select, textarea")
    ).toHaveLength(0);
  });

  it("keeps the close glyph clickable but hidden from assistive tech", () => {
    const onClose = vi.fn();
    renderTab({ onClose });
    const close = container.querySelector<HTMLElement>('[data-testid="tab-close-t1"]')!;
    expect(close.getAttribute("aria-hidden")).toBe("true");
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the controlled-by-window badge clickable as a labelled image", () => {
    const onFocus = vi.fn();
    renderTab({ onFocusOwningWindow: onFocus });
    const badge = getByRole("img", /Taken over by Window 2/, container);
    act(() => (badge as HTMLElement).click());
    expect(onFocus).toHaveBeenCalledWith("win-2");
  });

  it.each(["Delete", "Backspace"])("closes the focused tab with %s", (key) => {
    const onClose = vi.fn();
    renderTab({ onClose });
    const tab = tabEl();
    expect(tab.getAttribute("aria-keyshortcuts")).toBe("Delete");
    act(() => {
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Delete with a modifier", () => {
    const onClose = vi.fn();
    renderTab({ onClose });
    act(() => {
      tabEl().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true })
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers 'Close Tab' and 'Focus <window>' in the context menu as keyboard twins", () => {
    const onClose = vi.fn();
    const onFocus = vi.fn();
    renderTab({ onClose, onFocusOwningWindow: onFocus });
    const openMenu = () =>
      act(() => {
        tabEl().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      });
    const pick = (testId: string) => {
      const item = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      expect(item).not.toBeNull();
      act(() => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    openMenu();
    pick("tab-context-focus-owning-window");
    expect(onFocus).toHaveBeenCalledWith("win-2");
    openMenu();
    pick("tab-context-close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations (nested-interactive, aria-required-children, names)", async () => {
    renderTab();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
