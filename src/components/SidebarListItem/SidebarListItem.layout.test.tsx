/**
 * SidebarListItem narrow-width layout (#4709, #4972): hover/focus actions must not
 * reserve width while hidden, so the row name gets the whole row and only
 * truncates (with a tooltip) when it really does not fit.
 *
 * jsdom does not apply stylesheets, so the layout contract is pinned on the
 * DOM structure plus the rules in `SidebarListItem.css`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SidebarListItem, overlayCoversName, NAME_STUB_EM } from "./SidebarListItem";
import { installResizeObserverMock } from "@/test/resizeObserver";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "SidebarListItem.css"),
  "utf8"
);

/** The declaration block of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no CSS rule for ${selector}`);
  return match[1];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderRow(actions: React.ReactNode, error = false) {
  act(() =>
    root.render(
      withTooltip(
        <SidebarListItem
          testId="row"
          nameTestId="row-name"
          name="test-workspace-with-a-long-name"
          error={error}
          actions={actions}
        />
      )
    )
  );
}

describe("SidebarListItem — names get the full row width (#4709)", () => {
  it("lays hidden actions over the row instead of beside the name", () => {
    const actions = rule(".sidebar-list-item__actions");
    expect(actions).toMatch(/position:\s*absolute/);
    expect(actions).toMatch(/opacity:\s*0/);
    expect(actions).toMatch(/pointer-events:\s*none/);
    // A long action set wraps inside the row instead of clipping off its edge.
    expect(actions).toMatch(/max-width:\s*100%/);
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    // The overlay is anchored to the header row.
    expect(rule(".sidebar-list-item__header")).toMatch(/position:\s*relative/);
  });

  it("lets the name take all remaining width and shrink below its content", () => {
    const name = rule(".sidebar-list-item__name");
    // It also shrinks before a short type badge does (#4954).
    expect(name).toMatch(/flex:\s*1 1000 auto/);
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("reveals the actions on hover and keyboard focus", () => {
    expect(CSS).toMatch(
      /\.sidebar-list-item:hover \.sidebar-list-item__actions,\s*\.sidebar-list-item:focus-within \.sidebar-list-item__actions\s*\{[^}]*opacity:\s*1/
    );
  });

  it("keeps an errored row's recovery actions in the flow and visible", () => {
    const err = rule(".sidebar-list-item--error .sidebar-list-item__actions");
    expect(err).toMatch(/position:\s*static/);
    expect(err).toMatch(/opacity:\s*1/);
  });

  it("renders the name as the only flex child besides the overlay", () => {
    renderRow(<button aria-label="Launch">L</button>);
    const header = container.querySelector(".sidebar-list-item__header") as HTMLElement;
    const name = container.querySelector('[data-testid="row-name"]') as HTMLElement;
    expect(name.parentElement).toBe(header);
    expect(name.classList.contains("sidebar-list-item__name")).toBe(true);
    expect(name.textContent).toBe("test-workspace-with-a-long-name");
    // Actions stay in the DOM (and focusable) for keyboard and tests.
    expect(header.querySelector(".sidebar-list-item__actions button")).not.toBeNull();
  });

  it("renders no actions container when there are no actions", () => {
    renderRow(null);
    expect(container.querySelector(".sidebar-list-item__actions")).toBeNull();
  });

  it("has no axe violations", async () => {
    renderRow(<button aria-label="Launch">L</button>);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

/**
 * Fake layout for the measured parts of a row: jsdom reports 0 for every box,
 * so pin the header width, where the name starts, the name's content width and
 * each action button's width.
 */
function fakeLayout(m: { header: number; nameLeft: number; nameContent: number; button: number }) {
  const has = (el: Element, cls: string) => el.classList.contains(cls);
  const spies = [
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return has(this, "sidebar-list-item__header") ? m.header : 0;
    }),
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return has(this, "sidebar-list-item__name") ? m.nameLeft : 0;
    }),
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return has(this, "sidebar-list-item__name") ? m.nameContent : 0;
    }),
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const width = this.tagName === "BUTTON" ? m.button : 0;
      return { width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0 } as DOMRect;
    }),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}

const SIX_ACTIONS = (
  <>
    {["Reconnect", "Stop", "Edit", "Duplicate", "Delete", "Open"].map((label) => (
      <button key={label} aria-label={label}>
        {label[0]}
      </button>
    ))}
  </>
);

describe("SidebarListItem — actions move to a second line on narrow rows (#4972)", () => {
  it("decides from the stub of the name the overlay would leave", () => {
    const base = { header: 176, nameLeft: 60, nameContent: 300, fontSize: 12 };
    // Six 22px buttons (≈140px) leave 176-60-140 = -24px of name: cover.
    expect(overlayCoversName({ ...base, actions: 140 })).toBe(true);
    // One button leaves well over the stub.
    expect(overlayCoversName({ ...base, actions: 26 })).toBe(false);
    // Exactly the stub left: still fits.
    expect(overlayCoversName({ ...base, actions: 176 - 60 - NAME_STUB_EM * 12 })).toBe(false);
    // A short name only needs its own width.
    expect(overlayCoversName({ ...base, nameContent: 20, actions: 90 })).toBe(false);
    // No layout yet (hidden sidebar): never stack.
    expect(overlayCoversName({ ...base, header: 0, actions: 140 })).toBe(false);
  });

  it("stacks a narrow row with many actions and keeps a wide one as an overlay", () => {
    const ro = installResizeObserverMock();
    const restore = fakeLayout({ header: 176, nameLeft: 60, nameContent: 300, button: 22 });
    try {
      renderRow(SIX_ACTIONS);
      const row = container.querySelector('[data-testid="row"]') as HTMLElement;
      expect(row.classList.contains("sidebar-list-item--stacked-actions")).toBe(true);
      restore();
      // The sidebar is widened: the overlay leaves the name a stub again.
      const restoreWide = fakeLayout({ header: 400, nameLeft: 60, nameContent: 300, button: 22 });
      ro.resize(400);
      expect(row.classList.contains("sidebar-list-item--stacked-actions")).toBe(false);
      restoreWide();
    } finally {
      restore();
      ro.restore();
    }
  });

  it("keeps a narrow row with few actions as an overlay", () => {
    const restore = fakeLayout({ header: 176, nameLeft: 60, nameContent: 300, button: 22 });
    try {
      renderRow(<button aria-label="Launch">L</button>);
      const row = container.querySelector('[data-testid="row"]') as HTMLElement;
      expect(row.classList.contains("sidebar-list-item--stacked-actions")).toBe(false);
    } finally {
      restore();
    }
  });

  it("never stacks an errored row (its actions are already in the flow)", () => {
    const restore = fakeLayout({ header: 176, nameLeft: 60, nameContent: 300, button: 22 });
    try {
      renderRow(SIX_ACTIONS, true);
      const row = container.querySelector('[data-testid="row"]') as HTMLElement;
      expect(row.classList.contains("sidebar-list-item--stacked-actions")).toBe(false);
    } finally {
      restore();
    }
  });

  it("reveals the stacked actions on a second line on hover and on keyboard focus", () => {
    const sel = (part: string) =>
      `.sidebar-list-item--stacked-actions:hover .sidebar-list-item__${part},\n` +
      `.sidebar-list-item--stacked-actions:focus-within .sidebar-list-item__${part}`;
    const header = rule(sel("header"));
    expect(header).toMatch(/flex-wrap:\s*wrap/);
    const name = rule(sel("name"));
    // The name stays on the first line at its resting height.
    expect(name).toMatch(/flex-basis:\s*0/);
    expect(name).toMatch(/line-height:\s*var\(--control-height-md\)/);
    const actions = rule(sel("actions"));
    expect(actions).toMatch(/position:\s*static/);
    expect(actions).toMatch(/flex:\s*1 0 100%/);
    // Hidden, a stacked row looks exactly like an overlay row: nothing in the
    // resting rules depends on the modifier.
    expect(CSS).not.toMatch(/\.sidebar-list-item--stacked-actions \.sidebar-list-item__/);
  });

  it("has no axe violations when stacked", async () => {
    const restore = fakeLayout({ header: 176, nameLeft: 60, nameContent: 300, button: 22 });
    try {
      renderRow(SIX_ACTIONS);
      expect(await checkA11y(container)).toHaveNoViolations();
    } finally {
      restore();
    }
  });
});
