/**
 * "If this step fails" (PROD-045): stop or continue, bounded retries, on every
 * step including nested ones, and the runner's caps as the Save gate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { MAX_RETRY_DELAY_MS, MAX_STEP_RETRIES } from "@/services/workflowRunner";
import {
  automationWith,
  chooseStep,
  click,
  mountEditor,
  pick,
  query,
  typeText,
  valueOf,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { leaveField } from "@/test/leaveField";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { DEFAULT_STEP_RETRY, stepPolicyErrors } from "./stepPolicySchema";

setupConnectionsRegion();
setupSettingsRegion();

const command: AutomationStep = { kind: "send-command", command: "make deploy" };
const loop: AutomationStep = {
  kind: "loop",
  loop: { kind: "count", count: 2 },
  body: [{ kind: "wait", delayMs: 1 }],
};

let editor: EditorHarness;
async function open(step: AutomationStep = command): Promise<void> {
  editor = await mountEditor(automationWith([step]));
}
const saved = async () => (await editor.save()).steps[0];
const blocked = () => query("automation-editor-save")!.hasAttribute("data-invalid");
afterEach(() => editor.unmount());

describe("the options", () => {
  it("continue, and back to stop without a key left behind", async () => {
    await open();
    await chooseStep("0", "failure-menu");
    await pick("automation-editor-step-on-failure-0", "Continue with the next step");
    expect(await saved()).toEqual({ ...command, continueOnError: true });
    await pick("automation-editor-step-on-failure-0", "Stop the automation");
    typeText("automation-editor-name", "x");
    expect(await saved()).toEqual(command);
  });

  it("retry with defaults, edited, and off again", async () => {
    await open();
    await chooseStep("0", "failure-menu");
    click("automation-editor-step-retry-0");
    expect(valueOf("automation-editor-step-retry-count-0")).toBe(String(DEFAULT_STEP_RETRY.count));
    expect(valueOf("automation-editor-step-retry-delay-0")).toBe("1");
    typeText("automation-editor-step-retry-count-0", "5");
    typeText("automation-editor-step-retry-delay-0", "0.25");
    await pick("automation-editor-step-retry-backoff-0", "Double each time");
    expect(await saved()).toEqual({
      ...command,
      retry: { count: 5, delayMs: 250, backoff: "exponential" },
    });
    typeText("automation-editor-step-retry-delay-0", "");
    expect(await saved()).toEqual({ ...command, retry: { count: 5, backoff: "exponential" } });
    click("automation-editor-step-retry-0");
    typeText("automation-editor-name", "x");
    expect(await saved()).toEqual(command);
  });

  it("are offered on nested steps", async () => {
    await open(loop);
    click("automation-editor-step-toggle-0");
    await chooseStep("0-body-0", "failure-menu");
    await pick("automation-editor-step-on-failure-0-body-0", "Continue with the next step");
    expect(await saved()).toMatchObject({ body: [{ kind: "wait", continueOnError: true }] });
  });
});

describe("the bounds", () => {
  it.each([
    ["count", "0", /Retries must be a whole number/],
    ["count", "2.5", /Retries must be a whole number/],
    ["count", String(MAX_STEP_RETRIES + 1), /Retries must be a whole number/],
    ["delay", "-1", /between 0 and 60 seconds/],
    ["delay", String(MAX_RETRY_DELAY_MS / 1000 + 1), /between 0 and 60 seconds/],
  ])("block Save on a retry %s of %s, and say so once the field is left", async (f, v, message) => {
    await open({ ...command, retry: { count: 2, delayMs: 1000 } });
    click("automation-editor-step-toggle-0");
    const field = `automation-editor-step-retry-${f}-0`;
    typeText(field, v);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    leaveField(query(field));
    expect(query(field)?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(message);
    expect(blocked()).toBe(true);
  });
});

describe("stepPolicyErrors", () => {
  it("accepts no policy, and one within the bounds", () => {
    expect(stepPolicyErrors(command)).toEqual({});
    expect(
      stepPolicyErrors({
        ...command,
        continueOnError: true,
        retry: { count: MAX_STEP_RETRIES, delayMs: MAX_RETRY_DELAY_MS, backoff: "exponential" },
      })
    ).toEqual({});
  });

  it("names the field that is out of bounds", () => {
    expect(stepPolicyErrors({ ...command, retry: { count: 0 } })).toHaveProperty("count");
    expect(stepPolicyErrors({ ...command, retry: { count: 1, delayMs: -1 } })).toHaveProperty(
      "delayMs"
    );
  });
});
