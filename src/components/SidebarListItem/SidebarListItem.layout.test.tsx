/**
 * SidebarListItem narrow-width layout (#4709): hover/focus actions must not
 * reserve width while hidden, so the row name gets the whole row and only
 * truncates (with a tooltip) when it really does not fit.
 *
 * jsdom does not apply stylesheets, so the layout contract is pinned on the
 * DOM structure plus the rules in `SidebarListItem.css`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SidebarListItem } from "./SidebarListItem";
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
    expect(name).toMatch(/flex:\s*1 1 auto/);
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
