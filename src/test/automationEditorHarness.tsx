/**
 * Drives the automation editor (#5818, slice 7) in component tests: one place
 * that mounts it on an automation and reads back what it saves.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi, type Mock } from "vitest";
import {
  AutomationEditorDialog,
  type AutomationSaveRequest,
} from "@/components/AutomationEditor/AutomationEditorDialog";
import { flushAsync } from "@/test/flushAsync";
import { openMenu } from "@/test/automationRowMenu";
import { withTooltip } from "@/test/tooltip";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";

/** Query by `data-testid`, portalled content included. */
export const query = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Click an element; throws when it is missing. */
export function click(testId: string): void {
  const el = query(testId);
  if (!el) throw new Error(`no ${testId}`);
  act(() => el.click());
}

/** Type into an input or textarea the way React sees a keystroke. */
export function typeText(testId: string, value: string): void {
  const el = query(testId);
  if (!el) throw new Error(`no ${testId}`);
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The value of an input. */
export const valueOf = (testId: string): string => (query(testId) as HTMLInputElement).value;

/** Press a key on an element. */
export function press(testId: string, key: string): void {
  const el = query(testId);
  if (!el) throw new Error(`no ${testId}`);
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Choose an entry of a menu opened from `trigger`, then let it close. */
export async function chooseFrom(trigger: string, item: string): Promise<void> {
  openMenu(trigger);
  click(item);
  await flushAsync();
  await flushAsync();
}

/** Choose an entry (`delete`, `up`, `failure-menu`, …) of a step's "…" menu. */
export const chooseStep = (path: string, entry: string): Promise<void> =>
  chooseFrom(`automation-editor-step-more-${path}`, `automation-editor-step-${entry}-${path}`);

/** Pick an option of a Select by its label. */
export async function pick(select: string, label: string): Promise<void> {
  press(select, "Enter");
  await flushAsync();
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent === label
  );
  if (!option) throw new Error(`no option ${label}`);
  act(() => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flushAsync();
}

/** An automation with the given steps. */
export function automationWith(
  steps: AutomationStep[],
  over: Partial<Automation> = {}
): Automation {
  return {
    id: "a-1",
    name: "Deploy prep",
    tags: [],
    steps,
    triggers: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** A mounted editor. */
export interface EditorHarness {
  onSave: Mock<(request: AutomationSaveRequest) => Promise<void>>;
  onClose: Mock<() => void>;
  /** Save and return the automation it stores. */
  save: () => Promise<Automation>;
  unmount: () => void;
}

/** Mount the editor on `automation`. */
export async function mountEditor(
  automation: Automation,
  { isNew = false } = {}
): Promise<EditorHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onSave = vi.fn<(request: AutomationSaveRequest) => Promise<void>>().mockResolvedValue();
  const onClose = vi.fn<() => void>();
  await act(async () =>
    root.render(
      withTooltip(
        <AutomationEditorDialog
          automation={automation}
          isNew={isNew}
          onClose={onClose}
          onSave={onSave}
        />
      )
    )
  );
  await flushAsync();
  return {
    onSave,
    onClose,
    save: async () => {
      click("automation-editor-save");
      await flushAsync();
      const { calls } = onSave.mock;
      const request = calls[calls.length - 1]?.[0];
      if (!request?.automation) throw new Error("nothing was saved");
      return request.automation;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
