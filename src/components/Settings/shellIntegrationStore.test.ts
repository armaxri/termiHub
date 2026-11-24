/**
 * Regression test for #4104: the install/uninstall commands reject with a
 * structured `{ code, message }` IPC envelope; the error toast must show its
 * message rather than "[object Object]". The wording names the platform's file
 * manager, like the settings page and the offer (#5845).
 */
import { describe, it, expect } from "vitest";
import { installToast, uninstallToast } from "./shellIntegrationStore";

const envelope = { code: "io_error", message: "profile file is not writable" };

describe("shell integration toasts — structured IPC error (#4104)", () => {
  it("renders the envelope's message on install failure", () => {
    const error = installToast("Finder").error as (e: unknown) => string;
    expect(error(envelope)).toBe("Could not add it to Finder: profile file is not writable");
  });

  it("renders the envelope's message on uninstall failure", () => {
    const error = uninstallToast("File Explorer").error as (e: unknown) => string;
    expect(error(envelope)).toBe(
      "Could not remove it from File Explorer: profile file is not writable"
    );
  });

  it("names the feature and the place in the progress and success messages (#5845)", () => {
    const add = installToast("Finder");
    expect(add.loading).toBe("Adding “Open in termiHub” to Finder…");
    expect(add.success).toBe("Added “Open in termiHub” to Finder");
    const remove = uninstallToast("your file manager");
    expect(remove.success).toBe("Removed “Open in termiHub” from your file manager");
  });
});
