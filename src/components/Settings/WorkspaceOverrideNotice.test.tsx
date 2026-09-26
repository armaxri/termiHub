import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

import { WorkspaceOverrideNotice } from "./WorkspaceOverrideNotice";
import {
  __resetActiveWorkspaceForTest,
  setActiveWorkspaceLocal,
} from "@/services/workspaceSettings";
import { loadWorkspace, saveWorkspace } from "@/services/workspaceApi";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

vi.mock("@/services/workspaceApi", () => ({
  getActiveWorkspace: vi.fn(),
  setActiveWorkspace: vi.fn(),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<WorkspaceOverrideNotice settingKey="theme" label="Theme" />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveWorkspaceForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkspaceOverrideNotice (PROD-052)", () => {
  it("renders nothing without an active workspace", () => {
    render();
    expect(container.querySelector('[data-testid="workspace-override-theme"]')).toBeNull();
  });

  it("renders nothing when the active workspace does not override the key", () => {
    setActiveWorkspaceLocal({ id: "ws-1", name: "Dev", settings: { fontSize: 18 } });
    render();
    expect(container.querySelector('[data-testid="workspace-override-theme"]')).toBeNull();
  });

  it("shows the overriding workspace and updates live on a switch", () => {
    render();
    act(() => setActiveWorkspaceLocal({ id: "ws-1", name: "Prod", settings: { theme: "light" } }));
    const notice = container.querySelector('[data-testid="workspace-override-theme"]');
    expect(notice?.textContent).toContain("Overridden in workspace");
    expect(notice?.textContent).toContain("Prod");

    act(() => setActiveWorkspaceLocal(null));
    expect(container.querySelector('[data-testid="workspace-override-theme"]')).toBeNull();
  });

  it("reset to global removes the workspace override", async () => {
    setActiveWorkspaceLocal({ id: "ws-1", name: "Prod", settings: { theme: "light" } });
    vi.mocked(loadWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "Prod",
      tabGroups: [],
      settings: { theme: "light" },
    });
    render();

    const reset = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-override-reset-theme"]'
    );
    await act(async () => {
      reset?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-1", settings: {} })
    );
    expect(container.querySelector('[data-testid="workspace-override-theme"]')).toBeNull();
  });
});
