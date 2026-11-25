import { describe, expect, it } from "vitest";
import { ownAddresses, whoOf } from "./bindWho";

describe("who can open it", () => {
  it.each([
    ["", undefined],
    ["127.0.0.1", "here"],
    ["localhost", "here"],
    ["::1", "here"],
    ["0.0.0.0", "network"],
    ["::", "network"],
    ["192.168.1.20", "address"],
  ])("%j is %s", (bind, who) => {
    expect(whoOf(bind)).toBe(who);
  });

  it("offers the addresses that others may reach, and the saved one", () => {
    const interfaces = [
      { name: "Loopback", addr: "127.0.0.1" },
      { name: "All interfaces", addr: "0.0.0.0" },
      { name: "en0", addr: "192.168.1.20" },
    ];
    const en0 = { value: "192.168.1.20", label: "192.168.1.20 (en0)" };
    expect(ownAddresses(interfaces, "0.0.0.0")).toEqual([en0]);
    expect(ownAddresses(interfaces, "192.168.1.20")).toEqual([en0]);
    expect(ownAddresses(interfaces, "10.0.0.9")).toEqual([
      en0,
      { value: "10.0.0.9", label: "10.0.0.9" },
    ]);
  });
});
