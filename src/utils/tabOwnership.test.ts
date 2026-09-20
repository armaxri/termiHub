import { describe, it, expect } from "vitest";
import { resolveControllingWindow } from "./tabOwnership";

describe("resolveControllingWindow (#2872)", () => {
  const base = {
    sessionId: "sess-1",
    sessionOwners: { "sess-1": "win-2" },
    windowLabel: "main",
    multiWindow: true,
  };

  it("returns the controlling window when another window owns the session", () => {
    expect(resolveControllingWindow(base)).toEqual({ label: "win-2", name: "Window 2" });
  });

  it("returns null when this window owns the session", () => {
    expect(resolveControllingWindow({ ...base, sessionOwners: { "sess-1": "main" } })).toBeNull();
  });

  it("returns null when the session is unclaimed (not in the ownership map)", () => {
    expect(resolveControllingWindow({ ...base, sessionOwners: {} })).toBeNull();
  });

  it("returns null in single-window mode even when a foreign owner is recorded", () => {
    expect(resolveControllingWindow({ ...base, multiWindow: false })).toBeNull();
  });

  it("returns null for a tab with no session id", () => {
    expect(resolveControllingWindow({ ...base, sessionId: null })).toBeNull();
    expect(resolveControllingWindow({ ...base, sessionId: undefined })).toBeNull();
  });

  it("names the main window", () => {
    expect(
      resolveControllingWindow({
        ...base,
        sessionOwners: { "sess-1": "main" },
        windowLabel: "win-3",
      })
    ).toEqual({ label: "main", name: "Main Window" });
  });
});
