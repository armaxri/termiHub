/**
 * Layout of the workflow editor (#5637): one scroll container (the Modal
 * body), compact step rows that collapse to a summary line, token spacing
 * between the header fields, Triggers ahead of the step list, per-step failure
 * options on one row, and trigger chips that read as a multi-select.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import { withTooltip } from "@/test/tooltip";
import type { Workflow } from "@/types/workflow";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "WorkflowEditorDialog.css"),
  "utf8"
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const workflow: Workflow = {
  id: "workflow-1",
  name: "Deploy",
  tags: [],
  steps: [
    { kind: "send-command", command: "make deploy", continueOnError: true },
    { kind: "wait", delayMs: 500 },
    { kind: "wait-for-output", pattern: "READY" },
  ],
  triggers: [{ kind: "manual" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function render(wf: Workflow = workflow) {
  act(() => {
    root.render(
      withTooltip(
        <WorkflowEditorDialog
          open
          workflow={wf}
          macros={[]}
          connections={[]}
          onOpenChange={vi.fn()}
          onSave={vi.fn()}
        />
      )
    );
  });
}

function click(testId: string) {
  act(() => (query(testId) as HTMLElement).click());
}

describe("WorkflowEditorDialog layout (#5637)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens existing steps collapsed to one summary line each", () => {
    render();
    for (let i = 0; i < workflow.steps.length; i++) {
      expect(query(`workflow-editor-step-toggle-${i}`)?.getAttribute("aria-expanded")).toBe(
        "false"
      );
      expect(query(`workflow-editor-step-body-${i}`)).toBeNull();
    }
    expect(query("workflow-editor-step-summary-0")?.textContent).toContain("make deploy");
    expect(query("workflow-editor-step-summary-0")?.textContent).toContain("Continues on error");
    expect(query("workflow-editor-step-summary-1")?.textContent).toContain("500 ms");
    expect(query("workflow-editor-step-summary-2")?.textContent).toContain("READY");
    expect(query("workflow-editor-step-command-0")).toBeNull();
  });

  it("expands and collapses a step from its header", () => {
    render();
    click("workflow-editor-step-toggle-0");
    expect(query("workflow-editor-step-toggle-0")?.getAttribute("aria-expanded")).toBe("true");
    expect(query("workflow-editor-step-command-0")).not.toBeNull();
    expect(query("workflow-editor-step-summary-0")).toBeNull();
    click("workflow-editor-step-toggle-0");
    expect(query("workflow-editor-step-command-0")).toBeNull();
  });

  it("expands and collapses every step at once", () => {
    render();
    const all = () => query("workflow-editor-steps-toggle-all") as HTMLButtonElement;
    expect(all().textContent).toBe("Expand all");
    click("workflow-editor-steps-toggle-all");
    expect(query("workflow-editor-step-body-0")).not.toBeNull();
    expect(query("workflow-editor-step-body-2")).not.toBeNull();
    expect(all().textContent).toBe("Collapse all");
    click("workflow-editor-steps-toggle-all");
    expect(query("workflow-editor-step-body-1")).toBeNull();
  });

  it("opens a step with an out-of-bounds failure policy expanded", () => {
    render({
      ...workflow,
      steps: [
        { kind: "send-command", command: "ok" },
        { kind: "send-command", command: "bad", retry: { count: 0 } },
      ],
    });
    expect(query("workflow-editor-step-body-0")).toBeNull();
    expect(query("workflow-editor-step-body-1")).not.toBeNull();
  });

  it("opens a newly added step expanded", async () => {
    render({ ...workflow, steps: [] });
    const trigger = query("workflow-editor-add-step") as HTMLButtonElement;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    });
    for (let i = 0; i < 20 && !query("workflow-editor-add-step-send-command"); i++) {
      await act(async () => {
        await nextFrame();
      });
    }
    click("workflow-editor-add-step-send-command");
    expect(query("workflow-editor-step-toggle-0")?.getAttribute("aria-expanded")).toBe("true");
    expect(query("workflow-editor-step-command-0")).not.toBeNull();
  });

  it("puts Triggers ahead of the step list", () => {
    render();
    const triggers = query("workflow-editor-triggers") as HTMLElement;
    const steps = query("workflow-editor-steps") as HTMLElement;
    expect(triggers.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts both failure options on one row, label beside the switch", () => {
    render();
    click("workflow-editor-step-toggle-0");
    const cont = query("workflow-editor-step-continue-0") as HTMLElement;
    const retry = query("workflow-editor-step-retry-0") as HTMLElement;
    const row = cont.closest(".workflow-step__policy-toggles");
    expect(row).not.toBeNull();
    expect(row?.contains(retry)).toBe(true);
    expect(cont.closest(".ui-field--checkbox")).not.toBeNull();
    expect(retry.closest(".ui-field--checkbox")).not.toBeNull();
  });

  it("shows a check mark on the triggers that are on", () => {
    render();
    const manual = query("workflow-trigger-manual") as HTMLElement;
    const hotkey = query("workflow-trigger-hotkey") as HTMLElement;
    expect(manual.querySelector("svg.lucide-check")).not.toBeNull();
    expect(hotkey.querySelector("svg.lucide-check")).toBeNull();
    click("workflow-trigger-hotkey");
    expect(
      (query("workflow-trigger-hotkey") as HTMLElement).querySelector("svg.lucide-check")
    ).not.toBeNull();
  });

  it("wraps the fields in one token-spaced column", () => {
    render();
    const form = query("workflow-editor-form") as HTMLElement;
    for (const id of [
      "workflow-editor-name",
      "workflow-editor-description",
      "workflow-editor-tags",
    ]) {
      expect(form.contains(query(id))).toBe(true);
    }
    expect(rule(".workflow-editor__form")).toMatch(/gap:\s*var\(--spacing-lg\)/);
  });

  it("has no inner scroll box: steps and trigger connections flow in the body", () => {
    for (const selector of [".workflow-editor__steps", ".workflow-triggers__connections"]) {
      const decl = rule(selector);
      expect(decl).not.toMatch(/overflow/);
      expect(decl).not.toMatch(/max-height/);
    }
  });

  it("sets step type titles in the UI font, semibold", () => {
    const decl = rule(".workflow-step__kind");
    expect(decl).not.toMatch(/font-mono/);
    expect(decl).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
  });
});
