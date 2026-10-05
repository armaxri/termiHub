/**
 * Regression test for #4104: the install/uninstall commands reject with a
 * structured `{ code, message }` IPC envelope; the error toast must show its
 * message rather than "[object Object]".
 */
import { describe, it, expect } from "vitest";
import { INSTALL_TOAST, UNINSTALL_TOAST } from "./shellIntegrationStore";

const envelope = { code: "io_error", message: "profile file is not writable" };

describe("shell integration toasts — structured IPC error (#4104)", () => {
  it("renders the envelope's message on install failure", () => {
    const error = INSTALL_TOAST.error as (e: unknown) => string;
    expect(error(envelope)).toBe("Registration failed: profile file is not writable");
  });

  it("renders the envelope's message on uninstall failure", () => {
    const error = UNINSTALL_TOAST.error as (e: unknown) => string;
    expect(error(envelope)).toBe("Removal failed: profile file is not writable");
  });
});
