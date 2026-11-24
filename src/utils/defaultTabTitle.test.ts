import { describe, it, expect } from "vitest";
import { agentShellTabTitle, numberedTabTitle, shellTabName } from "./defaultTabTitle";

describe("shellTabName (#5829)", () => {
  it("names a local shell kind by its program", () => {
    expect(shellTabName("zsh")).toBe("zsh");
    expect(shellTabName("bash")).toBe("bash");
    expect(shellTabName("pwsh")).toBe("pwsh");
    expect(shellTabName("powershell")).toBe("powershell");
    expect(shellTabName("cmd")).toBe("cmd");
  });

  it("spells out the kinds whose id is not a program name", () => {
    expect(shellTabName("gitbash")).toBe("Git Bash");
    expect(shellTabName("nushell")).toBe("nu");
    expect(shellTabName("wsl:Ubuntu-22.04")).toBe("WSL: Ubuntu-22.04");
  });

  it("reduces an agent's shell path to the program", () => {
    expect(shellTabName("/bin/bash")).toBe("bash");
    expect(shellTabName("/usr/local/bin/fish")).toBe("fish");
    expect(shellTabName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  });

  it("falls back to 'shell' for an unknown, custom or missing shell", () => {
    expect(shellTabName(undefined)).toBe("shell");
    expect(shellTabName(null)).toBe("shell");
    expect(shellTabName("  ")).toBe("shell");
    expect(shellTabName("custom")).toBe("shell");
    expect(shellTabName("/")).toBe("shell");
  });
});

describe("agentShellTabTitle (#5829)", () => {
  it("names the agent and the shell, never 'Shell:' or 'local'", () => {
    expect(agentShellTabTitle("pi", "/bin/bash")).toBe("pi · bash");
    expect(agentShellTabTitle("build box", undefined)).toBe("build box · shell");
  });

  it("keeps just the shell when the agent has no name", () => {
    expect(agentShellTabTitle("  ", "zsh")).toBe("zsh");
  });
});

describe("numberedTabTitle (#5829)", () => {
  it("keeps a free name as it is", () => {
    expect(numberedTabTitle("zsh", ["bash", "web"])).toBe("zsh");
  });

  it("numbers a taken name from 2", () => {
    expect(numberedTabTitle("zsh", ["zsh"])).toBe("zsh 2");
    expect(numberedTabTitle("zsh", ["zsh", "zsh 2"])).toBe("zsh 3");
  });

  it("reuses the smallest free number after a close", () => {
    expect(numberedTabTitle("zsh", ["zsh", "zsh 3"])).toBe("zsh 2");
    expect(numberedTabTitle("zsh", ["zsh 2"])).toBe("zsh");
  });

  it("numbers agent tabs the same way", () => {
    expect(numberedTabTitle("pi · bash", ["pi · bash"])).toBe("pi · bash 2");
  });
});
