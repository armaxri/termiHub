import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LogEntry } from "@/types/terminal";
import { clearFrontendLogHistory, onFrontendLog } from "@/utils/frontendLog";
import { withLoggedFallback } from "./loggedFallback";

describe("withLoggedFallback (#4520)", () => {
  let entries: LogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    clearFrontendLogHistory();
    entries = [];
    unsubscribe = onFrontendLog((e) => entries.push(e));
  });

  afterEach(() => unsubscribe());

  it("resolves the value and logs nothing when the promise fulfils", async () => {
    await expect(withLoggedFallback(Promise.resolve(7), null, "t", "read x")).resolves.toBe(7);
    expect(entries).toEqual([]);
  });

  it("resolves the fallback and logs a WARN naming the failure on rejection", async () => {
    const result = await withLoggedFallback(
      Promise.reject(new Error("ipc down")),
      null,
      "open_connections",
      "read X server status"
    );
    expect(result).toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("WARN");
    expect(entries[0].target).toContain("open_connections");
    expect(entries[0].message).toBe("Failed to read X server status: ipc down");
  });

  it("renders a structured IPC error by its message, not [object Object]", async () => {
    await withLoggedFallback(
      Promise.reject({ code: "E", message: "store locked" }),
      [],
      "t",
      "list things"
    );
    expect(entries[0].message).toBe("Failed to list things: store locked");
  });

  it("logs at DEBUG when asked, for expected probe failures", async () => {
    const result = await withLoggedFallback(
      Promise.reject(new Error("no")),
      false,
      "t",
      "probe",
      "debug"
    );
    expect(result).toBe(false);
    expect(entries[0].level).toBe("DEBUG");
  });
});
