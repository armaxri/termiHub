import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { checkLocalProcess, confirmLocalProcess, invokeRunLocalProcess } from "./localProcessApi";

describe("localProcessApi (#5994, #6019)", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the backend about a command and the automations behind it", async () => {
    invoke.mockResolvedValue({ status: "allowed", path: "/bin/make" });
    expect(await checkLocalProcess("make", ["all"], ["a", "b"])).toEqual({
      status: "allowed",
      path: "/bin/make",
    });
    expect(invoke).toHaveBeenCalledWith("check_local_process", {
      program: "make",
      args: ["all"],
      automationChain: ["a", "b"],
    });
  });

  it("passes on the file the user approved, and none otherwise", async () => {
    const args = { runId: "r", program: "make", args: ["x"], automationChain: ["a"] };
    await invokeRunLocalProcess({ ...args, approvedPath: "/bin/make" });
    await invokeRunLocalProcess(args);
    expect(invoke.mock.calls.map(([, a]) => a.approvedPath)).toEqual(["/bin/make", null]);
    expect(invoke.mock.calls[0][1].automationChain).toEqual(["a"]);
  });

  it("confirms a command as the file that was shown", async () => {
    await confirmLocalProcess("make", ["all"], ["a"], "/bin/make");
    expect(invoke).toHaveBeenCalledWith("confirm_local_process", {
      program: "make",
      args: ["all"],
      automationChain: ["a"],
      path: "/bin/make",
    });
  });
});
