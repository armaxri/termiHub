/**
 * Tests for the workflow parameter run-time prompt (PROD-0040).
 *
 * The prompt is the interactive half of parameterized workflows: it pre-fills a
 * field per declared parameter from its `default`, collects the user's values,
 * and resolves the store's pending run promise with them (or `null` on cancel).
 * These pin the pre-fill, value collection with per-type coercion, the required
 * gate, and cancellation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowParamPromptDialog } from "./WorkflowParamPromptDialog";
import { useAppStore } from "@/store/appStore";
import type { WorkflowParameter } from "@/types/workflow";
import type { WorkflowParamValues } from "@/services/workflowRunner";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string) {
  act(() => {
    (query(testId) as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInput(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function render() {
  act(() => {
    root.render(<WorkflowParamPromptDialog />);
  });
}

/** Open the prompt via the store and return the resolver spy. */
function openPrompt(parameters: WorkflowParameter[]) {
  const resolve = vi.fn<(values: WorkflowParamValues | null) => void>();
  act(() => {
    useAppStore.setState({
      workflowParamPrompt: { workflowName: "Deploy", parameters, resolve },
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

describe("WorkflowParamPromptDialog", () => {
  it("is not rendered without a pending prompt", () => {
    render();
    expect(query("workflow-param-prompt")).toBeNull();
  });

  it("pre-fills string fields from their default and collects edits", () => {
    const resolve = openPrompt([{ name: "host", type: "string", default: "localhost" }]);
    render();
    const field = query("workflow-param-value-host") as HTMLInputElement;
    expect(field.value).toBe("localhost");
    setInput("workflow-param-value-host", "example.com");
    click("workflow-param-prompt-run");
    expect(resolve).toHaveBeenCalledWith({ host: "example.com" });
  });

  it("coerces a number parameter to a number value", () => {
    const resolve = openPrompt([{ name: "port", type: "number", default: 22 }]);
    render();
    setInput("workflow-param-value-port", "2222");
    click("workflow-param-prompt-run");
    expect(resolve).toHaveBeenCalledWith({ port: 2222 });
  });

  it("resolves null when cancelled", () => {
    const resolve = openPrompt([{ name: "host", type: "string" }]);
    render();
    click("workflow-param-prompt-cancel");
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it("disables Run until a required field has a value", () => {
    const resolve = openPrompt([{ name: "host", type: "string", required: true }]);
    render();
    const run = query("workflow-param-prompt-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    setInput("workflow-param-value-host", "example.com");
    expect((query("workflow-param-prompt-run") as HTMLButtonElement).disabled).toBe(false);
    click("workflow-param-prompt-run");
    expect(resolve).toHaveBeenCalledWith({ host: "example.com" });
  });
});
