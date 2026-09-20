/**
 * Tests for the workflow parameters editor (PROD-0040).
 *
 * The editor is a controlled list of parameter rows. These pin the CRUD surface:
 * adding a parameter, editing its name, toggling required, rendering the enum
 * options field only for an `enum` parameter, and removing a parameter — each
 * emitting the next full parameter list through `onChange`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowParametersEditor } from "./WorkflowParametersEditor";
import type { WorkflowParameter } from "@/types/workflow";

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

/** A stateful harness that mirrors a real parent holding the parameter list. */
function Harness({
  initial,
  onChangeSpy,
}: {
  initial: WorkflowParameter[];
  onChangeSpy: (params: WorkflowParameter[]) => void;
}) {
  const [params, setParams] = useState<WorkflowParameter[]>(initial);
  return (
    <WorkflowParametersEditor
      parameters={params}
      onChange={(next) => {
        onChangeSpy(next);
        setParams(next);
      }}
    />
  );
}

function render(initial: WorkflowParameter[], onChangeSpy: (p: WorkflowParameter[]) => void) {
  act(() => {
    root.render(<Harness initial={initial} onChangeSpy={onChangeSpy} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("WorkflowParametersEditor", () => {
  it("shows the empty hint when there are no parameters", () => {
    render([], vi.fn());
    expect(query("workflow-params-empty")).not.toBeNull();
    expect(query("workflow-params-list")).toBeNull();
  });

  it("adds a new string parameter", () => {
    const onChange = vi.fn();
    render([], onChange);
    click("workflow-params-add");
    expect(onChange).toHaveBeenCalledWith([{ name: "", type: "string" }]);
    expect(query("workflow-param-0")).not.toBeNull();
  });

  it("edits a parameter name", () => {
    const onChange = vi.fn();
    render([{ name: "", type: "string" }], onChange);
    setInput("workflow-param-name-0", "host");
    expect(onChange).toHaveBeenLastCalledWith([{ name: "host", type: "string" }]);
  });

  it("toggles required on", () => {
    const onChange = vi.fn();
    render([{ name: "host", type: "string" }], onChange);
    click("workflow-param-required-0");
    expect(onChange).toHaveBeenLastCalledWith([{ name: "host", type: "string", required: true }]);
  });

  it("renders the enum options field only for an enum parameter", () => {
    render([{ name: "env", type: "enum", options: ["dev", "prod"] }], vi.fn());
    const options = query("workflow-param-options-0") as HTMLInputElement;
    expect(options).not.toBeNull();
    expect(options.value).toBe("dev, prod");
  });

  it("does not render the enum options field for a string parameter", () => {
    render([{ name: "host", type: "string" }], vi.fn());
    expect(query("workflow-param-options-0")).toBeNull();
  });

  it("removes a parameter", () => {
    const onChange = vi.fn();
    render([{ name: "host", type: "string" }], onChange);
    click("workflow-param-remove-0");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(query("workflow-param-0")).toBeNull();
  });
});
