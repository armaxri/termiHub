import { describe, it, expect, vi, beforeEach } from "vitest";

const sendInput = vi.fn();
vi.mock("@/services/api", () => ({
  sendInput: (...args: unknown[]) => sendInput(...args),
}));
vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

import { sendInputDetached } from "./detachedSessionInput";
import { frontendError, frontendLog } from "@/utils/frontendLog";

const SESSION_NOT_FOUND = {
  code: "session_not_found",
  details: null,
  message: "Session not found: cf6962ca-7593-4387-92d8-2c9a5e764fe5",
};
const WRITE_FAILED = {
  code: "write_failed",
  details: null,
  message: "Failed to write to terminal: session disconnected",
};

describe("sendInputDetached (#5384)", () => {
  beforeEach(() => {
    sendInput.mockReset();
    vi.mocked(frontendLog).mockReset();
    vi.mocked(frontendError).mockReset();
  });

  it("delivers input to a live session", async () => {
    sendInput.mockResolvedValue(undefined);
    await expect(sendInputDetached("s1", "ls\n", "typed input")).resolves.toBe(true);
    expect(sendInput).toHaveBeenCalledWith("s1", "ls\n");
    expect(frontendError).not.toHaveBeenCalled();
  });

  it.each([
    ["session_not_found", SESSION_NOT_FOUND],
    ["write_failed", WRITE_FAILED],
  ])("drops input to an ended session (%s) without rejecting", async (_name, err) => {
    sendInput.mockRejectedValue(err);
    await expect(sendInputDetached("gone", "\x1b[O", "typed input")).resolves.toBe(false);
    // Traced, not surfaced: the session's exit path owns telling the user.
    expect(frontendLog).toHaveBeenCalledWith("terminal", expect.stringContaining("already ended"));
    expect(frontendError).not.toHaveBeenCalled();
  });

  it("surfaces a genuine failure on a live session as an error", async () => {
    sendInput.mockRejectedValue({ code: "internal_error", message: "boom" });
    await expect(sendInputDetached("s1", "x", "paste")).resolves.toBe(false);
    expect(frontendError).toHaveBeenCalledWith(
      "terminal",
      "paste to session s1 failed: internal_error: boom"
    );
  });

  it("leaves no unhandled rejection when fired without awaiting", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      sendInput.mockRejectedValue(SESSION_NOT_FOUND);
      void sendInputDetached("gone", "a", "typed input");
      sendInput.mockRejectedValue(WRITE_FAILED);
      void sendInputDetached("gone", "b", "broadcast input");
      // Let the rejections settle and the unhandled-rejection hook run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
