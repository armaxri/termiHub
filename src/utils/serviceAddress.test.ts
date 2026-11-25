import { describe, expect, it } from "vitest";
import { isWideBind, serviceAddress, splitHostPort, type Listener } from "./serviceAddress";

const HERE: Listener = { on: "here", network: "192.168.1.20" };
const HERE_OFFLINE: Listener = { on: "here" };
const AGENT: Listener = { on: "there", name: "Edge box", host: "edge.example" };
const UNKNOWN: Listener = { on: "there", name: "Edge box" };

describe("serviceAddress (#6028)", () => {
  it.each<[string, Listener, string, string | undefined]>([
    // bind, who listens, what is copied, where it opens
    ["127.0.0.1", HERE, "localhost:80", undefined],
    ["localhost", HERE, "localhost:80", undefined],
    ["::1", HERE, "localhost:80", undefined],
    ["", HERE, "localhost:80", undefined],
    ["0.0.0.0", HERE, "192.168.1.20:80", undefined],
    ["::", HERE, "192.168.1.20:80", undefined],
    ["*", HERE, "192.168.1.20:80", undefined],
    ["0.0.0.0", HERE_OFFLINE, "localhost:80", undefined],
    ["192.168.1.7", HERE, "192.168.1.7:80", undefined],
    ["fe80::1", HERE, "[fe80::1]:80", undefined],
    ["[fe80::1]", HERE, "[fe80::1]:80", undefined],
    // On another machine, localhost is that machine's.
    ["127.0.0.1", AGENT, "localhost:80", "Edge box"],
    ["", AGENT, "localhost:80", "Edge box"],
    ["0.0.0.0", AGENT, "edge.example:80", undefined],
    ["0.0.0.0", UNKNOWN, "localhost:80", "Edge box"],
    ["10.0.0.4", AGENT, "10.0.0.4:80", undefined],
  ])("bound to %j on %o is %s", (bind, listener, copy, on) => {
    const address = serviceAddress(bind, 80, listener);
    expect(address?.copy).toBe(copy);
    expect(address?.on).toBe(on);
  });

  it("is never a wide bind address", () => {
    for (const bind of ["0.0.0.0", "::", "[::]", "*", " 0.0.0.0 "]) {
      expect(isWideBind(bind)).toBe(true);
      for (const listener of [HERE, HERE_OFFLINE, AGENT, UNKNOWN]) {
        const copy = serviceAddress(bind, 80, listener)?.copy ?? "";
        expect(copy).not.toMatch(/0\.0\.0\.0|\[?::\]?|\*/);
      }
    }
  });

  it("carries the scheme, and the machine it opens on beside it", () => {
    const address = serviceAddress("127.0.0.1", 8080, AGENT, "http://");
    expect(address).toEqual({
      copy: "http://localhost:8080",
      on: "Edge box",
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
