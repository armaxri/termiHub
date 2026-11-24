/**
 * Tests for the on-disconnect / on-output-match trigger editors (#3791).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedConnection } from "@/types/connection";
import type { WorkflowTrigger } from "@/types/workflow";
import { WorkflowTriggersEditor } from "./WorkflowTriggersEditor";
import { checkA11y } from "@/test/axe";

const connections = [
  { id: "conn-1", name: "prod-web" } as SavedConnection,
  { id: "conn-2", name: "staging" } as SavedConnection,
];

/** A stateful host so edits flow back into the editor, with a change spy. */
function Host({
  initial,
  spy,
}: {
  initial: WorkflowTrigger[];
  spy: (t: WorkflowTrigger[]) => void;
}) {
  const [triggers, setTriggers] = useState(initial);
  return (
    <WorkflowTriggersEditor
      triggers={triggers}
      connections={connections}
      onChange={(next) => {
        spy(next);
        setTriggers(next);
      }}
    />
  );
}

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

function mount(initial: WorkflowTrigger[], spy: (t: WorkflowTrigger[]) => void) {
  act(() => {
    root.render(<Host initial={initial} spy={spy} />);
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
});

const last = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0] as WorkflowTrigger[] | undefined;

describe("WorkflowTriggersEditor — on-disconnect / on-output-match (#3791)", () => {
  it("adds an on-disconnect trigger bound to the chosen connections", () => {
    const spy = vi.fn();
    mount([], spy);

    click("workflow-trigger-on-disconnect");
    expect(query("workflow-trigger-on-disconnect-detail")).not.toBeNull();
    click("workflow-trigger-on-disconnect-connection-conn-1");

    expect(last(spy)).toEqual([{ kind: "on-disconnect", connectionIds: ["conn-1"] }]);
  });

  it("edits an on-output-match pattern, regex flag and limits", () => {
    const spy = vi.fn();
    mount([], spy);

    click("workflow-trigger-on-output-match");
    click("workflow-trigger-on-output-match-connection-conn-2");
    setInput("workflow-trigger-on-output-match-pattern", "ERROR \\d+");
    click("workflow-trigger-on-output-match-regex");
    setInput("workflow-trigger-on-output-match-cooldown", "30");
    setInput("workflow-trigger-on-output-match-max-fires", "3");

    expect(last(spy)).toEqual([
      {
        kind: "on-output-match",
        connectionIds: ["conn-2"],
        pattern: "ERROR \\d+",
        isRegex: true,
        cooldownMs: 30_000,
        maxFiresPerSession: 3,
      },
    ]);
  });

  it("shows why an unsafe regex is rejected", () => {
    mount(
      [{ kind: "on-output-match", connectionIds: ["conn-1"], pattern: "(a+)+", isRegex: true }],
      vi.fn()
    );
    expect(container.textContent).toMatch(/Nested quantifiers/);
  });

  it("removes a trigger when its chip is toggled off", () => {
    const spy = vi.fn();
    mount([{ kind: "on-disconnect", connectionIds: [] }], spy);
    click("workflow-trigger-on-disconnect");
    expect(last(spy)).toEqual([]);
  });
});

describe("WorkflowTriggersEditor — trigger chips use the shared toggle Chip (UI2-006)", () => {
  const CHIPS = [
    "workflow-trigger-manual",
    "workflow-trigger-on-connect",
    "workflow-trigger-hotkey",
    "workflow-trigger-on-disconnect",
    "workflow-trigger-on-output-match",
  ];

  it("renders every trigger as an aria-pressed toggle button", () => {
    mount([{ kind: "manual" }], vi.fn());
    for (const id of CHIPS) {
      const chip = query(id) as HTMLElement;
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.getAttribute("type")).toBe("button");
      expect(chip.classList.contains("ui-chip--toggle")).toBe(true);
    }
    expect(query("workflow-trigger-manual")?.getAttribute("aria-pressed")).toBe("true");
    expect(query("workflow-trigger-hotkey")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles aria-pressed and the trigger list on click", () => {
    const spy = vi.fn();
    mount([], spy);
    click("workflow-trigger-on-connect");
    expect(query("workflow-trigger-on-connect")?.getAttribute("aria-pressed")).toBe("true");
    expect(last(spy)?.some((t) => t.kind === "on-connect")).toBe(true);
    click("workflow-trigger-on-connect");
    expect(query("workflow-trigger-on-connect")?.getAttribute("aria-pressed")).toBe("false");
    expect(last(spy)?.some((t) => t.kind === "on-connect")).toBe(false);
  });

  it("has no a11y violations", async () => {
    mount([{ kind: "manual" }], vi.fn());
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
