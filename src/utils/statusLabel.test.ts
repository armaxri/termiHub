import { describe, it, expect } from "vitest";
import { connectionStateLabel, persistentRunStateLabel, serverStatusLabel } from "./statusLabel";

describe("statusLabel", () => {
  describe("connectionStateLabel (agents + tunnels)", () => {
    it.each([
      ["connected", "Connected"],
      ["connecting", "Connecting"],
      ["reconnecting", "Reconnecting"],
      ["disconnected", "Disconnected"],
      ["error", "Error"],
    ])("maps %s to a distinct non-colour label", (state, label) => {
      expect(connectionStateLabel(state)).toBe(label);
    });

    it("falls back to the raw value for an unknown state", () => {
      expect(connectionStateLabel("mystery")).toBe("mystery");
    });

    // SM-020 slice 4 behavior-preservation lock: the backend unified the agent's
    // connection-status enum onto the canonical `SessionStatus`, but the four
    // states the agent emits serialise to these exact wire strings, so the badge
    // label for every agent state stays byte-identical.
    it.each([
      ["disconnected", "Disconnected"],
      ["connecting", "Connecting"],
      ["connected", "Connected"],
      ["reconnecting", "Reconnecting"],
    ])("renders the unchanged badge label for canonical agent state %s", (state, label) => {
      expect(connectionStateLabel(state)).toBe(label);
    });
  });

  describe("persistentRunStateLabel", () => {
    it.each([
      ["stopped", "Stopped"],
      ["starting", "Starting"],
      ["running", "Running"],
      ["attached", "Attached"],
      ["stopping", "Stopping"],
      ["error", "Error"],
    ] as const)("maps %s to a distinct non-colour label", (state, label) => {
      expect(persistentRunStateLabel(state)).toBe(label);
    });

    it("reports a never-started (null) session as Stopped", () => {
      expect(persistentRunStateLabel(null)).toBe("Stopped");
    });
  });

  describe("serverStatusLabel", () => {
    it.each([
      ["stopped", "Stopped"],
      ["starting", "Starting"],
      ["running", "Running"],
      ["stopping", "Stopping"],
      ["error", "Error"],
    ] as const)("maps %s to a distinct non-colour label", (status, label) => {
      expect(serverStatusLabel(status)).toBe(label);
    });

    it("reports a never-started (undefined) server as Stopped", () => {
      expect(serverStatusLabel(undefined)).toBe("Stopped");
    });
  });
});
