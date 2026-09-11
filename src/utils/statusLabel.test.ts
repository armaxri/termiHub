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
