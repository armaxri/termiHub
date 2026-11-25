import { describe, expect, it } from "vitest";
import { isWideBind, serviceAddress, splitHostPort, type Listener } from "./serviceAddress";

const HERE: Listener = { on: "here", network: "192.168.1.20" };
const OFFLINE: Listener = { on: "here" };
const AGENT: Listener = { on: "there", name: "Edge box", host: "edge.example", shown: true };
const NO_NETWORK =
  "Open to your network. This computer has no network address now; it appears here once you are connected. Port 80.";
const SERVER: Listener = { on: "there", name: "Build Box", host: "build.example" };

describe("serviceAddress (#6028)", () => {
  it.each<[string, Listener, string | undefined, string | undefined, string]>([
    // bind, who listens, what is copied, where it opens, who reaches it
    ["127.0.0.1", HERE, "localhost:80", undefined, "only this computer"],
    ["localhost", HERE, "localhost:80", undefined, "only this computer"],
    ["::1", HERE, "localhost:80", undefined, "only this computer"],
    ["", HERE, "localhost:80", undefined, "only this computer"],
    ["127.0.0.2", HERE, "127.0.0.2:80", undefined, "only this computer"],
    ["0.0.0.0", HERE, "192.168.1.20:80", undefined, "anyone on your network"],
    ["::", HERE, "192.168.1.20:80", undefined, "anyone on your network"],
    ["*", HERE, "192.168.1.20:80", undefined, "anyone on your network"],
    ["192.168.1.7", HERE, "192.168.1.7:80", undefined, "anyone who reaches 192.168.1.7"],
    ["fe80::1", HERE, "[fe80::1]:80", undefined, "anyone who reaches fe80::1"],
    ["[fe80::1]", HERE, "[fe80::1]:80", undefined, "anyone who reaches [fe80::1]"],
    // Bound to one address: who reaches that one (V-010).
    // Open to others, and nobody knows how: never a localhost.
    ["0.0.0.0", OFFLINE, undefined, undefined, NO_NETWORK],
    ["::", OFFLINE, undefined, undefined, NO_NETWORK],
    // On another machine, localhost is that machine's.
    ["127.0.0.1", SERVER, "localhost:80", "Build Box", "only on Build Box"],
    ["", SERVER, "localhost:80", "Build Box", "only on Build Box"],
    ["0.0.0.0", SERVER, "build.example:80", undefined, "anyone who reaches Build Box"],
    ["10.0.0.4", SERVER, "10.0.0.4:80", undefined, "anyone who reaches 10.0.0.4"],
    // The row names its agent anyway.
    ["127.0.0.1", AGENT, "localhost:80", "Edge box", "only on that machine"],
    ["0.0.0.0", AGENT, "edge.example:80", undefined, "anyone who reaches that machine"],
    ["10.0.0.4", AGENT, "10.0.0.4:80", undefined, "anyone who reaches 10.0.0.4"],
    [
      "0.0.0.0",
      { ...SERVER, host: undefined },
      undefined,
      undefined,
      "Open to Build Box's network. Its address is not known. Port 80.",
    ],
    [
      "0.0.0.0",
      { ...AGENT, host: undefined },
      undefined,
      undefined,
      "Open to that machine's network. Its address is not known. Port 80.",
    ],
  ])("bound to %j on %o is %s", (bind, listener, copy, on, reach) => {
    const address = serviceAddress(bind, 80, listener)!;
    expect(address.copy).toBe(copy);
    expect(address.on).toBe(on);
    expect(address.reach).toBe(reach);
    expect(address.open).toBe(!reach.startsWith("only"));
  });

  it("is never a wide bind address", () => {
    for (const bind of ["0.0.0.0", "::", "[::]", "*", " 0.0.0.0 "]) {
      expect(isWideBind(bind)).toBe(true);
      for (const listener of [HERE, OFFLINE, AGENT, SERVER]) {
        const copy = serviceAddress(bind, 80, listener)?.copy ?? "";
        expect(copy).not.toMatch(/0\.0\.0\.0|\[?::\]?|\*/);
        // And never one that is the reader's own machine.
        expect(copy).not.toContain("localhost");
      }
    }
  });

  it("carries the scheme, and the machine it opens on beside it", () => {
    expect(serviceAddress("127.0.0.1", 8080, AGENT, "http://")).toEqual({
      copy: "http://localhost:8080",
      on: "Edge box",
      open: false,
      reach: "only on that machine",
    });
  });

  it.each<[number | ""]>([[""], [0], [-1]])("there is none without a port (%s)", (port) => {
    expect(serviceAddress("127.0.0.1", port, HERE)).toBeUndefined();
  });
});

describe("splitHostPort", () => {
  it.each([
    ["127.0.0.1:5432", { host: "127.0.0.1", port: 5432 }],
    ["[::1]:80", { host: "[::1]", port: 80 }],
    ["", undefined],
    [":80", undefined],
    ["host", undefined],
    ["host:0", undefined],
    ["host:x", undefined],
  ])("%s", (text, expected) => {
    expect(splitHostPort(text)).toEqual(expected);
  });
});
