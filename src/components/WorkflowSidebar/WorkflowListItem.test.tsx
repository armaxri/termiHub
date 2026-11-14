import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowListItem } from "./WorkflowListItem";
import { withTooltip } from "@/test/tooltip";
import type { Workflow, WorkflowStep, WorkflowTrigger } from "@/types/workflow";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    name: "Bootstrap",
    description: "",
    tags: [],
    steps: [{ kind: "send-command", command: "whoami" }],
    triggers: [{ kind: "manual" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function handlers() {
  return {
    onRun: vi.fn(),
    onRunOn: vi.fn(),
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** The row's tooltip text, as its accessible description (#5757). */
function rowTooltip(): string | null {
  return query("workflow-item-w1")?.getAttribute("aria-description") ?? null;
}

/** The text the row itself shows (no tooltip content is in the DOM at rest). */
function rowText(): string {
  return query("workflow-item-w1")?.textContent ?? "";
}

const CONNECTION_NAMES: Record<string, string> = { c1: "Prod shell", c2: "Staging" };
const connectionName = (id: string): string | undefined => CONNECTION_NAMES[id];

function render(w: Workflow, running = false, h = handlers()) {
  act(() => {
    root.render(
      withTooltip(
        <WorkflowListItem workflow={w} running={running} connectionName={connectionName} {...h} />
      )
    );
  });
  return h;
}

describe("WorkflowListItem", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the name first with no step-count badge and no step-kind preview", () => {
    const steps: WorkflowStep[] = [
      { kind: "send-command", command: "a" },
      { kind: "wait", delayMs: 10 },
    ];
    render(workflow({ steps }));
    expect(query("workflow-name-w1")?.textContent).toBe("Bootstrap");
    // The name is the row's first text; no step count in front of it (#5519).
    const header = query("workflow-item-w1")?.querySelector(".sidebar-list-item__header");
    expect(header?.textContent?.startsWith("Bootstrap")).toBe(true);
    expect(query("workflow-item-w1")?.querySelector(".sidebar-list-item__badge")).toBeNull();
    // The generic step-kind chain does not tell workflows apart, so the row
    // leaves it to the editor and shows no raw kind ids (#5529).
    expect(query("workflow-preview-w1")).toBeNull();
    expect(query("workflow-item-w1")?.textContent).not.toContain("send-command");
  });

  it("shows the Run action (not Stop) when not running", () => {
    render(workflow(), false);
    expect(query("workflow-run-w1")).not.toBeNull();
    expect(query("workflow-stop-w1")).toBeNull();
  });

  it("shows the Stop action (not Run) when running", () => {
    render(workflow(), true);
    expect(query("workflow-stop-w1")).not.toBeNull();
    expect(query("workflow-run-w1")).toBeNull();
  });

  it("shows only the name for a manual workflow; 'Manual' is in the tooltip (#5757)", () => {
    render(workflow());
    expect(rowText()).toBe("Bootstrap");
    expect(query("workflow-summary-w1")).toBeNull();
    expect(rowTooltip()).toBe("Manual");
    // Never a step count (#5519/#5635).
    expect(rowTooltip()).not.toMatch(/step/i);
    expect(query("workflow-armed-w1")).toBeNull();
  });

  it("puts the trigger and the connection it watches in the tooltip, not the row", () => {
    const triggers: WorkflowTrigger[] = [
      { kind: "on-output-match", connectionIds: ["c1"], pattern: "FIRE" },
    ];
    render(workflow({ triggers }));
    expect(rowTooltip()).toBe("On output match · Prod shell");
    expect(rowText()).not.toContain("On output match");
    expect(rowText()).not.toContain("Prod shell");
  });

  it("reveals the tooltip with the full name and the trigger on the name", () => {
    const triggers: WorkflowTrigger[] = [{ kind: "on-connect", connectionIds: ["c1"] }];
    render(workflow({ triggers, tags: ["deploy", "prod"] }));
    act(() => {
      query("workflow-name-w1")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const tip = document.querySelector('[data-testid="workflow-tooltip-w1"]');
    expect(tip?.textContent).toContain("Bootstrap");
    expect(tip?.textContent).toContain("On connect · Prod shell");
    expect(tip?.textContent).toContain("Tags: deploy, prod");
  });

  it("shows the user's description muted under the name, and nothing when unset", () => {
    render(workflow({ description: "Sets up a fresh box" }));
    const description = query("workflow-description-w1");
    expect(description?.textContent).toBe("Sets up a fresh box");
    expect(description?.classList.contains("sidebar-list-item__description")).toBe(true);
    expect(rowText()).toBe("BootstrapSets up a fresh box");
    render(workflow({ description: "" }));
    expect(query("workflow-description-w1")).toBeNull();
  });

  it("keeps tags off the row and lists them in the tooltip (#5757)", () => {
    render(workflow({ tags: ["deploy"] }));
    expect(query("workflow-tags-w1")).toBeNull();
    expect(rowText()).not.toContain("deploy");
    expect(rowTooltip()).toBe("Manual. Tags: deploy");
  });

  it("marks an armed workflow and names what it watches", () => {
    const bound: WorkflowTrigger[] = [{ kind: "on-connect", connectionIds: ["c1", "c2"] }];
    render(workflow({ triggers: bound }));
    const armed = query("workflow-armed-w1");
    expect(armed).not.toBeNull();
    expect(armed?.textContent).toContain("Armed");
    expect(armed?.getAttribute("aria-label")).toBe(
      "Runs automatically: on connect of Prod shell, Staging"
    );
    expect(rowTooltip()).toBe("On connect · Prod shell, Staging");
    // Only the marker reaches the row: no trigger or connection text.
    expect(rowText()).toBe("BootstrapArmed");
  });

  describe("arm toggle (#5674)", () => {
    const bound: WorkflowTrigger[] = [
      { kind: "on-output-match", connectionIds: ["c1"], pattern: "ERR" },
    ];

    function renderWithToggle(w: Workflow) {
      const h = { ...handlers(), onSetTriggersEnabled: vi.fn() };
      render(w, false, h);
      return h;
    }

    it("shows an on switch next to the Armed marker of an armed workflow", () => {
      renderWithToggle(workflow({ triggers: bound }));
      const toggle = query("workflow-arm-toggle-w1");
      expect(toggle?.getAttribute("role")).toBe("switch");
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(toggle?.getAttribute("aria-label")).toBe("Disarm workflow Bootstrap");
      expect(query("workflow-armed-w1")?.getAttribute("data-armed")).toBe("true");
    });

    it("disarms in one click without opening the editor or running", () => {
      const h = renderWithToggle(workflow({ triggers: bound }));
      act(() => query("workflow-arm-toggle-w1")?.click());
      expect(h.onSetTriggersEnabled).toHaveBeenCalledExactlyOnceWith("w1", false);
      expect(h.onEdit).not.toHaveBeenCalled();
      expect(h.onRun).not.toHaveBeenCalled();
    });

    it("shows a disarmed workflow as Off, keeps its bindings, and re-arms", () => {
      const h = renderWithToggle(workflow({ triggers: bound, triggersEnabled: false }));
      const marker = query("workflow-armed-w1");
      expect(marker?.textContent).toBe("Off");
      expect(marker?.getAttribute("data-armed")).toBe("false");
      expect(marker?.className).toContain("workflow-item__armed--off");
      expect(marker?.getAttribute("aria-label")).toBe(
        "Disarmed, will not run automatically: on output match of Prod shell"
      );
      // The bindings are untouched: the tooltip still names the connection.
      expect(rowTooltip()).toBe("On output match · Prod shell");
      const toggle = query("workflow-arm-toggle-w1");
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      expect(toggle?.getAttribute("aria-label")).toBe("Arm workflow Bootstrap");
      act(() => toggle?.click());
      expect(h.onSetTriggersEnabled).toHaveBeenCalledExactlyOnceWith("w1", true);
    });

    it("keeps a double-click on the switch from running the workflow", () => {
      const h = renderWithToggle(workflow({ triggers: bound }));
      act(() => {
        query("workflow-arm-toggle-w1")?.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true })
        );
      });
      expect(h.onRun).not.toHaveBeenCalled();
    });

    it("keeps Enter on the switch away from the row's keyboard handler", () => {
      const onKeyDown = vi.fn();
      const h = { ...handlers(), onSetTriggersEnabled: vi.fn() };
      act(() => {
        root.render(
          withTooltip(
            <WorkflowListItem
              workflow={workflow({ triggers: bound })}
              running={false}
              connectionName={connectionName}
              rowProps={{ onKeyDown }}
              {...h}
            />
          )
        );
      });
      act(() => {
        query("workflow-arm-toggle-w1")?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
      });
      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it("has no switch on a manual workflow or without a handler", () => {
      renderWithToggle(workflow());
      expect(query("workflow-arm-toggle-w1")).toBeNull();
      render(workflow({ triggers: bound }));
      expect(query("workflow-arm-toggle-w1")).toBeNull();
    });
  });

  it("does not mark a workflow armed when its trigger binds no connections", () => {
    const empty: WorkflowTrigger[] = [{ kind: "on-connect", connectionIds: [] }];
    render(workflow({ triggers: empty }));
    expect(query("workflow-armed-w1")).toBeNull();
    expect(rowTooltip()).toBe("Manual");
  });

  it("puts a hotkey trigger's binding in the tooltip, not as armed", () => {
    render(workflow({ triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+H" }] }));
    expect(rowTooltip()).toBe("Hotkey Ctrl+Alt+H");
    expect(rowText()).toBe("Bootstrap");
    expect(query("workflow-armed-w1")).toBeNull();
  });

  it("keeps the name first, before the armed marker", () => {
    render(workflow({ triggers: [{ kind: "on-disconnect", connectionIds: ["c1"] }] }));
    const text = rowText();
    expect(text.indexOf("Bootstrap")).toBeLessThan(text.indexOf("Armed"));
    expect(text).not.toContain("On disconnect");
  });

  it("runs on click and stops the click from bubbling to the row", () => {
    const h = render(workflow(), false);
    act(() => query("workflow-run-w1")?.click());
    expect(h.onRun).toHaveBeenCalledWith("w1");
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("cancels via the Stop action while running", () => {
    const h = render(workflow(), true);
    act(() => query("workflow-stop-w1")?.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onRun).not.toHaveBeenCalled();
  });

  it("wires edit / duplicate / export / delete to their handlers", () => {
    const h = render(workflow());
    act(() => query("workflow-edit-w1")?.click());
    expect(h.onEdit).toHaveBeenCalledWith("w1");
    act(() => query("workflow-duplicate-w1")?.click());
    expect(h.onDuplicate).toHaveBeenCalledWith("w1");
    act(() => query("workflow-export-w1")?.click());
    expect(h.onExport).toHaveBeenCalledWith("w1");
    act(() => query("workflow-delete-w1")?.click());
    expect(h.onDelete).toHaveBeenCalledWith("w1");
  });

  it("runs the workflow on row double-click", () => {
    const h = render(workflow());
    act(() => {
      query("workflow-item-w1")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(h.onRun).toHaveBeenCalledWith("w1");
  });

  it("opens the Run on… picker for the workflow (PROD-047)", () => {
    const h = render(workflow());
    act(() => query("workflow-run-on-w1")?.click());
    expect(h.onRunOn).toHaveBeenCalledWith("w1");
  });

  it("disables Run on… while the workflow is running", () => {
    render(workflow(), true);
    expect((query("workflow-run-on-w1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks a just-saved row and leaves other rows unmarked (#5687)", () => {
    const h = handlers();
    act(() => {
      root.render(
        withTooltip(
          <>
            <WorkflowListItem workflow={workflow()} running={false} justSaved {...h} />
            <WorkflowListItem
              workflow={workflow({ id: "w2", name: "Other" })}
              running={false}
              {...h}
            />
          </>
        )
      );
    });
    const saved = query("workflow-item-w1");
    expect(saved?.classList.contains("workflow-item--just-saved")).toBe(true);
    expect(saved?.getAttribute("data-just-saved")).toBe("true");
    const other = query("workflow-item-w2");
    expect(other?.classList.contains("workflow-item--just-saved")).toBe(false);
    expect(other?.hasAttribute("data-just-saved")).toBe(false);
    // The shared row shell keeps its own class alongside the mark.
    expect(saved?.classList.contains("sidebar-list-item")).toBe(true);
  });
});
