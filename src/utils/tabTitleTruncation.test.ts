import { describe, it, expect } from "vitest";
import {
  splitTabTitle,
  tabSerialPort,
  tabTooltipTitle,
  TAB_TITLE_TAIL_CHARS,
} from "./tabTitleTruncation";

describe("splitTabTitle (#5827)", () => {
  it("keeps the unique end of an id-like name in the tail", () => {
    expect(splitTabTitle("sys-pr-telnet-0d8db725")).toEqual({
      head: "sys-pr-telnet-",
      tail: "0d8db725",
    });
  });

  it("keeps the duplicate counter in the tail, after the end of the name", () => {
    expect(splitTabTitle("sys-pr-ssh-dup-0d8db725 (2)")).toEqual({
      head: "sys-pr-ssh-dup-",
      tail: "0d8db725 (2)",
    });
  });

  it("moves only the counter of a short name into the tail", () => {
    expect(splitTabTitle("web (12)")).toEqual({ head: "web", tail: " (12)" });
  });

  it("does not split a short name", () => {
    expect(splitTabTitle("Lab switch")).toEqual({ head: "Lab switch", tail: "" });
    expect(splitTabTitle("")).toEqual({ head: "", tail: "" });
  });

  it("does not treat a parenthesised word as a counter", () => {
    const { tail } = splitTabTitle("Startup question (zsh)");
    expect(tail).toBe("on (zsh)");
    expect(tail).toHaveLength(TAB_TITLE_TAIL_CHARS);
  });

  it("never cuts a surrogate pair in half", () => {
    const title = "release-dashboard-🚀🚀🚀🚀🚀🚀🚀🚀";
    const { head, tail } = splitTabTitle(title);
    expect(head + tail).toBe(title);
    expect(Array.from(tail)).toHaveLength(TAB_TITLE_TAIL_CHARS);
    expect(tail).toBe("🚀".repeat(8));
  });

  it("keeps an agent tab's whole name in the head and its shell suffix in the tail (#5956)", () => {
    expect(splitTabTitle("sys-pr-agent-8829f19f · bash")).toEqual({
      head: "sys-pr-agent-8829f19f",
      tail: " · bash",
    });
    expect(splitTabTitle("pi · zsh (2)")).toEqual({ head: "pi", tail: " · zsh (2)" });
    expect(splitTabTitle("build-host · WSL: Ubuntu")).toEqual({
      head: "build-host",
      tail: " · WSL: Ubuntu",
    });
  });

  it("does not treat long text after a middle dot as a shell suffix", () => {
    const title = "release notes · draft for the quarterly review";
    const { head, tail } = splitTabTitle(title);
    expect(tail).toHaveLength(TAB_TITLE_TAIL_CHARS);
    expect(head + tail).toBe(title);
  });

  it("always rejoins to the full title", () => {
    for (const title of [
      "a",
      "Production database replica 12",
      "x".repeat(40) + " (3)",
      "agent-1 · bash (4)",
    ]) {
      const { head, tail } = splitTabTitle(title);
      expect(head + tail).toBe(title);
    }
  });
});

describe("tabSerialPort / tabTooltipTitle (#5827)", () => {
  it("reads the port of a direct and an agent serial session", () => {
    expect(tabSerialPort({ type: "serial", config: { port: "/dev/ttyUSB0" } })).toBe(
      "/dev/ttyUSB0"
    );
    expect(
      tabSerialPort({
        type: "remote-session",
        config: { sessionType: "serial", port: "COM3", agentId: "a1" },
      })
    ).toBe("COM3");
  });

  it("has no port for other sessions or a blank port", () => {
    expect(tabSerialPort({ type: "ssh", config: { host: "h", port: 22 } })).toBeUndefined();
    expect(tabSerialPort({ type: "serial", config: { port: "  " } })).toBeUndefined();
    expect(tabSerialPort(undefined)).toBeUndefined();
  });

  it("appends the port to the tooltip unless the title names it", () => {
    const serial = { type: "serial", config: { port: "/dev/ttyS1" } } as const;
    expect(tabTooltipTitle("bench", serial)).toBe("bench · /dev/ttyS1");
    expect(tabTooltipTitle("ttyS1 at /dev/ttyS1", serial)).toBe("ttyS1 at /dev/ttyS1");
    expect(tabTooltipTitle("web", null)).toBe("web");
  });
});

describe("agent setup tabs (#5980)", () => {
  it("shortens the agent name from its end, like an agent shell tab", () => {
    expect(splitTabTitle("Setup: sys-pr-agent-24ef8dc4")).toEqual({
      head: "Setup: sys-pr-agent-24ef8dc4",
      tail: "",
    });
    expect(splitTabTitle("Setup: sys-pr-agent-24ef8dc4 (2)")).toEqual({
      head: "Setup: sys-pr-agent-24ef8dc4",
      tail: " (2)",
    });
  });
});
