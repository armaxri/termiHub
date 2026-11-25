/**
 * The fields of every step kind, edited in the real dialog: what is typed is
 * what is stored, and an optional field that is cleared leaves no key behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
const openFile = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
vi.mock("@/services/nativeDialog", () => ({ open: openFile }));
vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  localReadFile: readFile,
}));

import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { currentSettingsView } from "@/store/settingsBridge";
import {
  automationWith,
  chooseFrom,
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
import { flushAsync } from "@/test/flushAsync";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { AutomationStep } from "@/types/generated/AutomationStep";

setupConnectionsRegion();
setupSettingsRegion();

let editor: EditorHarness;
async function open(step: AutomationStep): Promise<void> {
  editor = await mountEditor(automationWith([step]));
  click("automation-editor-steps-toggle-all");
}
/** The step as saved now. */
const saved = async () => (await editor.save()).steps[0];

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    ...automationLibraryState([automationWith([], { id: "warmup", name: "Warmup" })]),
    schedules: [],
  });
});
afterEach(() => editor.unmount());

describe("send-command", () => {
  it("edits the command", async () => {
    await open({ kind: "send-command", command: "whoami" });
    typeText("automation-editor-step-command-0", "uptime");
    expect(await saved()).toEqual({ kind: "send-command", command: "uptime" });
  });
});

describe("wait", () => {
  it("is edited in seconds and stored in milliseconds (R-167)", async () => {
    await open({ kind: "wait", delayMs: 250 });
    expect(valueOf("automation-editor-step-delay-0")).toBe("0.25");
    typeText("automation-editor-step-delay-0", "1.2");
    expect(await saved()).toEqual({ kind: "wait", delayMs: 1200 });
    typeText("automation-editor-step-delay-0", "");
    expect(await saved()).toEqual({ kind: "wait", delayMs: 0 });
  });

  it("says when a wait is longer than the runner waits", async () => {
    await open({ kind: "wait", delayMs: 60_000 });
    const body = query("automation-editor-step-body-0")!;
    expect(body.textContent).toContain("A wait lasts at most 5 s.");
    typeText("automation-editor-step-delay-0", "5");
    expect(body.textContent).not.toContain("at most");
  });
});

describe("wait-for-output", () => {
  it("edits the pattern, the regular expression switch and the timeout", async () => {
    await open({ kind: "wait-for-output", pattern: "login:" });
    typeText("automation-editor-wfo-pattern-0", "ready>");
    click("automation-editor-wfo-regex-0");
    typeText("automation-editor-wfo-timeout-0", "5");
    expect(await saved()).toEqual({
      kind: "wait-for-output",
      pattern: "ready>",
      isRegex: true,
      timeoutMs: 5000,
    });
    click("automation-editor-wfo-regex-0");
    typeText("automation-editor-wfo-timeout-0", "");
    expect(await saved()).toEqual({ kind: "wait-for-output", pattern: "ready>" });
  });
});

describe("run-automation", () => {
  it("picks the automation to run", async () => {
    await open({ kind: "run-automation", automationId: "" });
    expect(query("automation-editor-step-automation-0")?.textContent).toContain(
      "Choose an automation"
    );
    await pick("automation-editor-step-automation-0", "Warmup");
    expect(await saved()).toEqual({ kind: "run-automation", automationId: "warmup" });
  });
});

describe("run-script", () => {
  it("edits the script and the delay between its lines", async () => {
    await open({ kind: "run-script", script: "a\nb" });
    typeText("automation-editor-step-script-0", "echo hi");
    typeText("automation-editor-step-linedelay-0", "20.4");
    expect(await saved()).toEqual({ kind: "run-script", script: "echo hi", perLineDelayMs: 20 });
    typeText("automation-editor-step-linedelay-0", "");
    expect(await saved()).toEqual({ kind: "run-script", script: "echo hi" });
  });

  describe("from a file (#4310, FEC2-001)", () => {
    const file: AutomationStep = { kind: "run-script", script: "old", sourcePath: "/a.sh" };
    const allowlist = () => currentSettingsView().workflowScriptSourceAllowlist;

    it("shows the real path and flags an unconfirmed file as not runnable", async () => {
      await open({ ...file, sourcePath: "/home/u/.ssh/id_ed25519" });
      expect(query("automation-editor-step-source-path-0")?.textContent).toBe(
        "/home/u/.ssh/id_ed25519"
      );
      expect(query("automation-editor-step-source-status-0")?.textContent).toMatch(
        /not confirmed on this machine/i
      );
    });

    it("confirming adds exactly that path to the machine-local allowlist", async () => {
      await open(file);
      click("automation-editor-step-source-confirm-0");
      await flushAsync();
      expect(allowlist()).toEqual(["/a.sh"]);
      expect(query("automation-editor-step-source-confirm-0")).toBeNull();
      expect(query("automation-editor-step-source-status-0")?.textContent).toMatch(
        /read from this file/i
      );
    });

    it("shows a confirmed file without asking again", async () => {
      seedSettings({ workflowScriptSourceAllowlist: ["/a.sh"] });
      await open(file);
      expect(query("automation-editor-step-source-confirm-0")).toBeNull();
    });

    it("picking a file loads and confirms it", async () => {
      openFile.mockResolvedValueOnce("/home/u/setup.sh");
      readFile.mockResolvedValueOnce("line1\nline2");
      await open({ kind: "run-script", script: "" });
      click("automation-editor-step-source-pick-0");
      await flushAsync();
      await flushAsync();
      expect(readFile).toHaveBeenCalledWith("/home/u/setup.sh");
      expect(allowlist()).toEqual(["/home/u/setup.sh"]);
      expect(await saved()).toEqual({
        kind: "run-script",
        script: "line1\nline2",
        sourcePath: "/home/u/setup.sh",
      });
    });

    it("a canceled pick changes nothing", async () => {
      openFile.mockResolvedValueOnce(null);
      await open({ kind: "run-script", script: "x" });
      click("automation-editor-step-source-pick-0");
      await flushAsync();
      expect(readFile).not.toHaveBeenCalled();
      expect(valueOf("automation-editor-step-script-0")).toBe("x");
    });

    it("detaching keeps the visible script; editing it detaches", async () => {
      await open(file);
      click("automation-editor-step-source-detach-0");
      expect(await saved()).toEqual({ kind: "run-script", script: "old" });
      editor.unmount();
      await open(file);
      typeText("automation-editor-step-script-0", "echo new");
      expect(await saved()).toEqual({ kind: "run-script", script: "echo new" });
    });
  });
});

describe("run-local-process", () => {
  const step: AutomationStep = {
    kind: "run-local-process",
    program: "notify",
    args: ["--urgency"],
  };

  it("keeps an argument with spaces one literal argument (#1857)", async () => {
    await open(step);
    typeText("automation-editor-step-program-0", "notify-send");
    click("automation-editor-step-arg-add-0");
    typeText("automation-editor-step-arg-0-1", "hello world");
    expect(await saved()).toEqual({
      kind: "run-local-process",
      program: "notify-send",
      args: ["--urgency", "hello world"],
    });
  });

  it("removes an argument, preserving the rest", async () => {
    await open({ ...step, args: ["a", "b"] });
    click("automation-editor-step-arg-remove-0-0");
    expect(await saved()).toEqual({ ...step, args: ["b"] });
  });
});

describe("conditional", () => {
  const step: Extract<AutomationStep, { kind: "conditional" }> = {
    kind: "conditional",
    condition: { left: "${env}", op: "eq", right: "prod" },
    then: [
      { kind: "send-command", command: "one" },
      { kind: "send-command", command: "two" },
    ],
    else: [{ kind: "wait", delayMs: 5 }],
  };

  it("edits the comparison", async () => {
    await open(step);
    expect(valueOf("automation-editor-cond-right-0")).toBe("prod");
    typeText("automation-editor-cond-left-0", "${branch}");
    await pick("automation-editor-cond-op-0", "contains");
    expect(await saved()).toEqual({
      ...step,
      condition: { left: "${branch}", op: "contains", right: "prod" },
    });
  });

  it("edits, moves, deletes and adds steps of a branch", async () => {
    await open(step);
    expect(query("automation-editor-branch-0-then")?.textContent).toContain("Then (2)");
    expect(query("automation-editor-branch-0-else")?.textContent).toContain("Otherwise (1)");
    typeText("automation-editor-step-command-0-then-0", "uno");
    await chooseStep("0-then-0", "down");
    await chooseStep("0-then-0", "delete");
    await chooseFrom(
      "automation-editor-add-substep-0-then",
      "automation-editor-add-substep-0-then-wait"
    );
    expect(await saved()).toEqual({
      ...step,
      then: [
        { kind: "send-command", command: "uno" },
        { kind: "wait", delayMs: 500 },
      ],
    });
  });

  it("drops the else branch with its last step", async () => {
    await open(step);
    await chooseStep("0-else-0", "delete");
    expect(await saved()).not.toHaveProperty("else");
  });

  it("offers no further nesting", async () => {
    await open(step);
    await chooseFrom("automation-editor-step-more-0", "automation-editor-step-failure-menu-0");
    const { openMenu } = await import("@/test/automationRowMenu");
    openMenu("automation-editor-add-substep-0-then");
    expect(query("automation-editor-add-substep-0-then-run-script")).not.toBeNull();
    expect(query("automation-editor-add-substep-0-then-loop")).toBeNull();
    expect(query("automation-editor-add-substep-0-then-conditional")).toBeNull();
  });
});

describe("loop", () => {
  const count: AutomationStep = {
    kind: "loop",
    loop: { kind: "count", count: 3 },
    body: [{ kind: "send-command", command: "old" }],
  };

  it("edits the count and a step of the body", async () => {
    await open(count);
    typeText("automation-editor-loop-count-0", "7.9");
    typeText("automation-editor-step-command-0-body-0", "new");
    expect(await saved()).toEqual({
      kind: "loop",
      loop: { kind: "count", count: 7 },
      body: [{ kind: "send-command", command: "new" }],
    });
  });

  it("switches to a condition and edits it", async () => {
    await open(count);
    await pick("automation-editor-loop-mode-0", "while a condition holds");
    expect(query("automation-editor-loop-count-0")).toBeNull();
    typeText("automation-editor-cond-right-0-loop", "9");
    expect(await saved()).toMatchObject({
      loop: { kind: "while", condition: { left: "${iteration}", op: "lt", right: "9" } },
    });
  });
});

it("keeps a step from a newer version, and says it cannot be edited here", async () => {
  const future = { kind: "send-email", to: "ops" } as unknown as AutomationStep;
  await open(future);
  expect(query("automation-editor-step-kind-0")?.textContent).toBe("Unknown step (send-email)");
  expect(query("automation-editor-step-body-0")?.textContent).toContain("cannot edit this step");
  typeText("automation-editor-name", "x");
  expect(await saved()).toEqual(future);
});
