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
import type { LocalProcessPromptState } from "@/store/slices/workflowsSlice";

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
function openPrompt(
  program: string,
  args: string[],
  path = program,
  over: Partial<LocalProcessPromptState> = {}
) {
  const resolve = vi.fn();
  act(() => {
    useAppStore.setState({
      localProcessPrompt: {
        program,
        path,
        args,
        workflowName: "Deploy",
        remember: "program",
        imported: [],
        interpreter: false,
        resolve,
        ...over,
      },
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
  it("shows the file that would start when the program is only a name (#5994)", () => {
    render();
    openPrompt("make", ["test"], "/usr/bin/make");
    expect(query("local-process-auth-program")!.textContent).toBe("make");
    expect(query("local-process-auth-path")!.textContent).toBe("/usr/bin/make");
    expect(document.body.textContent).toContain("with any arguments");
    openPrompt("/usr/bin/make", []);
    expect(query("local-process-auth-path")).toBeNull();
  });

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

  const text = (testId: string) => query(testId)?.textContent ?? null;
  const click = (testId: string) => act(() => (query(testId) as HTMLButtonElement).click());

  describe("an imported automation (#6019)", () => {
    const theirs = { remember: "command" as const, imported: ["Deploy"] };

    it("says where it came from, and remembers only this command", () => {
      render();
      const spy = openPrompt("make", ["all"], "/usr/bin/make", theirs);
      expect(query("local-process-auth-dialog")!.textContent).toContain("imported automation");
      expect(text("local-process-auth-lead")).toContain("“Deploy” came from a file or a backup");
      expect(text("local-process-auth-always")).toBe("Allow this command");
      expect(text("local-process-auth-note")).toContain("exactly this command");
      expect(text("local-process-auth-note")).not.toContain("any arguments");
      click("local-process-auth-always");
      expect(spy).toHaveBeenCalledWith("always");
    });

    it("names the imported ones a run of one's own reaches", () => {
      render();
      openPrompt("make", [], "/usr/bin/make", { ...theirs, imported: ["Helper"] });
      expect(text("local-process-auth-lead")).toMatch(
        /^“Deploy” wants .* “Helper” is part of it and came from a file/
      );
      openPrompt("make", [], "/usr/bin/make", { ...theirs, imported: ["A", "B", "C"] });
      expect(text("local-process-auth-lead")).toContain("“A”, “B” and “C” are part of it");
    });

    it("does not warn of an interpreter: only this command is remembered", () => {
      render();
      const spy = openPrompt("sh", ["-c", "ls"], "/bin/sh", { ...theirs, interpreter: true });
      click("local-process-auth-always");
      expect(query("local-process-auth-interpreter")).toBeNull();
      expect(spy).toHaveBeenCalledWith("always");
    });
  });

  it("can only allow once what belongs to no saved automation", () => {
    render();
    const spy = openPrompt("make", [], "/usr/bin/make", { remember: "nothing" });
    expect(query("local-process-auth-always")).toBeNull();
    expect(text("local-process-auth-note")).toContain("only be allowed this time");
    click("local-process-auth-once");
    expect(spy).toHaveBeenCalledWith("once");
  });

  describe("Always allow for a program that runs whatever it is told to (#6019)", () => {
    it("says so and asks again", () => {
      render();
      const spy = openPrompt("python3", ["x.py"], "/usr/bin/python3", { interpreter: true });
      expect(query("local-process-auth-interpreter")).toBeNull();
      click("local-process-auth-always");
      expect(spy).not.toHaveBeenCalled();
      expect(text("local-process-auth-interpreter")).toContain("“python3” runs whatever");
      expect(text("local-process-auth-interpreter")).toContain("/usr/bin/python3");
      click("local-process-auth-always-anyway");
      expect(spy).toHaveBeenCalledWith("always");
    });

    it("can go back, allow once, or be closed, which refuses", () => {
      render();
      let spy = openPrompt("sh", [], "/bin/sh", { interpreter: true });
      click("local-process-auth-always");
      click("local-process-auth-back");
      expect(query("local-process-auth-interpreter")).toBeNull();
      expect(query("local-process-auth-cancel")).not.toBeNull();
      click("local-process-auth-always");
      click("local-process-auth-once");
      expect(spy).toHaveBeenCalledWith("once");
      spy = openPrompt("sh", [], "/bin/sh", { interpreter: true });
      click("local-process-auth-always");
      click("modal-close");
      expect(spy).toHaveBeenCalledWith("cancel");
    });

    it("starts over for the next program", () => {
      render();
      openPrompt("sh", [], "/bin/sh", { interpreter: true });
      click("local-process-auth-always");
      openPrompt("bash", [], "/bin/bash", { interpreter: true });
      expect(query("local-process-auth-interpreter")).toBeNull();
      expect(query("local-process-auth-always-anyway")).toBeNull();
    });
  });

  it("shows an argument as it is, also what would not show", () => {
    render();
    openPrompt("make", ["", "a  b", "safe\u202ehs.live", "x\ny"], "/usr/bin/make");
    const items = [...query("local-process-auth-args")!.querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "(empty)",
      "a  b",
      "safe\\u{202e}hs.live",
      "x\\ny",
    ]);
  });
});
