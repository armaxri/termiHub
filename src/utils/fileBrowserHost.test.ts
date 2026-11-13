import { describe, it, expect } from "vitest";
import { fileBrowserHost, type FileBrowserHostTab } from "./fileBrowserHost";
import type { ConnectionConfig } from "@/types/terminal";

function tab(
  connectionType: string,
  config: Record<string, unknown>,
  title = "My tab"
): FileBrowserHostTab {
  return {
    connectionType,
    title,
    config: { type: connectionType, config } as unknown as ConnectionConfig,
  };
}

describe("fileBrowserHost (#5623)", () => {
  it("names the local filesystem 'This computer'", () => {
    expect(fileBrowserHost("local", null)).toEqual({ kind: "local", label: "This computer" });
  });

  it("names an SSH-backed browser user@host (SFTP)", () => {
    expect(
      fileBrowserHost("session", tab("ssh", { host: "127.0.0.1", username: "arne", port: 22 }))
    ).toEqual({ kind: "remote", label: "arne@127.0.0.1 (SFTP)" });
  });

  it("omits the user when the config carries none", () => {
    expect(fileBrowserHost("session", tab("ssh", { host: "box" }))).toEqual({
      kind: "remote",
      label: "box (SFTP)",
    });
  });

  it("names an agent session by its tab, marked as an agent", () => {
    expect(
      fileBrowserHost("session", tab("remote-session", { agentId: "a1" }, "build-box"))
    ).toEqual({ kind: "remote", label: "build-box (agent)" });
  });

  it("falls back to the tab title for a remote end without a host", () => {
    expect(fileBrowserHost("session", tab("docker", { image: "x" }, "web"))).toEqual({
      kind: "remote",
      label: "web",
    });
  });

  it("has no host when the browser is idle or the owner tab is unknown", () => {
    expect(fileBrowserHost("none", null)).toBeNull();
    expect(fileBrowserHost("session", null)).toBeNull();
  });
});
