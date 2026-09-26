import { describe, it, expect } from "vitest";
import { sessionBoundDefinition } from "./sessionBoundDefinition";

describe("sessionBoundDefinition (#3369)", () => {
  it("scopes the definition id to the session and keeps it persistent", () => {
    const def = sessionBoundDefinition({ sessionId: "abc-123", title: "Build", type: "serial" });
    expect(def).toEqual({
      id: "session:abc-123",
      name: "Build",
      sessionType: "serial",
      config: {},
      persistent: true,
      folderId: null,
    });
  });

  it("maps the agent's local type to shell and names untitled sessions", () => {
    const def = sessionBoundDefinition({ sessionId: "0123456789", title: "", type: "local" });
    expect(def.sessionType).toBe("shell");
    expect(def.name).toBe("Session 01234567");
  });
});
