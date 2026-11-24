import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  ConnectionsEmptyState,
  EXPERIMENTAL_HINT_ACTION,
  EXPERIMENTAL_HINT_TEXT,
} from "./ConnectionsEmptyState";

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
    const hint = query("connections-empty-experimental-hint")!;
    // SSH tunnels, services and network tools graduated (#5858): only the
    // features still behind the switch are named.
    expect(hint.textContent).toContain("Workflows");
    expect(hint.textContent).not.toMatch(/tunnels|services|network tools/i);
    const action = query("connections-empty-experimental-action")!;
    act(() => action.click());
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  // R-098 (#5873): a short sentence plus ONE button, not a long inline link
  // whose path wraps into several underlined fragments in a narrow sidebar.
  it("is one short sentence and one button, with no inline link", () => {
    useExperimentalFeatures.mockReturnValue(false);
    render();
    const hint = query("connections-empty-experimental-hint")!;
    const sentence = hint.querySelector("p")!;
    expect(sentence.textContent).toBe(EXPERIMENTAL_HINT_TEXT);
    expect(sentence.querySelector("button, a")).toBeNull();
    const buttons = hint.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(EXPERIMENTAL_HINT_ACTION);
    expect(buttons[0].className).toContain("ui-btn");
    expect(buttons[0].className).toContain("connections-empty__hint-action");
    // The full path lives in the tooltip, not in the wrapping text.
    expect(hint.textContent).not.toContain("▸");
    expect(buttons[0].getAttribute("title")).toBe(
      "Opens Settings ▸ General ▸ Allow experimental features"
    );
  });

  it("keeps the action label short enough to fit the minimum sidebar width", () => {
    expect(EXPERIMENTAL_HINT_ACTION.length).toBeLessThanOrEqual(24);
    expect(EXPERIMENTAL_HINT_TEXT.length).toBeLessThanOrEqual(40);
  });

  it("has no stray punctuation-only text node (#5621)", () => {
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
  });

  it("hides the experimental-features signpost when experimental features are on", () => {
    useExperimentalFeatures.mockReturnValue(true);
    render();
    expect(query("connections-empty-experimental-hint")).toBeNull();
    expect(container.textContent).not.toContain(EXPERIMENTAL_HINT_ACTION);
    // The base call-to-action still renders.
    expect(query("connections-empty-new-connection")).not.toBeNull();
  });
});
