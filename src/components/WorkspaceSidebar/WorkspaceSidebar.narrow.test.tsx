/**
 * Workspaces sidebar at narrow widths (#4709): the toolbar used to clip
 * "Save Current" and hide import/export. At the minimum sidebar width every
 * action must stay reachable by role/name — the primary "New Workspace" inline,
 * the rest in one overflow "…" menu (#4824) — and workspace names must not lose width to hidden actions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { withTooltip } from "@/test/tooltip";
import { WorkspaceSummary } from "@/types/workspace";
import { checkA11y } from "@/test/axe";
import { installResizeObserverMock, type ResizeObserverMock } from "@/test/resizeObserver";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

// Stub the native file dialogs and fs so import/export can be driven from tests.
const dialogSave = vi.fn();
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogSave(...args),
  open: (...args: unknown[]) => dialogOpen(...args),
}));

const fsWriteTextFile = vi.fn();
const fsReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => fsReadTextFile(...args),
}));

const apiExportWorkspaces = vi.fn();
const apiImportWorkspaces = vi.fn();
vi.mock("@/services/workspaceApi", () => ({
  exportWorkspaces: (...args: unknown[]) => apiExportWorkspaces(...args),
  importWorkspaces: (...args: unknown[]) => apiImportWorkspaces(...args),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Keep the real UI primitives (Modal/Button/Input) so the SaveWorkspaceDialog
// still renders, but spy on the toast helper to assert save feedback.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
    },
  };
});

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;
let ro: ResizeObserverMock;

const ACTION_NAMES = [
  "New Workspace",
  "Save Current Layout",
  "Export Workspaces",
  "Import Workspaces",
];

const workspaces: WorkspaceSummary[] = [
  { id: "ws-1", name: "test", connectionCount: 1 },
  { id: "ws-2", name: "ssh-production-cluster", connectionCount: 2 },
];

function render() {
  useAppStore.setState({ workspaces });
  act(() => {
    root.render(withTooltip(<WorkspaceSidebar />));
  });
}

/** Toolbar buttons rendered inline, keyed by accessible name. */
function inlineNames(): string[] {
  const toolbar = document.querySelector('[role="group"][aria-label="Workspace actions"]');
  return Array.from(toolbar?.querySelectorAll(":scope > button") ?? [])
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((name) => name !== "More workspace actions");
}

function overflowNames(): string[] {
  const trigger = document.querySelector<HTMLElement>('[data-testid="workspace-toolbar-overflow"]');
  if (!trigger) return [];
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent ?? ""
  );
}

describe("WorkspaceSidebar at narrow widths (#4709)", () => {
  beforeEach(() => {
    ro = installResizeObserverMock();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ro.restore();
  });

  it("keeps New Workspace labelled and moves the rest into one '…' menu at the minimum width", async () => {
    render();
    // 200px minimum sidebar width minus the toolbar's horizontal padding.
    ro.resize(184);
    expect(inlineNames()).toEqual(["New Workspace"]);
    expect(document.querySelector('[data-testid="workspace-new-btn"]')?.textContent).toBe(
      "New Workspace"
    );
    expect(await checkA11y(container)).toHaveNoViolations();
    expect(overflowNames()).toEqual([
      "Save Current Layout",
      "Export Workspaces",
      "Import Workspaces",
    ]);
  });

  it("keeps every action reachable through the overflow menu when even narrower", () => {
    render();
    ro.resize(96);
    const inline = inlineNames();
    const overflow = overflowNames();
    expect([...inline, ...overflow].sort()).toEqual([...ACTION_NAMES].sort());
  });

  it("shows the labelled buttons at the default width", () => {
    render();
    ro.resize(400);
    const save = document.querySelector('[data-testid="workspace-save-current-btn"]');
    expect(save?.textContent).toBe("Save Current");
  });

  it("renders each workspace name in full in a truncating name slot", () => {
    render();
    ro.resize(184);
    const name = document.querySelector('[data-testid="workspace-name-ws-2"]');
    expect(name?.textContent).toBe("ssh-production-cluster");
    expect(name?.classList.contains("ui-truncate")).toBe(true);
  });
});
