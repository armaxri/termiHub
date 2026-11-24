import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  WorkflowsExperimentalNotice,
  WORKFLOWS_EXPERIMENTAL_ACTION,
  WORKFLOWS_EXPERIMENTAL_TEXT,
} from "./WorkflowsExperimentalNotice";

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

function render() {
  act(() => {
    root.render(<WorkflowsExperimentalNotice />);
  });
}

describe("WorkflowsExperimentalNotice (#5954)", () => {
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

  it("shows one sentence and one action while experimental features are off", () => {
    render();
    const notice = query("workflow-experimental-notice")!;
    expect(notice).not.toBeNull();
    expect(query("workflow-experimental-text")!.textContent).toBe(WORKFLOWS_EXPERIMENTAL_TEXT);
    const buttons = notice.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(WORKFLOWS_EXPERIMENTAL_ACTION);
  });

  // The action must read as a control, not as plain text (#5954).
  it("styles the action as a real secondary button with the switch's path as tooltip", () => {
    render();
    const action = query("workflow-experimental-action")!;
    expect(action.tagName).toBe("BUTTON");
    expect(action.className).toContain("ui-btn");
    expect(action.className).toMatch(/secondary/);
    expect(action.getAttribute("title")).toBe(
      "Opens Settings ▸ General ▸ Allow experimental features"
    );
    // The sentence itself holds no link or button.
    expect(query("workflow-experimental-text")!.querySelector("a, button")).toBeNull();
  });

  it("opens Settings on the General category, where the switch is", () => {
    render();
    act(() => query("workflow-experimental-action")!.click());
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  it("renders nothing once experimental features are on", () => {
    useExperimentalFeatures.mockReturnValue(true);
    render();
    expect(query("workflow-experimental-notice")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("keeps its copy short enough for the narrowest sidebar", () => {
    expect(WORKFLOWS_EXPERIMENTAL_ACTION.length).toBeLessThanOrEqual(24);
    expect(WORKFLOWS_EXPERIMENTAL_TEXT.length).toBeLessThanOrEqual(56);
  });
});
