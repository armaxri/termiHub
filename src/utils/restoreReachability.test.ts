import { describe, it, expect, vi } from "vitest";
import { probeRestoreTargets, type ReachabilityProbe } from "./restoreReachability";
import type { RestoreTabTarget } from "./restoreMode";

function probe(overrides: Partial<ReachabilityProbe> = {}): ReachabilityProbe {
  return {
    listSerialPorts: vi.fn(() => Promise.resolve<string[]>([])),
    probeHost: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

describe("probeRestoreTargets", () => {
  it("flags a serial device that is not currently present as offline", async () => {
    const targets: RestoreTabTarget[] = [
      { kind: "serial", device: "/dev/ttyUSB0" },
      { kind: "serial", device: "/dev/ttyUSB1" },
    ];
    const results = await probeRestoreTargets(
      targets,
      probe({ listSerialPorts: () => Promise.resolve(["/dev/ttyUSB1"]) })
    );
    expect(results[0]).toEqual({ reachability: "unreachable", reason: "device offline" });
    expect(results[1]).toEqual({ reachability: "reachable" });
  });

  it("lists serial ports only once regardless of how many serial targets", async () => {
    const listSerialPorts = vi.fn(() => Promise.resolve(["/dev/a"]));
    await probeRestoreTargets(
      [
        { kind: "serial", device: "/dev/a" },
        { kind: "serial", device: "/dev/b" },
      ],
      probe({ listSerialPorts })
    );
    expect(listSerialPorts).toHaveBeenCalledTimes(1);
  });

  it("marks a reachable host reachable and an unreachable host unreachable", async () => {
    const probeHost = vi.fn((host: string) => Promise.resolve(host === "up"));
    const results = await probeRestoreTargets(
      [
        { kind: "host", host: "up", port: 22 },
        { kind: "host", host: "down", port: 22 },
      ],
      probe({ probeHost })
    );
    expect(results[0]).toEqual({ reachability: "reachable" });
    expect(results[1]).toEqual({ reachability: "unreachable", reason: "host unreachable" });
  });

  it("degrades to unknown when a host probe throws", async () => {
    const results = await probeRestoreTargets(
      [{ kind: "host", host: "boom", port: 22 }],
      probe({ probeHost: () => Promise.reject(new Error("nope")) })
    );
    expect(results[0]).toEqual({ reachability: "unknown" });
  });

  it("degrades serial targets to unknown when listing serial ports fails", async () => {
    const results = await probeRestoreTargets(
      [{ kind: "serial", device: "/dev/x" }],
      probe({ listSerialPorts: () => Promise.reject(new Error("no ports")) })
    );
    expect(results[0]).toEqual({ reachability: "unknown" });
  });

  it("does not network-probe local or agent targets", async () => {
    const probeHost = vi.fn(() => Promise.resolve(true));
    const listSerialPorts = vi.fn(() => Promise.resolve([]));
    const results = await probeRestoreTargets(
      [{ kind: "local" }, { kind: "agent", agentId: "a1" }],
      probe({ probeHost, listSerialPorts })
    );
    expect(results).toEqual([{ reachability: "unknown" }, { reachability: "unknown" }]);
    expect(probeHost).not.toHaveBeenCalled();
    expect(listSerialPorts).not.toHaveBeenCalled();
  });
});
