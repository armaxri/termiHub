import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
vi.mock("@/services/localProcessApi", () => ({
  listConfirmedLocalCommands: vi.fn(),
  revokeConfirmedLocalCommands: vi.fn(),
  interpretersAmong: vi.fn(),
}));

import {
  interpretersAmong,
  listConfirmedLocalCommands,
  revokeConfirmedLocalCommands,
  type ConfirmedLocalCommands,
} from "@/services/localProcessApi";
import { AllowedPrograms } from "./AllowedPrograms";
import { ConfirmedCommands } from "./ConfirmedCommands";

const GROUPS: ConfirmedLocalCommands[] = [
  {
    automationId: "a",
    automationName: "Deploy",
    commands: [
      { key: "k1", path: "/usr/bin/make", args: ["all", "a\u202eb", ""] },
      { key: "k2", args: [] },
    ],
  },
  { automationId: "b", commands: [{ key: "k3", path: "C:\\tools\\x.exe", args: [] }] },
];

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => query(id)!.click());
};
const render = async (groups: ConfirmedLocalCommands[] = GROUPS) => {
  vi.mocked(listConfirmedLocalCommands).mockResolvedValue(groups);
  await act(async () => root.render(<ConfirmedCommands />));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revokeConfirmedLocalCommands).mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("confirmed commands (#6057)", () => {
  it("shows nothing without any", async () => {
    await render([]);
    expect(query("confirmed-commands")).toBeNull();
  });

  it("names the automation and each command shortly, and the whole command when opened", async () => {
    await render();
    const text = query("confirmed-commands")!.textContent!;
    expect(text).toContain("Deploy");
    expect(text).toContain("Deleted automation");
    expect(text).toContain("A command confirmed in an earlier version");
    const details = [...container.querySelectorAll("details")];
    expect(details.map((d) => d.open)).toEqual([false, false]);
    expect(details[0].querySelector("summary")!.textContent).toBe("make all a\\u{202e}b ");
    const full = [...details[0].querySelectorAll(".confirmed-commands__full span")];
    expect(full.map((s) => s.textContent)).toEqual([
      "/usr/bin/make",
      "all",
      "a\\u{202e}b",
      "(empty)",
    ]);
    expect(details[1].querySelector("summary")!.textContent).toBe("x.exe");
  });

  it("revokes one", async () => {
    await render();
    vi.mocked(listConfirmedLocalCommands).mockResolvedValue([GROUPS[1]]);
    await click("confirmed-command-revoke-k1");
    expect(revokeConfirmedLocalCommands).toHaveBeenCalledExactlyOnceWith("a", "k1");
    expect(query("confirmed-command-revoke-k1")).toBeNull();
  });

  it("revokes all of one automation after asking", async () => {
    await render();
    // One command has its own button only.
    expect(query("confirmed-commands-revoke-b")).toBeNull();
    await click("confirmed-commands-revoke-a");
    expect(query("confirmed-commands-dialog")!.textContent).toContain("“Deploy”");
    expect(revokeConfirmedLocalCommands).not.toHaveBeenCalled();
    await click("confirmed-commands-dialog-confirm");
    expect(revokeConfirmedLocalCommands).toHaveBeenCalledExactlyOnceWith("a", null);
  });

  it("revokes all after asking", async () => {
    await render();
    await click("confirmed-commands-revoke-all");
    await click("confirmed-commands-dialog-cancel");
    expect(revokeConfirmedLocalCommands).not.toHaveBeenCalled();
    await click("confirmed-commands-revoke-all");
    await click("confirmed-commands-dialog-confirm");
    expect(revokeConfirmedLocalCommands).toHaveBeenCalledExactlyOnceWith(null, null);
  });

  it("says when a command could not be revoked, or the list not be read", async () => {
    await render();
    vi.mocked(revokeConfirmedLocalCommands).mockRejectedValue(new Error("cannot be taken back"));
    await click("confirmed-command-revoke-k3");
    expect(query("confirmed-commands-error")!.textContent).toContain("cannot be taken back");
    expect(query("confirmed-command-revoke-k3")).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    vi.mocked(listConfirmedLocalCommands).mockRejectedValue(new Error("locked"));
    await act(async () => root.render(<ConfirmedCommands />));
    expect(query("confirmed-commands-error")!.textContent).toContain("locked");
  });
});

describe("allowed programs (#6057)", () => {
  const programs = ["/bin/sh", "make"];

  it("warns at a program that runs whatever it is told to", async () => {
    vi.mocked(interpretersAmong).mockResolvedValue(["/bin/sh"]);
    const onRemove = vi.fn();
    await act(async () => root.render(<AllowedPrograms programs={programs} onRemove={onRemove} />));
    expect(interpretersAmong).toHaveBeenCalledWith(programs);
    expect(query("workflow-allowlist-interpreter-/bin/sh")!.textContent).toContain(
      "Runs whatever it is told to"
    );
    expect(query("workflow-allowlist-interpreter-make")).toBeNull();
    await click("workflow-allowlist-remove-make");
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("make");
  });

  it("lists them when they cannot be checked, and asks nothing about none", async () => {
    vi.mocked(interpretersAmong).mockRejectedValue(new Error("x"));
    await act(async () => root.render(<AllowedPrograms programs={programs} onRemove={vi.fn()} />));
    expect(query("workflow-allowlist")!.querySelectorAll("li")).toHaveLength(2);
    vi.mocked(interpretersAmong).mockClear();
    await act(async () => root.render(<AllowedPrograms programs={[]} onRemove={vi.fn()} />));
    expect(interpretersAmong).not.toHaveBeenCalled();
    expect(query("workflow-allowlist-empty")).not.toBeNull();
  });
});
