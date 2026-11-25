import { describe, expect, it } from "vitest";
import { localhostIn, serviceTrafficLine } from "./serviceTraffic";

describe("the lines both kinds of service share in their tooltip (#6068)", () => {
  it("count what is open now and what was", () => {
    const stats = { bytesSent: 2048, bytesReceived: 0, totalConnections: 3 };
    expect(serviceTrafficLine({ ...stats, activeConnections: 1 })).toBe(
      "1 connection now, 3 in all · sent 2.0 KB · received 0 B"
    );
    expect(serviceTrafficLine({ ...stats, activeConnections: 0 }, 1024, null)).toBe(
      "0 connections now, 3 in all · sent 2.0 KB (1 KB/s) · received 0 B"
    );
  });

  it("say localhost, and only for it", () => {
    expect(localhostIn("127.0.0.1:80 → db:5432")).toBe("localhost:80 → db:5432");
    expect(localhostIn("http://127.0.0.1:8080")).toBe("http://localhost:8080");
    for (const other of ["0.0.0.0:80", "127.0.0.10:80", "1127.0.0.1:80", "2.127.0.0.1"]) {
      expect(localhostIn(other)).toBe(other);
    }
  });
});
