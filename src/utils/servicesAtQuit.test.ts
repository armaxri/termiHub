import { describe, expect, it } from "vitest";
import type { EmbeddedServerConfig, ServerState, ServerStatus } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import { servicesAtQuit, servicesAtQuitSentence } from "./servicesAtQuit";

const stats = (active: number) => ({
  bytesSent: 0,
  bytesReceived: 0,
  activeConnections: active,
  totalConnections: active,
});
const tunnel = (id: string, host?: object) =>
  ({ id, name: `T ${id}`, ...(host ? { host } : {}) }) as TunnelConfig;
const server = (id: string, host?: object) =>
  ({ id, name: `S ${id}`, ...(host ? { host } : {}) }) as EmbeddedServerConfig;
const tState = (status: TunnelStatus, active = 0) =>
  ({ status, stats: stats(active) }) as TunnelState;
const sState = (status: ServerStatus, active = 0) =>
  ({ status, stats: stats(active) }) as ServerState;
const EDGE = { kind: "agent", agentId: "edge" };
const AGENTS = [{ id: "edge", name: "Edge box" }] as never;

describe("what quitting stops (#6028, question 2)", () => {
  it("is not asked about while nothing is open", () => {
    expect(
      servicesAtQuit({
        tunnels: [tunnel("a")],
        tunnelStates: { a: tState("connected") },
        servers: [server("s")],
        serverStates: { s: sState("running") },
        agents: [],
      })
    ).toEqual([]);
  });

  it("lists every service that runs once one has a connection open, on agents too", () => {
    const rows = servicesAtQuit({
      tunnels: [
        tunnel("a"),
        tunnel("off"),
        tunnel("far", EDGE),
        tunnel("lost", { kind: "agent", agentId: "x" }),
      ],
      tunnelStates: {
        a: tState("connected", 2),
        off: tState("disconnected", 3),
        far: tState("reconnecting"),
        lost: tState("connected"),
      },
      servers: [server("s"), server("t")],
      serverStates: { s: sState("running", 1), t: sState("error") },
      agents: AGENTS,
    });
    expect(rows).toEqual([
      { key: "a", name: "T a", open: 2 },
      { key: "far", name: "T far", open: 0, agent: "Edge box" },
      { key: "lost", name: "T lost", open: 0, agent: "x" },
      { key: "s", name: "S s", open: 1 },
    ]);
    expect(servicesAtQuitSentence(rows)).toBe("4 services stop, 3 connections are open.");
    expect(servicesAtQuitSentence([rows[3]])).toBe("1 service stops, 1 connection is open.");
  });
});
