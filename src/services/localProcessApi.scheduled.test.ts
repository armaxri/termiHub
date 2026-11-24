import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { invokeRunLocalProcess } from "./localProcessApi";

describe("invokeRunLocalProcess", () => {
  it("tells the backend whether a schedule started the run (#5818)", async () => {
    const args = { runId: "r", program: "make", args: [] };
    await invokeRunLocalProcess({ ...args, scheduled: true });
    expect(invoke).toHaveBeenLastCalledWith(
      "run_local_process",
      expect.objectContaining({ scheduled: true })
    );
    await invokeRunLocalProcess(args);
    expect(invoke).toHaveBeenLastCalledWith(
      "run_local_process",
      expect.objectContaining({ scheduled: false })
    );
  });
});
