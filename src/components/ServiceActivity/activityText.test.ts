import { describe, expect, it } from "vitest";
import type { SavedConnection } from "@/types/connection";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelType } from "@/types/tunnel";
import { formatClockTime } from "@/utils/formatters";
import { fileServerModel, tunnelModel, type ServiceContext } from "@/utils/serviceModel";
import {
  ACTIVITY_ACTIONS,
  counters,
  eventLines,
  eventState,
  eventsNote,
  howToUse,
  sinceOf,
} from "./activityText";

const CONTEXT: ServiceContext = {
  agents: [{ id: "edge", name: "Edge box", config: { host: "edge.example" } as never }],
  connections: [
    {
      id: "shop",
      name: "shop-web",
      config: { type: "ssh", config: { host: "shop.example" } },
    } as unknown as SavedConnection,
  ],
};
const STATS = { bytesSent: 2048, bytesReceived: 10, activeConnections: 2, totalConnections: 7 };
const LOCAL: TunnelType = {
  type: "local",
  config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
};
const tunnel = (
  tunnelType: TunnelType = LOCAL,
  over: Partial<TunnelConfig> = {}
): TunnelConfig => ({
  id: "t",
  name: "Shop database",
  sshConnectionId: "shop",
  tunnelType,
  autoStart: false,
  reconnectOnDisconnect: false,
  ...over,
});
const server = (over: Partial<EmbeddedServerConfig> = {}): EmbeddedServerConfig => ({
  id: "s",
  name: "Docs",
  serverType: "http",
  rootDirectory: "/srv",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
  ...over,
});
const running = tunnelModel(
  tunnel(),
  { tunnelId: "t", status: "connected", stats: STATS },
  CONTEXT
);
const stopped = tunnelModel(tunnel(), undefined, CONTEXT);

describe("what happened (#6028, slice 9)", () => {
  it("names each state as the row does, the newest first, with why", () => {
    const lines = eventLines("tunnel", [
      { atMs: 1000, status: "connecting" },
      { atMs: 2000, status: "error", reason: "Build box refused the sign-in." },
      { atMs: 3000, status: "reconnecting" },
    ]);
    expect(lines.map(({ label, reason }) => [label, reason])).toEqual([
      ["Reconnecting", undefined],
      ["Error", "Build box refused the sign-in."],
      ["Starting", undefined],
    ]);
    expect(lines[2].time).toBe(formatClockTime(1000));
    expect(lines[1].dot.tone).toBe("error");
    expect(new Set(lines.map(({ key }) => key)).size).toBe(3);
  });

  it("reads both kinds' words, and an unknown one as stopped", () => {
    expect(eventState("tunnel", "connected")).toBe("running");
    expect(eventState("fileServer", "running")).toBe("running");
    expect(eventState("tunnel", "missingConnection")).toBe("needsConnection");
    expect(eventState("fileServer", "notReachable")).toBe("notReachable");
    expect(eventState("tunnel", "something new")).toBe("stopped");
  });

  it("says since when, only when the last event is the state now", () => {
    expect(sinceOf(running, [{ atMs: 5000, status: "connected" }])).toBe(
      `Since ${formatClockTime(5000)}`
    );
    expect(sinceOf(running, [{ atMs: 5000, status: "connecting" }])).toBeUndefined();
    expect(sinceOf(running, [])).toBeUndefined();
  });

  it("says where the events come from", () => {
    expect(eventsNote(running)).toContain("Since termiHub started, the last 200.");
    const there = tunnelModel(
      tunnel(LOCAL, { host: { kind: "agent", agentId: "edge" } }),
      undefined,
      CONTEXT
    );
    expect(eventsNote(there)).toContain("What this computer saw");
  });
});

describe("how to use it, per type", () => {
  it("one line for each, only while there is an address", () => {
    expect(howToUse(running)).toContain("Point your program at this address");
    expect(howToUse(stopped)).toBeUndefined();
    const of = (tunnelType: TunnelType) =>
      howToUse(
        tunnelModel(
          tunnel(tunnelType),
          { tunnelId: "t", status: "connected", stats: STATS },
          CONTEXT
        )
      );
    expect(of({ type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } })).toContain(
      "SOCKS5 proxy"
    );
    expect(
      of({
        type: "remote",
        config: {
          remoteHost: "localhost",
          remotePort: 9000,
          localHost: "localhost",
          localPort: 3000,
        },
      })
    ).toContain("Programs on the server");
    const files = (serverType: EmbeddedServerConfig["serverType"]) =>
      howToUse(
        fileServerModel(
          server({ serverType }),
          { serverId: "s", status: "running", stats: STATS },
          CONTEXT
        )
      );
    expect(files("http")).toContain("in a browser");
    expect(files("ftp")).toContain("FTP program");
    expect(files("tftp")).toContain("TFTP client");
  });

  it("follows where the address can be reached, never 'here' for another machine (#6117, F-003)", () => {
    const web = (address: Parameters<typeof howToUse>[0]["address"]) =>
      howToUse({ type: "http", address });
    expect(web({ copy: "http://localhost:8080", open: false, reach: "" })).toBe(
      "Open it in a browser on this computer."
    );
    expect(web({ copy: "http://192.168.1.20:8080", open: true, reach: "" })).toBe(
      "Open it in a browser on any device on your network."
    );
    const there = web({
      copy: "http://localhost:8080",
      on: "Raspberry Pi",
      open: false,
      reach: "",
    });
    expect(there).toBe("It works only on Raspberry Pi: open it in a browser there, not here.");
    expect(
      howToUse({
        type: "local",
        address: { copy: "localhost:5432", on: "Build Box", open: false, reach: "" },
      })
    ).toContain("It works only on Build Box");
    expect(
      howToUse({
        type: "tftp",
        address: { copy: "tftp://localhost:6969", on: "Build Box", open: false, reach: "" },
      })
    ).toContain("TFTP client");
  });
});

describe("the four counters", () => {
  it("connections now and in all, sent and received", () => {
    expect(counters(running)).toEqual([
      { id: "now", label: "Connected now", value: "2" },
      { id: "total", label: "Connections in all", value: "7" },
      { id: "sent", label: "Sent", value: "2.0 KB" },
      { id: "received", label: "Received", value: "10 B" },
    ]);
  });

  it("zero while it does not run", () => {
    expect(counters(stopped).map(({ value }) => value)).toEqual(["0", "0", "0 B", "0 B"]);
  });
});

it("Activity offers what runs it and its address, not what the row and Settings do", () => {
  expect([...ACTIVITY_ACTIONS].sort()).toEqual(
    ["copyAddress", "openInBrowser", "restart", "retry", "start", "stop", "stopWaiting"].sort()
  );
});
