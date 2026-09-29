import { describe, it, expect } from "vitest";
import { isFatalConsoleMessage, CONSOLE_BYTES_PER_FILE_BUDGET } from "./consoleGuard";

describe("consoleGuard (#3356)", () => {
  it("treats the act-environment misconfiguration warning as fatal", () => {
    expect(
      isFatalConsoleMessage(
        "Warning: The current testing environment is not configured to support act(...)"
      )
    ).toBe(true);
  });

  it("leaves ordinary per-test warnings to the per-file budget", () => {
    expect(
      isFatalConsoleMessage(
        "Warning: An update to Modal inside a test was not wrapped in act(...)."
      )
    ).toBe(false);
    expect(isFatalConsoleMessage("Error: panel boom")).toBe(false);
  });

  it("is installed by the setup file, so React sees an act environment", () => {
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(
      true
    );
  });

  it("keeps a per-file budget far below the pre-fix volume", () => {
    // One file used to emit up to ~104 MB; the budget must stay in the KiB range.
    expect(CONSOLE_BYTES_PER_FILE_BUDGET).toBeLessThanOrEqual(1024 * 1024);
  });
});
