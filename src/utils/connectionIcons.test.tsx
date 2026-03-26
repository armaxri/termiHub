import { describe, it, expect } from "vitest";
import { getDefaultIconInfo } from "./connectionIcons";
import type { ConnectionConfig } from "@/types/terminal";
import { BicepsFlexed, GitBranch, Terminal, Server } from "lucide-react";

describe("getDefaultIconInfo", () => {
  it("resolves icon from 'shell' key", () => {
    const config: ConnectionConfig = { type: "local", config: { shell: "powershell" } };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("resolves icon from legacy 'shellType' key", () => {
    const config: ConnectionConfig = { type: "local", config: { shellType: "gitbash" } };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(GitBranch);
  });

  it("prefers 'shell' over 'shellType' when both present", () => {
    const config: ConnectionConfig = {
      type: "local",
      config: { shell: "powershell", shellType: "gitbash" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("returns Terminal icon when no shell key is present", () => {
    const config: ConnectionConfig = { type: "local", config: {} };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(Terminal);
  });

  it("returns WSL penguin icon for wsl: prefix", () => {
    const config: ConnectionConfig = { type: "local", config: { shell: "wsl:Ubuntu" } };
    const info = getDefaultIconInfo(config);
    expect(info.iconNode).toBeDefined();
    expect(info.component).toBeUndefined();
  });

  it("returns WSL penguin icon for dedicated wsl connection type", () => {
    const config: ConnectionConfig = { type: "wsl", config: { distribution: "Ubuntu" } };
    const info = getDefaultIconInfo(config);
    expect(info.iconNode).toBeDefined();
    expect(info.component).toBeUndefined();
  });

  it("returns powershell icon for remote-session with shell=powershell", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "powershell" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("returns powershell icon for remote-session with full path /usr/local/bin/pwsh", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "/usr/local/bin/pwsh" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("returns powershell icon for remote-session with full path /usr/bin/pwsh", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "/usr/bin/pwsh" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("returns powershell icon for remote-session with sessionType=local and pwsh path", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "local", shell: "/snap/bin/pwsh" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(BicepsFlexed);
  });

  it("returns gitbash icon for remote-session with shell=gitbash", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "gitbash" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(GitBranch);
  });

  it("returns terminal icon for remote-session with shell=/bin/bash", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "/bin/bash" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(Terminal);
  });

  it("returns terminal icon for remote-session with shell=bash", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "shell", shell: "bash" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(Terminal);
  });

  it("returns Server icon for remote-session with sessionType=serial", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1", sessionType: "serial", serialPort: "/dev/ttyS0" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(Server);
  });

  it("returns Server icon for remote-session with no sessionType", () => {
    const config: ConnectionConfig = {
      type: "remote-session",
      config: { agentId: "a1" },
    };
    const info = getDefaultIconInfo(config);
    expect(info.component).toBe(Server);
  });
});
