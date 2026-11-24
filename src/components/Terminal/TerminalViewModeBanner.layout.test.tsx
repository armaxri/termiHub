/**
 * #5823 (R-003): the "Agent disconnected" banner was cut off at 800x600 and a
 * toast covered its Reconnect button. These pin the fix: the banner sits at
 * the top of the pane, its copy is short and wraps instead of clipping, it is
 * a toast keep-clear zone, and Reconnect stays clickable with a toast on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalViewModeBanner, VIEW_MODE_ENTER_HINT } from "./TerminalViewModeBanner";
import { TOP_NOTICE_INSET_VAR } from "./topNoticeInset";
import { computeToastLayout, type Box } from "@/components/ui/Toast/toastAvoid";

const reconnectTerminal = vi.fn();
const agentDisconnected: Record<string, boolean> = vi.hoisted(() => ({}));

vi.mock("@/store/appStore", () => {
  const state = {
    reconnectTerminal: (...args: unknown[]) => reconnectTerminal(...args),
    terminalAgentDisconnected: agentDisconnected,
  };
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state);
  return { useAppStore };
});

const here = dirname(fileURLToPath(import.meta.url));

function cssRule(file: string, selector: string): string {
  const css = readFileSync(join(here, file), "utf8");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(rule, `${file}: no rule for ${selector}`).not.toBeNull();
  return rule![1];
}

/** Declarations only, so comments that mention a property do not count. */
function declarations(rule: string): string {
  return rule.replace(/\/\*[\s\S]*?\*\//g, "");
}

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;

function render(tabId: string) {
  act(() => {
    root.render(<TerminalViewModeBanner tabId={tabId} />);
  });
}

function q(testId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el, testId).not.toBeNull();
  return el!;
}

function stubRect(el: Element, box: Box) {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => box,
    }) as DOMRect;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("TerminalViewModeBanner layout (#5823)", () => {
  beforeEach(() => {
    // The SplitView shape: wrapper > [search bar, terminal slot > banner].
    host = document.createElement("div");
    host.className = "terminal-context-trigger";
    container = document.createElement("div");
    container.className = "terminal-container";
    host.appendChild(container);
    document.body.appendChild(host);
    root = createRoot(container);
    vi.clearAllMocks();
    for (const key of Object.keys(agentDisconnected)) delete agentDisconnected[key];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll("[data-sonner-toast]").forEach((el) => el.remove());
  });

  it("sits at the top of the pane, full width, like the reconnect strip", () => {
    const rule = declarations(cssRule("TerminalViewModeBanner.css", ".terminal-view-mode-banner"));
    expect(rule).toMatch(/top:\s*0;/);
    expect(rule).toMatch(/left:\s*0;/);
    expect(rule).toMatch(/right:\s*0;/);
    expect(rule).not.toMatch(/(^|[\s;])bottom:/);
    const strip = declarations(cssRule("TerminalReconnectStrip.css", ".terminal-reconnect-strip"));
    expect(strip).toMatch(/top:\s*0;/);
  });

  it("wraps its text at narrow widths instead of clipping it", () => {
    const label = declarations(
      cssRule("TerminalViewModeBanner.css", ".terminal-view-mode-banner__label")
    );
    expect(label).not.toMatch(/white-space:\s*nowrap/);
    expect(label).not.toMatch(/text-overflow/);
    expect(label).not.toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/min-width:\s*0/);
    // Reconnect keeps its full size beside the wrapping text.
    const btn = declarations(
      cssRule("TerminalViewModeBanner.css", ".terminal-view-mode-banner .ui-btn")
    );
    expect(btn).toMatch(/flex-shrink:\s*0/);
  });

  it("keeps the copy short enough for an 800x600 pane", () => {
    agentDisconnected["tab-a"] = true;
    render("tab-a");
    const label = q("terminal-view-mode-banner").querySelector(".terminal-view-mode-banner__label");
    // The R-003 sentence was 92 characters; heading + hint now fit one line.
    expect(label?.textContent).toBe(`Agent disconnected. ${VIEW_MODE_ENTER_HINT}`);
    expect(label!.textContent!.length).toBeLessThanOrEqual(48);
    // The full instruction stays in the tooltip; the announcement is the
    // visible text itself (#5980).
    expect(q("terminal-view-mode-reconnect-btn").getAttribute("title")).toContain("Enter");
    expect(document.querySelector("[role='status']")?.textContent).toBe(label?.textContent);
  });

  it("is a toast keep-clear zone", () => {
    render("tab-b");
    expect(q("terminal-view-mode-banner").hasAttribute("data-toast-avoid")).toBe(true);
  });

  it("keeps the toast stack off Reconnect and Reconnect clickable with a toast present", () => {
    render("tab-c");
    // A bottom split pane whose top edge (the banner) sits in the toast
    // stack's bottom-right corner of an 800x600 window.
    const banner: Box = { left: 0, top: 540, right: 800, bottom: 566 };
    const button: Box = { left: 700, top: 542, right: 790, bottom: 564 };
    stubRect(q("terminal-view-mode-banner"), banner);
    stubRect(q("terminal-view-mode-reconnect-btn"), button);
    const toastEl = document.createElement("li");
    toastEl.setAttribute("data-sonner-toast", "");
    toastEl.textContent = "Saved “web”";
    document.body.appendChild(toastEl);

    const boxes = Array.from(document.querySelectorAll("[data-toast-avoid]"), (el) =>
      el.getBoundingClientRect()
    );
    const zone = {
      viewportWidth: 800,
      viewportHeight: 600,
      width: 340,
      height: 64,
      edge: 16,
      baseInset: 0,
    };
    const layout = computeToastLayout(boxes, zone);
    expect(layout.docked).toBe(false);
    const stackBottom = zone.viewportHeight - layout.inset - zone.edge;
    const stack: Box = {
      left: zone.viewportWidth - zone.edge - layout.width,
      right: zone.viewportWidth - zone.edge,
      top: stackBottom - zone.height,
      bottom: stackBottom,
    };
    expect(overlaps(stack, button)).toBe(false);
    expect(overlaps(stack, banner)).toBe(false);

    act(() => q("terminal-view-mode-reconnect-btn").click());
    expect(reconnectTerminal).toHaveBeenCalledWith("tab-c");
  });

  it("tells the search bar to open below it, and clears that on unmount", () => {
    render("tab-d");
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toMatch(/^\d+px$/);
    const search = declarations(cssRule("TerminalSearchBar.css", ".terminal-search-bar"));
    expect(search).toContain(`var(${TOP_NOTICE_INSET_VAR})`);
    act(() => root.render(<></>));
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("");
  });
});
