/**
 * Keyboard operability of the workspace editor's tab-group chips (#4349,
 * audit A11Y2-008).
 *
 * The chips decide which group's layout the LayoutDesigner edits. They used to
 * be a click-only `<div>` with a double-click-only rename, so keyboard users
 * could only ever edit group 0. They are now a roving `tablist` of `tab`
 * buttons (the TabBar pattern), with rename on F2 / Enter-on-active plus a
 * "Rename group" button, and removal on Delete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import type { WorkspaceDefinition } from "@/types/workspace";
import { WorkspaceEditor } from "./WorkspaceEditor";

const leaf = { type: "leaf" as const, tabs: [{ connectionRef: "local" }] };
const WORKSPACE: WorkspaceDefinition = {
  id: "ws-1",
  name: "Ops",
  tabGroups: [
    { name: "Main", layout: leaf },
    { name: "Logs", layout: leaf },
    { name: "Db", layout: leaf },
  ],
};

vi.mock("@/services/workspaceApi", () => ({
  loadWorkspace: vi.fn(() => Promise.resolve(WORKSPACE)),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-ws-edit";

let container: HTMLDivElement;
let root: Root;

setupConnectionsRegion();

async function render() {
  act(() => {
    root.render(
      withTooltip(<WorkspaceEditor tabId={TAB_ID} meta={{ workspaceId: "ws-1" }} isVisible />)
    );
  });
  await flushAsync();
}

function tablist(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="tablist"]');
  if (!el) throw new Error("no tablist");
  return el;
}

function tabs(): HTMLElement[] {
  return Array.from(tablist().querySelectorAll<HTMLElement>('[role="tab"]'));
}

function key(el: HTMLElement, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ ...useAppStore.getInitialState(), closeTab: vi.fn() });
  seedLayoutState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rootPanel: { type: "leaf", id: "panel-ws", tabs: [{ id: TAB_ID }] } as any,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorkspaceEditor — group chips are a keyboard tablist (#4349)", () => {
  it("renders the groups as a named tablist of tab buttons with a single tab stop", async () => {
    await render();
    expect(tablist().getAttribute("aria-label")).toBe("Tab groups");
    const all = tabs();
    expect(all.map((t) => t.textContent)).toEqual(["Main", "Logs", "Db"]);
    for (const t of all) expect(t.tagName).toBe("BUTTON");
    expect(all.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves focus with Arrow/Home/End and activates a group by click (Enter/Space)", async () => {
    await render();
    act(() => tabs()[0].focus());
    key(tabs()[0], "ArrowRight");
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1], "End");
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], "ArrowRight");
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], "Home");
    expect(document.activeElement).toBe(tabs()[0]);

    // A native <button> — Enter/Space dispatch click, which activates the group.
    act(() => tabs()[1].click());
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1].tabIndex).toBe(0);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("false");
  });

  it("renames the focused group on F2 and returns focus to its tab", async () => {
    await render();
    act(() => tabs()[2].focus());
    key(tabs()[2], "F2");
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workspace-group-rename-input-2"]'
    );
    expect(input).not.toBeNull();
    // F2 also makes the renamed group the active one (as double-click does).
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Database");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input!, "Enter");
    await flushAsync();
    const renamed = tabs()[2];
    expect(renamed.textContent).toBe("Database");
    expect(renamed.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(renamed);
  });

  it("Enter on the already-active tab starts a rename", async () => {
    await render();
    act(() => tabs()[0].focus());
    key(tabs()[0], "Enter");
    expect(
      container.querySelector('[data-testid="workspace-group-rename-input-0"]')
    ).not.toBeNull();
  });

  it("offers a Rename group button for the active group", async () => {
    await render();
    act(() => tabs()[1].click());
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-group-rename"]'
    );
    expect(btn?.getAttribute("aria-label")).toBe("Rename group");
    act(() => btn!.click());
    expect(
      container.querySelector('[data-testid="workspace-group-rename-input-1"]')
    ).not.toBeNull();
  });

  it("removes the focused group on Delete", async () => {
    await render();
    act(() => tabs()[1].focus());
    key(tabs()[1], "Delete");
    await flushAsync();
    expect(tabs().map((t) => t.textContent)).toEqual(["Main", "Db"]);
    // Focus stays in the tablist, on the neighbouring tab.
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("has no axe violations in the group strip", async () => {
    await render();
    const strip = container.querySelector('[data-testid="workspace-group-strip"]')!;
    expect(await checkA11y(strip)).toHaveNoViolations();
  });
});
