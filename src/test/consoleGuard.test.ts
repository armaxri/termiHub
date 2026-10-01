import { describe, it, expect } from "vitest";
import {
  isFatalConsoleMessage,
  isSilencedConsoleMessage,
  CONSOLE_BYTES_PER_FILE_BUDGET,
  REACT_VIRTUAL_FLUSH_SYNC_WARNING,
} from "./consoleGuard";

const FB_TEST = "/repo/src/components/Sidebar/FileBrowser.test.tsx";
const FB_WIN_TEST = "C:\\repo\\src\\components\\Sidebar\\FileBrowser.rename.test.tsx";
const FLUSH_SYNC_FROM_FILE_BROWSER =
  `${REACT_VIRTUAL_FLUSH_SYNC_WARNING}\n    at FileBrowser (/repo/src/components/Sidebar/FileBrowser.tsx:1:1)` +
  "\n    at TooltipProvider (/repo/src/components/ui/Tooltip.tsx:7:3)";

describe("consoleGuard flushSync filter (#3897)", () => {
  it("drops react-virtual's flushSync warning from FileBrowser in FileBrowser tests", () => {
    expect(isSilencedConsoleMessage("error", FLUSH_SYNC_FROM_FILE_BROWSER, FB_TEST)).toBe(true);
    expect(isSilencedConsoleMessage("error", FLUSH_SYNC_FROM_FILE_BROWSER, FB_WIN_TEST)).toBe(true);
  });

  it("keeps the warning in any other test file", () => {
    for (const path of [
      "/repo/src/components/Sidebar/Sidebar.test.tsx",
      "/repo/src/components/Sidebar/FileBrowserPathBar.test.tsx.bak",
      "/repo/src/components/Other/FileBrowser.test.tsx",
      undefined,
    ]) {
      expect(isSilencedConsoleMessage("error", FLUSH_SYNC_FROM_FILE_BROWSER, path)).toBe(false);
    }
  });

  it("keeps the warning when another component triggers it", () => {
    const fromOther = `${REACT_VIRTUAL_FLUSH_SYNC_WARNING}\n    at FileBrowserPathBar (/x.tsx:1:1)`;
    expect(isSilencedConsoleMessage("error", fromOther, FB_TEST)).toBe(false);
    expect(isSilencedConsoleMessage("error", REACT_VIRTUAL_FLUSH_SYNC_WARNING, FB_TEST)).toBe(
      false
    );
  });

  it("keeps every other message and method, even from FileBrowser tests", () => {
    const actWarning =
      "Warning: An update to FileBrowser inside a test was not wrapped in act(...)." +
      "\n    at FileBrowser (/repo/src/components/Sidebar/FileBrowser.tsx:1:1)";
    expect(isSilencedConsoleMessage("error", actWarning, FB_TEST)).toBe(false);
    expect(isSilencedConsoleMessage("warn", FLUSH_SYNC_FROM_FILE_BROWSER, FB_TEST)).toBe(false);
    expect(
      isSilencedConsoleMessage("error", `${FLUSH_SYNC_FROM_FILE_BROWSER} extra`, FB_TEST)
    ).toBe(true);
    expect(
      isSilencedConsoleMessage(
        "error",
        `${REACT_VIRTUAL_FLUSH_SYNC_WARNING} (suffix)\n    at FileBrowser (/x.tsx:1:1)`,
        FB_TEST
      )
    ).toBe(false);
  });
});

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
