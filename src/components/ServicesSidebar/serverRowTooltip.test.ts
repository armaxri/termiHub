import { describe, it, expect } from "vitest";
import { serverRowTooltip, serverUrl } from "./serverRowTooltip";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";

const HTTP: EmbeddedServerConfig = {
  id: "srv-1",
  name: "Firmware share",
  serverType: "http",
  rootDirectory: "/srv/fw",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: false,
};

describe("serverRowTooltip (#5770)", () => {
  it("lists the protocol, address and folder", () => {
    expect(serverRowTooltip(HTTP)).toEqual([
      "HTTP · http://localhost:8080",
      "Share a folder that others open in a web browser.",
      "Serves /srv/fw",
    ]);
  });

  it("adds read only, the agent host and the traffic", () => {
    const lines = serverRowTooltip(
      { ...HTTP, serverType: "tftp", readOnly: true, port: 69 },
      {
        runsOn: "Runs on agent build-box",
        stats: { activeConnections: 2, totalConnections: 5, bytesSent: 2048, bytesReceived: 0 },
      }
    );
    expect(lines).toEqual([
      "TFTP · tftp://localhost:69",
      "Give files to devices that only speak TFTP.",
      "Serves /srv/fw",
      "Read only",
      "Runs on agent build-box",
      "2 connections now, 5 in all · sent 2.0 KB · received 0 B",
    ]);
  });

  it("builds the URL from the protocol", () => {
    expect(serverUrl({ ...HTTP, serverType: "ftp", port: 21 })).toBe("ftp://127.0.0.1:21");
  });
});
