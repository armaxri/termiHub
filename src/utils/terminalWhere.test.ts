import { describe, expect, it } from "vitest";
import { terminalWhere } from "./terminalWhere";

describe("terminalWhere (A-035)", () => {
  it.each([
    ["local", {}, "this computer"],
    ["ssh", { host: "web-1", username: "arne", port: 22 }, "arne@web-1"],
    ["ssh", { host: "web-1", username: "arne", port: 2222 }, "arne@web-1:2222"],
    ["ssh", { host: "web-1" }, "web-1"],
    ["telnet", { host: "10.0.0.2", port: 22 }, "10.0.0.2:22"],
    ["serial", { port: "/dev/ttyUSB0" }, "/dev/ttyUSB0"],
    ["docker", {}, "docker"],
  ])("%s %j is %s", (connectionType, config, where) => {
    expect(terminalWhere({ connectionType, config: { type: connectionType, config } })).toBe(where);
  });
});
