import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { checkLocalProcess, invokeRunLocalProcess } from "./localProcessApi";

describe("localProcessApi (#5994)", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the backend about a program", async () => {
    invoke.mockResolvedValue({ status: "allowed", path: "/bin/make" });
    expect(await checkLocalProcess("make")).toEqual({ status: "allowed", path: "/bin/make" });
    expect(invoke).toHaveBeenCalledWith("check_local_process", { program: "make" });
  });

  it("passes on the file the user approved, and none otherwise", async () => {
    const args = { runId: "r", program: "make", args: ["x"] };
    await invokeRunLocalProcess({ ...args, approvedPath: "/bin/make" });
    await invokeRunLocalProcess(args);
    expect(invoke.mock.calls.map(([, a]) => a.approvedPath)).toEqual(["/bin/make", null]);
  });
});
