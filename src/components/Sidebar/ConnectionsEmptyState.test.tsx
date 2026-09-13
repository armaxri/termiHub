import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionsEmptyState } from "./ConnectionsEmptyState";

const openSettingsTab = vi.fn();
const useExperimentalFeatures = vi.fn<() => boolean>();

vi.mock("@/store/appStore", () => {
  const state = { openSettingsTab: (...args: unknown[]) => openSettingsTab(...args) };
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state);
  return { useAppStore };
});

vi.mock("@/hooks/useExperimentalFeatures", () => ({
  useExperimentalFeatures: () => useExperimentalFeatures(),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(onNewConnection = vi.fn()) {
  act(() => {
    root.render(<ConnectionsEmptyState onNewConnection={onNewConnection} />);
  });
  return onNewConnection;
}

describe("ConnectionsEmptyState", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useExperimentalFeatures.mockReturnValue(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the zero-state title and a New Connection call-to-action", () => {
    render();
    expect(query("connections-empty-state")).not.toBeNull();
    expect(container.textContent).toContain("No connections yet");
    expect(query("connections-empty-new-connection")).not.toBeNull();
  });

  it("invokes onNewConnection when the New Connection button is clicked", () => {
    const onNewConnection = render();
    act(() => query("connections-empty-new-connection")?.click());
    expect(onNewConnection).toHaveBeenCalledTimes(1);
  });

  it("shows the experimental-features signpost when experimental features are off", () => {
    useExperimentalFeatures.mockReturnValue(false);
    render();
    const link = query("connections-empty-experimental-link");
    expect(link).not.toBeNull();
    act(() => link?.click());
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  it("hides the experimental-features signpost when experimental features are on", () => {
    useExperimentalFeatures.mockReturnValue(true);
    render();
    expect(query("connections-empty-experimental-link")).toBeNull();
    // The base call-to-action still renders.
    expect(query("connections-empty-new-connection")).not.toBeNull();
  });
});
