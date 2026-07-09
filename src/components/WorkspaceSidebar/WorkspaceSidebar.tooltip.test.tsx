/**
 * Verifies the workspace sidebar and its list-item rows adopt the shared
 * `Tooltip` primitive for their icon buttons (issue #1160, follow-up to #1114).
 *
 * A tooltip is not an accessible name, so each converted icon button must keep
 * an `aria-label`, must no longer carry a bare `title`, and the Radix tooltip
 * trigger must wire `aria-describedby` when focused. These assertions pin all
 * three. The stable `data-testid`s must survive the migration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkspaceListItem } from "./WorkspaceListItem";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { withTooltip } from "@/test/tooltip";
import type { WorkspaceSummary } from "@/types/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "@/store/appStore";

const WORKSPACE: WorkspaceSummary = {
  id: "ws-1",
  name: "Dev Setup",
  description: "Daily dev layout",
  connectionCount: 3,
};

const noop = () => {};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderItem(): void {
  act(() => {
    root.render(
      withTooltip(
        <WorkspaceListItem
          workspace={WORKSPACE}
          onLaunch={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

describe("WorkspaceListItem — tooltip adoption (#1160)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes accessible names via aria-label without a bare title on the action icons", async () => {
    renderItem();
    await flush();

    const ids = [
      "workspace-launch-ws-1",
      "workspace-edit-ws-1",
      "workspace-duplicate-ws-1",
      "workspace-delete-ws-1",
    ];
    for (const id of ids) {
      const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-label")).toBeTruthy();
      // The tooltip must not leak into the accessible name as a bare title.
      expect(btn?.getAttribute("title")).toBeNull();
    }
  });

  it("leaves the workspace name as a bare title-free text node (not a control)", async () => {
    renderItem();
    await flush();

    const name = container.querySelector<HTMLElement>('[data-testid="workspace-name-ws-1"]');
    expect(name).not.toBeNull();
    // The name is a truncation-hover target, not an interactive control, so it
    // must not gain an aria-label.
    expect(name?.getAttribute("aria-label")).toBeNull();
  });

  it("wires the Edit button to its tooltip via aria-describedby on focus", async () => {
    renderItem();
    await flush();

    const edit = container.querySelector<HTMLButtonElement>('[data-testid="workspace-edit-ws-1"]')!;
    act(() => {
      edit.focus();
      edit.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });

    expect(edit.getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("WorkspaceSidebar action buttons — tooltip adoption (#1160)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ workspaces: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes accessible names via aria-label without a bare title on the toolbar icons", async () => {
    act(() => {
      root.render(withTooltip(<WorkspaceSidebar />));
    });
    await flush();

    const ids = [
      "workspace-new-btn",
      "workspace-save-current-btn",
      "workspace-export-btn",
      "workspace-import-btn",
    ];
    for (const id of ids) {
      const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-label")).toBeTruthy();
      expect(btn?.getAttribute("title")).toBeNull();
    }
  });
});
