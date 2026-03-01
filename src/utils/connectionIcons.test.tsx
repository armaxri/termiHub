import { describe, it, expect } from "vitest";
import { getDefaultIconInfo } from "./connectionIcons";
import type { ConnectionConfig } from "@/types/terminal";
import { BicepsFlexed, GitBranch, Terminal } from "lucide-react";

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
});
