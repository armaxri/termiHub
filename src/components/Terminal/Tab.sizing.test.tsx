/**
 * Tab sizing and title tooltip (#5557).
 *
 * The product-run UI review found tab titles cut to "Startup question (zs…" at
 * ~150px while the rest of the strip was empty. Tabs now size to their title
 * up to `--tab-max-width` and shrink toward `--tab-min-width` only when the
 * strip is full. jsdom does not lay out, so the width contract is pinned on the
 * stylesheet; the tooltip and the dirty-dot explanation are checked on the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";

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

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tabBarCss = readFileSync(join(SRC_DIR, "components/Terminal/TabBar.css"), "utf8");
const variablesCss = readFileSync(join(SRC_DIR, "styles/variables.css"), "utf8");

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule ${selector} exists`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function px(token: string): number {
  const match = variablesCss.match(new RegExp(`${token}:\\s*(\\d+)px;`));
  expect(match, `${token} is defined in px`).not.toBeNull();
  return Number(match![1]);
}

const TITLE = "Startup question (zsh)";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: TITLE,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

function renderTab(props: { tab?: TerminalTab; isDirty?: boolean } = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <div role="tablist" aria-label="Open sessions">
          <Tab
            tab={props.tab ?? makeTab()}
            onActivate={() => {}}
            onClose={() => {}}
            isDirty={props.isDirty}
            status="connected"
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

describe("flexible tab width (#5557)", () => {
  it("lets a tab grow to 240px and shrink only to 120px", () => {
    expect(px("--tab-min-width")).toBe(120);
    expect(px("--tab-max-width")).toBe(240);
    const tab = ruleBody(tabBarCss, ".tab");
    expect(tab).toMatch(/min-width:\s*var\(--tab-min-width\);/);
    expect(tab).toMatch(/max-width:\s*var\(--tab-max-width\);/);
    // Sized to content (basis auto), shrinkable when the strip is full, never
    // stretched to fill it.
    expect(tab).toMatch(/flex:\s*0 1 auto;/);
  });

  it("lets the strip compress its tabs before the bar scrolls", () => {
    const strip = ruleBody(tabBarCss, ".tab-bar__tabs");
    expect(strip).toMatch(/flex:\s*0 1 auto;/);
    expect(strip).toMatch(/min-width:\s*0;/);
  });

  it("ellipsizes the title only inside the tab, never forcing it wider", () => {
    const title = ruleBody(tabBarCss, ".tab__title");
    expect(title).toMatch(/min-width:\s*0;/);
    expect(title).toMatch(/text-overflow:\s*ellipsis;/);
  });
});

describe("tab tooltip (#5557)", () => {
  it("carries the full title, in full, in the tab's tooltip and text", () => {
    renderTab();
    expect(tabEl().getAttribute("title")).toBe(TITLE);
    expect(container.querySelector(".tab__title")!.textContent).toBe(TITLE);
  });

  it("explains the dirty dot in the tab tooltip and its accessible label", () => {
    renderTab({
      tab: makeTab({ title: "Edit: Chooser test (SSH)", contentType: "connection-editor" }),
      isDirty: true,
    });
    expect(tabEl().getAttribute("title")).toBe("Edit: Chooser test (SSH) (unsaved changes)");
    const dot = container.querySelector('[data-testid="tab-dirty-dot-t1"]')!;
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("Unsaved changes");
  });
});
