/**
 * Unit tests for the process-kill signal menu model (#3209): which signals are
 * offered, which are destructive, and which a Windows local host can deliver.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_KILL_SIGNAL,
  KILL_SIGNALS,
  isDestructiveSignal,
  isSignalAvailable,
  isTerminateOnlyHost,
  signalName,
  signalOptionLabel,
} from "./killSignals";
import type { KillSignal } from "@/types/monitoring";

// Compile-time guard: every generated `KillSignal` value has a row here, so a
// new backend variant cannot silently miss the menu.
const EVERY_SIGNAL: Record<KillSignal, string> = {
  term: "SIGTERM",
  kill: "SIGKILL",
  int: "SIGINT",
  hup: "SIGHUP",
  quit: "SIGQUIT",
  stop: "SIGSTOP",
  cont: "SIGCONT",
  usr1: "SIGUSR1",
  usr2: "SIGUSR2",
};

describe("killSignals (#3209)", () => {
  it("offers the full common signal set, TERM first", () => {
    expect([...KILL_SIGNALS].sort()).toEqual(Object.keys(EVERY_SIGNAL).sort());
    expect(KILL_SIGNALS[0]).toBe("term");
    expect(DEFAULT_KILL_SIGNAL).toBe("term");
  });

  it("names each signal with its SIG-prefixed name", () => {
    for (const signal of KILL_SIGNALS) {
      expect(signalName(signal)).toBe(EVERY_SIGNAL[signal]);
      expect(signalOptionLabel(signal)).toContain(EVERY_SIGNAL[signal]);
    }
  });

  it("treats only KILL and STOP as destructive", () => {
    const destructive = KILL_SIGNALS.filter(isDestructiveSignal);
    expect(destructive.sort()).toEqual(["kill", "stop"]);
  });

  it("limits only local sessions on a Windows desktop", () => {
    expect(isTerminateOnlyHost("local", "windows")).toBe(true);
    expect(isTerminateOnlyHost("local", "linux")).toBe(false);
    expect(isTerminateOnlyHost("local", "macos")).toBe(false);
    // Remote and agent-hosted sessions run POSIX `kill`, even from Windows.
    for (const type of ["ssh", "docker", "wsl", "remote-session", null]) {
      expect(isTerminateOnlyHost(type, "windows")).toBe(false);
    }
  });

  it("makes only TERM and KILL available on a terminate-only host", () => {
    expect(KILL_SIGNALS.filter((s) => isSignalAvailable(s, true)).sort()).toEqual([
      "kill",
      "term",
    ]);
    expect(KILL_SIGNALS.every((s) => isSignalAvailable(s, false))).toBe(true);
  });
});
