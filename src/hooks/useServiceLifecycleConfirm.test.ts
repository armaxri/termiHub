import { describe, it, expect } from "vitest";
import { cutOffText } from "./useServiceLifecycleConfirm";

/**
 * #6117 (F-002): a stop says who it cuts off, by service, and never calls them
 * "connections", the word for the saved SSH connections.
 */
describe("cutOffText", () => {
  it("says who one stop or restart cuts off", () => {
    expect(cutOffText("stop", 1, [])).toBe(
      "Someone is connected to it now. Stopping cuts them off."
    );
    expect(cutOffText("stop", 3, [])).toBe(
      "3 are connected to it now. Stopping cuts them all off."
    );
    expect(cutOffText("restart", 2, [])).toContain("they can connect again");
  });

  it("names every service in use for Stop all", () => {
    expect(
      cutOffText("stopAll", 3, [
        { name: "Release builds", count: 1 },
        { name: "Shop database", count: 2 },
      ])
    ).toBe(
      "Release builds (1 connected), Shop database (2 connected) are in use. Stopping cuts off everyone connected."
    );
  });

  it("never says connections", () => {
    for (const text of [
      cutOffText("stop", 1, []),
      cutOffText("stop", 4, []),
      cutOffText("stopAll", 1, [{ name: "a", count: 1 }]),
    ]) {
      expect(text).not.toMatch(/connections/);
    }
  });
});
