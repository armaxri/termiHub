import { describe, it, expect } from "vitest";
import { sshAgentStartCommand } from "./sshAgentSetup";

describe("sshAgentStartCommand", () => {
  it("returns the elevated PowerShell service command on Windows", () => {
    const cmd = sshAgentStartCommand("windows");
    expect(cmd).toContain("Set-Service ssh-agent");
    expect(cmd).toContain("Start-Service ssh-agent");
  });

  // #2088: the Windows service command is meaningless on macOS/Linux — those
  // platforms start an agent for the shell and add keys instead.
  it("returns the ssh-agent/ssh-add command on macOS", () => {
    expect(sshAgentStartCommand("macos")).toBe('eval "$(ssh-agent -s)" && ssh-add');
  });

  it("returns the ssh-agent/ssh-add command on Linux", () => {
    expect(sshAgentStartCommand("linux")).toBe('eval "$(ssh-agent -s)" && ssh-add');
  });

  it("never returns the Windows service command on non-Windows platforms", () => {
    expect(sshAgentStartCommand("macos")).not.toContain("Set-Service");
    expect(sshAgentStartCommand("linux")).not.toContain("Set-Service");
  });
});
