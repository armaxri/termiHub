import { expect, it } from "vitest";
import { serviceDeleteEffect } from "./serviceDelete";

it.each([
  ["stopped", 2, "It is not running."],
  ["error", 0, "It is not running."],
  ["running", 0, "It is running. Deleting stops it."],
  ["running", 1, "It is running. Deleting stops it and breaks 1 open connection."],
  ["reconnecting", 2, "It is running. Deleting stops it and breaks 2 open connections."],
] as const)("deleting one that is %s with %i connections", (state, open, text) => {
  expect(serviceDeleteEffect(state, open)).toBe(text);
});

it("what may still run on an offline agent is not said to stop now", () => {
  expect(serviceDeleteEffect("notReachable", 1)).toContain("offline");
});
