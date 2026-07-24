/**
 * Tests for the local-process authorization dialog (#1857).
 *
 * The dialog is the interactive half of the run-local-process security gate: it
 * spells out the exact program + discrete arguments a workflow wants to run, and
 * resolves the store's pending authorization promise with the user's choice
 * (cancel / allow once / always allow). These tests pin that the three actions
 * resolve with the right decision and that the shown command is accurate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LocalProcessAuthDialog } from "./LocalProcessAuthDialog";
import { useAppStore } from "@/store/appStore";
import type { LocalProcessAuthDecision } from "@/store/appStore";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function render() {
  act(() => {
    root.render(<LocalProcessAuthDialog />);
  });
}

/** Open the prompt via the store and return the resolver spy. */
function openPrompt(program: string, args: string[]) {
  const resolve = vi.fn();
  act(() => {
    useAppStore.setState({
      localProcessPrompt: { program, args, workflowName: "Deploy", resolve },
    });
  });
  return resolve;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("LocalProcessAuthDialog", () => {
  it("is not rendered when there is no pending prompt", () => {
    render();
    expect(query("local-process-auth-dialog")).toBeNull();
  });

  it("shows the exact program and discrete arguments", () => {
    render();
    openPrompt("/usr/bin/notify-send", ["--urgency", "hello world"]);

    expect(query("local-process-auth-program")?.textContent).toBe("/usr/bin/notify-send");
    const args = query("local-process-auth-args");
    // Each argument is its own list item — "hello world" stays one entry.
    expect(args?.querySelectorAll("li")).toHaveLength(2);
    expect(args?.textContent).toContain("hello world");
  });

  it.each<[string, LocalProcessAuthDecision]>([
    ["local-process-auth-cancel", "cancel"],
    ["local-process-auth-once", "once"],
    ["local-process-auth-always", "always"],
  ])("resolves via %s with decision %s", (testId, decision) => {
    render();
    const spy = openPrompt("echo", ["hi"]);

    act(() => {
      (query(testId) as HTMLButtonElement).click();
    });

    expect(spy).toHaveBeenCalledWith(decision);
    // The prompt is cleared after resolving.
    expect(useAppStore.getState().localProcessPrompt).toBeNull();
  });
});
