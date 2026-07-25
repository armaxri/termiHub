/**
 * Tests for the command palette's command registry (#1484).
 *
 * The registry is sourced from the keybinding actions so labels and
 * accelerators have a single source of truth; only actions with a runner are
 * surfaced, and running a command invokes the matching store action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCommands } from "./commands";
import { getActionAccelerator, clearOverrides } from "./keybindings";
import { useAppStore } from "@/store/appStore";

describe("buildCommands", () => {
  beforeEach(() => {
    clearOverrides();
    useAppStore.setState({ ...useAppStore.getInitialState() });
  });

  it("sources label and accelerator from the keybinding action", () => {
    const commands = buildCommands();
    const newTerminal = commands.find((c) => c.id === "new-terminal");
    expect(newTerminal).toBeDefined();
    expect(newTerminal!.label).toBe("New Terminal");
    // Accelerator comes straight from the keybinding service — no duplication.
    expect(newTerminal!.accelerator).toBe(getActionAccelerator("new-terminal"));
  });

  it("only surfaces actions that have a runner", () => {
    const ids = buildCommands().map((c) => c.id);
    // Runnable, store-only commands are present…
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("open-settings");
    expect(ids).toContain("zoom-in");
    // …as are the context-bound commands added in #1527…
    expect(ids).toContain("close-tab");
    expect(ids).toContain("next-tab");
    expect(ids).toContain("prev-tab");
    expect(ids).toContain("focus-up");
    expect(ids).toContain("clear-terminal");
    expect(ids).toContain("find-in-terminal");
    // …including the multi-window tear-out command (#1901)…
    expect(ids).toContain("move-tab-to-new-window");
    // …and the top-level New Window command (#1902)…
    expect(ids).toContain("new-window");
    // …while the palette's own shortcut has no runner and stays out.
    expect(ids).not.toContain("command-palette");
  });

  it("runs the matching store action", () => {
    const toggleSidebar = vi.fn();
    useAppStore.setState({ toggleSidebar });
    const cmd = buildCommands().find((c) => c.id === "toggle-sidebar");
    cmd!.run();
    expect(toggleSidebar).toHaveBeenCalledOnce();
  });

  it("runs openNewWindow for the New Window command (#1902)", () => {
    const openNewWindow = vi.fn();
    useAppStore.setState({ openNewWindow });
    const cmd = buildCommands().find((c) => c.id === "new-window");
    expect(cmd).toBeDefined();
    expect(cmd!.label).toBe("New Window");
    cmd!.run();
    expect(openNewWindow).toHaveBeenCalledOnce();
  });

  it("marks store-only commands as always available", () => {
    const cmd = buildCommands().find((c) => c.id === "toggle-sidebar");
    expect(cmd!.available).toBe(true);
  });

  it("marks context-bound commands unavailable when no target applies", () => {
    // Fresh state: empty active panel, single leaf, no terminal — every
    // context-bound command is a no-op and reports itself unavailable.
    const commands = buildCommands();
    for (const id of ["close-tab", "next-tab", "focus-up", "clear-terminal", "find-in-terminal"]) {
      expect(commands.find((c) => c.id === id)!.available).toBe(false);
    }
  });

  it("marks a context-bound command available once its target exists", () => {
    useAppStore.getState().addTab("Shell", "local");
    const available = buildCommands().find((c) => c.id === "close-tab")!.available;
    expect(available).toBe(true);
  });
});
