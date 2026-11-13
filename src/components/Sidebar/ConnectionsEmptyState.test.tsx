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
    // Names the toggle exactly as its Settings label reads (#5363).
    expect(link?.textContent).toBe("Settings ▸ General ▸ Allow experimental features");
    act(() => link?.click());
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  it("has no stray punctuation-only text after the settings link (#5621)", () => {
    useExperimentalFeatures.mockReturnValue(false);
    render();
    const walker = document.createTreeWalker(
      query("connections-empty-state")!,
      NodeFilter.SHOW_TEXT
    );
    const orphans: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (text !== "" && /^[.,;:]+$/.test(text)) orphans.push(text);
    }
    expect(orphans).toEqual([]);
    // Nothing follows the link inside its paragraph that could wrap onto its own line.
    const link = query("connections-empty-experimental-link")!;
    expect(link.nextSibling?.textContent?.trim() ?? "").not.toMatch(/^[.,;:]/);
  });

  it("hides the experimental-features signpost when experimental features are on", () => {
    useExperimentalFeatures.mockReturnValue(true);
    render();
    expect(query("connections-empty-experimental-link")).toBeNull();
    expect(container.textContent).not.toContain("Allow experimental features");
    // The base call-to-action still renders.
    expect(query("connections-empty-new-connection")).not.toBeNull();
  });
});
