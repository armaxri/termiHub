/**
 * Transport-specific drop wording (#5619, #5660): serial never mentions an
 * agent or a shell, a dropped link is never "[Process exited]", and a real
 * process exit still is.
 */
import { describe, it, expect } from "vitest";
import {
  dropTransportOf,
  formatClock,
  reconnectDetailFor,
  reconnectHeadingFor,
  reconnectStatusFor,
  reconnectedMarker,
  sessionEndSeparator,
} from "./dropCopy";

const AT = new Date(2026, 10, 13, 9, 5, 7);

describe("dropTransportOf", () => {
  it("classifies direct, agent and unknown connections", () => {
    expect(dropTransportOf({ sessionType: "serial", viaAgent: false })).toBe("serial");
    expect(dropTransportOf({ sessionType: "ssh", viaAgent: false })).toBe("ssh");
    expect(dropTransportOf({ sessionType: "telnet", viaAgent: false })).toBe("telnet");
    expect(dropTransportOf({ sessionType: "serial", viaAgent: true })).toBe("agent");
    expect(dropTransportOf({ sessionType: "local", viaAgent: false })).toBe("other");
    expect(dropTransportOf(undefined)).toBe("other");
  });
});

describe("reconnect strip copy", () => {
  it("never mentions an agent or a shell for a serial device", () => {
    const text = [
      reconnectHeadingFor("serial"),
      reconnectStatusFor("serial"),
      reconnectDetailFor("serial", "/dev/ttyUSB0"),
      reconnectDetailFor("serial"),
    ].join(" ");
    expect(text).not.toMatch(/agent|shell/i);
    expect(text).toContain("Device disconnected");
    expect(reconnectDetailFor("serial", "/dev/ttyUSB0")).toContain("/dev/ttyUSB0");
  });

  it("names the termiHub remote agent, never a bare 'agent', for SSH", () => {
    expect(reconnectDetailFor("ssh")).toBe(
      "Scrollback is kept. Your remote shell restarts; running programs are lost."
    );
    expect(reconnectDetailFor("ssh")).not.toMatch(/agent/i);
    expect(reconnectDetailFor("agent")).toContain("termiHub remote agent");
  });

  it("says the telnet connection was closed", () => {
    expect(reconnectHeadingFor("telnet")).toBe("Connection closed — reconnecting…");
    expect(reconnectDetailFor("telnet")).not.toMatch(/agent/i);
  });

  it("keeps the shared heading for SSH and agent drops", () => {
    expect(reconnectHeadingFor("ssh")).toBe("Connection lost — reconnecting…");
    expect(reconnectHeadingFor("agent")).toBe("Connection lost — reconnecting…");
  });
});

describe("scrollback separators", () => {
  it("formats the time as hh:mm:ss", () => {
    expect(formatClock(AT)).toBe("09:05:07");
  });

  it("writes a connection-lost line for a dropped network link", () => {
    for (const transport of ["ssh", "telnet", "agent"] as const) {
      expect(sessionEndSeparator({ transport, exitCode: null, reason: "dropped", at: AT })).toBe(
        "— connection lost 09:05:07 —"
      );
    }
  });

  it("writes a closed-by-server line when an SSH / Telnet server closed the link (#5696)", () => {
    for (const transport of ["ssh", "telnet"] as const) {
      expect(
        sessionEndSeparator({
          transport,
          exitCode: null,
          reason: "dropped",
          at: AT,
          endCause: "remote_closed",
        })
      ).toBe("— connection closed by server 09:05:07 —");
    }
  });

  it("keeps connection lost for an I/O error, a timeout or an unknown cause (#5696)", () => {
    for (const endCause of ["io_error", "timeout", null] as const) {
      expect(
        sessionEndSeparator({
          transport: "telnet",
          exitCode: null,
          reason: "dropped",
          at: AT,
          endCause,
        })
      ).toBe("— connection lost 09:05:07 —");
    }
  });

  it("does not let a remote close reword an agent drop or a serial unplug (#5696)", () => {
    const at = AT;
    expect(
      sessionEndSeparator({
        transport: "agent",
        exitCode: null,
        reason: "dropped",
        at,
        endCause: "remote_closed",
      })
    ).toBe("— connection lost 09:05:07 —");
    expect(
      sessionEndSeparator({
        transport: "serial",
        exitCode: null,
        reason: "dropped",
        at,
        endCause: "remote_closed",
      })
    ).toBe("— device disconnected 09:05:07 —");
  });

  it("writes a device-disconnected line for an unplugged serial device", () => {
    expect(
      sessionEndSeparator({ transport: "serial", exitCode: null, reason: "dropped", at: AT })
    ).toBe("— device disconnected 09:05:07 —");
  });

  it("keeps [Process exited] for real process exits", () => {
    expect(
      sessionEndSeparator({ transport: "other", exitCode: null, reason: "dropped", at: AT })
    ).toBe("[Process exited]");
    expect(sessionEndSeparator({ transport: "ssh", exitCode: 0, reason: "clean", at: AT })).toBe(
      "[Process exited with code 0]"
    );
    expect(sessionEndSeparator({ transport: "ssh", exitCode: 2, reason: "dropped", at: AT })).toBe(
      "[Process exited with code 2]"
    );
  });

  it("marks a reconnect with the time", () => {
    expect(reconnectedMarker(AT)).toBe("— reconnected 09:05:07 —");
  });
});
