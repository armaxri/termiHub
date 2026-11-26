import { describe, expect, it } from "vitest";
import { THIS_COMPUTER, type TunnelType } from "@/types/tunnel";
import type { HostChoice } from "@/utils/hostChoice";
import {
  bindField,
  bindOf,
  missingText,
  newTunnelType,
  openWarning,
  reachSentence,
  targetName,
  whoLabels,
} from "./tunnelForm";

const EDGE: HostChoice = { kind: "agent", agentId: "edge" };
const HERE = { host: THIS_COMPUTER, server: "Build Box" };
const THERE = { host: EDGE, agentName: "Edge box", server: "Build Box" };

function type(kind: TunnelType["type"], bind?: string): TunnelType {
  const made = newTunnelType(kind);
  return bind === undefined
    ? made
    : ({ ...made, config: { ...made.config, [bindField(made)]: bind } } as TunnelType);
}

describe("a new tunnel", () => {
  it.each(["local", "remote", "dynamic"] as const)("%s is open to nobody else (U-007)", (kind) => {
    expect(["127.0.0.1", "localhost"]).toContain(bindOf(type(kind)));
    expect(openWarning(type(kind), HERE)).toBeUndefined();
  });

  it("opens a remote tunnel's port on the server, the others where they run", () => {
    expect(bindField(type("remote"))).toBe("remoteHost");
    expect(bindField(type("local"))).toBe("localHost");
    expect(bindField(type("dynamic"))).toBe("localHost");
    expect(bindOf(type("remote", "1.2.3.4"))).toBe("1.2.3.4");
  });
});

describe("who can open it", () => {
  it("is said for the machine that opens the port", () => {
    expect(whoLabels(type("local"), HERE)).toEqual({
      here: "Only this computer",
      network: "Anyone on your network",
      address: "Anyone who reaches one address of this computer",
    });
    expect(whoLabels(type("dynamic"), THERE).here).toBe("Only that machine");
    expect(whoLabels(type("local"), { host: { kind: "unreadable" } }).here).toBe(
      "Only that machine"
    );
    expect(whoLabels(type("remote"), THERE)).toEqual({
      here: "Only Build Box itself",
      network: "Anyone who reaches Build Box",
      address: "Anyone who reaches one address of Build Box",
    });
    expect(whoLabels(type("remote"), { host: THIS_COMPUTER }).here).toBe(
      "Only the SSH server itself"
    );
  });
});

describe("the warning, whenever others can open it", () => {
  it.each([
    [type("local", "0.0.0.0"), HERE, "Anyone on your network can reach localhost:80 with it."],
    [
      type("local", "0.0.0.0"),
      THERE,
      "Anyone who reaches that machine can reach localhost:80 with it.",
    ],
    [type("local", "10.0.0.5"), HERE, "Anyone who reaches 10.0.0.5 can reach localhost:80"],
    [
      type("dynamic", "::"),
      HERE,
      "Anyone on your network can browse through Build Box with it. Nobody is asked",
    ],
    [
      type("remote", "0.0.0.0"),
      HERE,
      "Anyone who reaches Build Box can reach localhost:3000 from this computer, if the SSH server allows it (OpenSSH: GatewayPorts).",
    ],
    [
      type("remote", "0.0.0.0"),
      THERE,
      "Anyone who reaches Build Box can reach localhost:3000 from agent Edge box, if",
    ],
    [type("remote", "10.0.0.5"), HERE, "Anyone who reaches 10.0.0.5 can reach localhost:3000"],
  ])("%j, %j", (tunnelType, machines, text) => {
    expect(openWarning(tunnelType, machines)).toContain(text);
  });

  it.each(["127.0.0.1", "localhost", "::1", "127.0.0.2", ""])("not for %j", (bind) => {
    for (const kind of ["local", "remote", "dynamic"] as const) {
      expect(openWarning(type(kind, bind), HERE)).toBeUndefined();
    }
  });
});

describe("what it reaches", () => {
  it.each([
    [type("local"), HERE, "It reaches localhost:80 through Build Box."],
    [type("local"), { host: THIS_COMPUTER }, "It reaches localhost:80 through the SSH server."],
    [type("remote"), HERE, "It reaches localhost:3000 from this computer."],
    [type("remote"), THERE, "It reaches localhost:3000 from agent Edge box."],
    [
      type("dynamic"),
      HERE,
      "Set your browser's or system's proxy to SOCKS5, host localhost, port 1080. It then browses through Build Box.",
    ],
    [
      type("dynamic", "10.0.0.5"),
      HERE,
      "Set your browser's or system's proxy to SOCKS5, host 10.0.0.5, port 1080. It then browses through Build Box.",
    ],
  ])("%j", (tunnelType, machines, text) => {
    expect(reachSentence(tunnelType, machines)).toBe(text);
  });

  it("says what is not known yet", () => {
    const made = type("local");
    const open = { ...made, config: { ...made.config, remoteHost: " ", remotePort: "" } };
    expect(reachSentence(open as TunnelType, HERE)).toBe(
      "It reaches what you enter above, through Build Box."
    );
    const noPort = { ...made, config: { ...made.config, remoteHost: "db", remotePort: "" } };
    expect(reachSentence(noPort as TunnelType, HERE)).toBe(
      "It reaches what you enter above, through Build Box."
    );
    const dynamic = { type: "dynamic", config: { localHost: "", localPort: "" } } as TunnelType;
    expect(reachSentence(dynamic, HERE)).toContain("host ?, port ?");
  });

  it.each([
    ["db.internal", "db.internal"],
    [" db ", "db"],
    ["localhost", undefined],
    ["127.0.0.1", undefined],
    ["", undefined],
  ])("%j names a local tunnel %j (V-008)", (remoteHost, name) => {
    const made = type("local");
    const reaches = { ...made, config: { ...made.config, remoteHost } } as TunnelType;
    expect(targetName(reaches, HERE)).toBe(name);
  });
});

it("names the other kinds by what they are for (V-008)", () => {
  expect(targetName(type("remote"), HERE)).toBe("Port 3000 for Build Box");
  expect(targetName(type("dynamic"), HERE)).toBe("Browse through Build Box");
  expect(targetName(type("dynamic"), {})).toBeUndefined();
  const made = type("remote");
  const open = { ...made, config: { ...made.config, localPort: "" } } as TunnelType;
  expect(targetName(open, HERE)).toBeUndefined();
});

it("presets ports nobody is set to (V-002)", () => {
  const taken = new Set([8080, 8081, 1080]);
  const free = (port: number) => {
    let next = port;
    while (taken.has(next)) next += 1;
    return next;
  };
  expect(newTunnelType("local", free).config).toMatchObject({ localPort: 8082 });
  expect(newTunnelType("dynamic", free).config).toMatchObject({ localPort: 1081 });
  // The server's port is its own.
  expect(newTunnelType("remote", free).config).toMatchObject({ remotePort: 8080 });
});

describe("what Save still needs", () => {
  it.each(["local", "remote"] as const)("in the order of the form (%s)", (kind) => {
    const bind = bindField(type(kind));
    const target = kind === "local" ? "remoteHost" : "localHost";
    const errors = {
      name: "x",
      sshConnectionId: "x",
      [`tunnelType.config.${bind}`]: "x",
      [`tunnelType.config.${target}`]: "x",
      "tunnelType.config.remotePort": "x",
    };
    expect(missingText(type(kind), errors)).toBe(
      "Still needed: a host, the port, an SSH connection, who can open it, a name"
    );
    expect(missingText(type(kind), { [`tunnelType.config.${bind}`]: "x" })).toBe(
      "Still needed: who can open it"
    );
  });
});
