import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { checkA11y } from "@/test/axe";
import { click, pick, press, query, typeText, valueOf } from "@/test/automationEditorHarness";
import { clickScrim, pressEscape } from "@/test/dirtyDismiss";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import type { RecordedTake } from "@/store/slices/recordingSlice";
import { RecordingSaveDialog, type RecordingSaveDialogProps } from "./RecordingSaveDialog";

const take: RecordedTake = {
  id: "t",
  chunks: [
    { data: "git pull", delayMs: 0 },
    { data: "\r", delayMs: 200 },
  ],
  secrets: [],
  durationMs: 3200,
  tabTitle: "prod-web",
  ended: "stopped",
  forEditor: false,
};
const withPassword: RecordedTake = {
  ...take,
  chunks: [
    { data: "sudo -v\r", delayMs: 0 },
    { data: "hunter2", delayMs: 900 },
    { data: "\r", delayMs: 50 },
  ],
  secrets: [{ start: 1, end: 3, prompt: "[sudo] password for arne:" }],
};

let container: HTMLDivElement;
let root: Root;
let props: RecordingSaveDialogProps;

async function render(over: Partial<RecordingSaveDialogProps> = {}): Promise<void> {
  props = {
    take,
    automations: [
      { id: "x", name: "Deploy" },
      { id: "y", name: "git pull" },
    ],
    startHeld: false,
    onKeep: vi.fn(),
    onDiscard: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  await act(async () => root.render(withTooltip(<RecordingSaveDialog {...props} />)));
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

describe("RecordingSaveDialog", () => {
  it("is one Enter away: named after what was typed, unique, selected", async () => {
    await render();
    expect(query("recording-save-summary")?.textContent).toContain("Recorded in prod-web, 3.2 s");
    expect(query("recording-save-summary")?.textContent).toContain("git pull");
    const name = query("recording-save-name") as HTMLInputElement;
    expect(name.value).toBe("git pull 2");
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, name.value.length]);
    press("recording-save-name", "Enter");
    await flushAsync();
    expect(props.onSave).toHaveBeenCalledWith({
      to: "new",
      name: "git pull 2",
      description: undefined,
      tags: [],
      keepSecrets: false,
    });
  });

  it("takes a description and tags on request", async () => {
    await render();
    expect(query("recording-save-tags")).toBeNull();
    click("recording-save-details");
    typeText("recording-save-description", " Pulls  the code ");
    typeText("recording-save-tags", "ops, git");
    click("recording-save-confirm");
    await flushAsync();
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Pulls the code", tags: ["ops", "git"] })
    );
  });

  it("adds to an existing automation", async () => {
    await render();
    click("recording-save-to-existing");
    expect(query("recording-save-name")).toBeNull();
    click("recording-save-confirm");
    await flushAsync();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(query("recording-save-dialog")?.textContent).toContain("Choose an automation.");
    await pick("recording-save-automation", "Deploy");
    click("recording-save-confirm");
    await flushAsync();
    expect(props.onSave).toHaveBeenCalledWith({
      to: "existing",
      automationId: "x",
      keepSecrets: false,
    });
  });

  it("offers no existing automation when there is none", async () => {
    await render({ automations: [] });
    expect(query("recording-save-to-existing")).toBeNull();
  });

  it("asks for a name only once it is missing on Save", async () => {
    await render();
    typeText("recording-save-name", "  ");
    expect(query("recording-save-dialog")?.textContent).not.toContain("Name is required.");
    click("recording-save-confirm");
    await flushAsync();
    expect(query("recording-save-dialog")?.textContent).toContain("Name is required.");
    expect(document.activeElement).toBe(query("recording-save-name"));
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["Escape", () => pressEscape("recording-save-name")],
    ["a scrim click", () => clickScrim("recording-save-dialog")],
    ["the X", () => click("modal-close")],
  ])("%s keeps the recording", async (_name, dismiss) => {
    await render();
    dismiss();
    expect(props.onKeep).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("discards only on Discard recording", async () => {
    await render();
    click("recording-save-discard");
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onKeep).not.toHaveBeenCalled();
  });

  it.each([
    [{ startHeld: true }, "before you start another one"],
    [{ take: { ...take, ended: "session-ended" as const } }, "the session ended"],
    [{ take: { ...take, ended: "tab-gone" as const } }, "closed or moved to another window"],
  ])("says why it is there: %j", async (over, text) => {
    await render(over);
    expect(query("recording-save-note")?.textContent).toContain(text);
  });

  describe("after a password prompt", () => {
    it("names the prompt, shows no password, and leaves it out by default", async () => {
      await render({ take: withPassword });
      expect(query("recording-save-secrets")?.textContent).toContain("[sudo] password for arne:");
      expect(document.body.textContent).not.toContain("hunter2");
      expect(valueOf("recording-save-name")).toBe("sudo -v");
      expect(query("recording-save-secrets-leave-out")?.getAttribute("aria-checked")).toBe("true");
      click("recording-save-confirm");
      await flushAsync();
      expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ keepSecrets: false }));
    });

    it("stores it when that is chosen", async () => {
      await render({ take: withPassword });
      click("recording-save-secrets-keep");
      click("recording-save-confirm");
      await flushAsync();
      expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ keepSecrets: true }));
    });

    it("cannot save nothing", async () => {
      const only = {
        ...withPassword,
        chunks: withPassword.chunks.slice(1),
        secrets: [{ start: 0, end: 2, prompt: "Password:" }],
      };
      await render({ take: only });
      expect(valueOf("recording-save-name")).toBe("Recording in prod-web");
      expect(query("recording-save-empty")).not.toBeNull();
      click("recording-save-confirm");
      await flushAsync();
      expect(props.onSave).not.toHaveBeenCalled();
      click("recording-save-secrets-keep");
      click("recording-save-confirm");
      await flushAsync();
      expect(props.onSave).toHaveBeenCalled();
    });
  });

  it("has no accessibility violations", async () => {
    await render({ take: withPassword });
    await checkA11y(query("recording-save-dialog")!);
  });
});
