import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/services/api";
import {
  fileBrowserPlaceholderTitle,
  resolveFileBrowserPlaceholder,
  type FileBrowserPlaceholderInput,
} from "./fileBrowserPlaceholder";

function type(typeId: string, displayName: string, fileBrowser: boolean): ConnectionTypeInfo {
  return {
    typeId,
    displayName,
    icon: typeId,
    schema: { groups: [] },
    capabilities: { monitoring: false, fileBrowser, resize: true, persistent: false },
  } as ConnectionTypeInfo;
}

const TYPES = [type("serial", "Serial", false), type("ssh", "SSH", true)];

function input(over: Partial<FileBrowserPlaceholderInput>): FileBrowserPlaceholderInput {
  return {
    hasActiveTab: true,
    contentType: "terminal",
    connectionType: null,
    sessionId: "s-1",
    fileBrowserEnabled: true,
    connectionTypes: TYPES,
    ...over,
  };
}

describe("resolveFileBrowserPlaceholder (#5299)", () => {
  it("reports no-tab when nothing is open", () => {
    const p = resolveFileBrowserPlaceholder(input({ hasActiveTab: false }));
    expect(p).toEqual({ kind: "no-tab" });
    expect(fileBrowserPlaceholderTitle(p)).toBe(
      "Open a terminal or connection to browse its files"
    );
  });

  it("treats a Settings tab like no connection tab", () => {
    expect(resolveFileBrowserPlaceholder(input({ contentType: "settings" })).kind).toBe("no-tab");
  });

  it("names an unsupported type by its display label", () => {
    const p = resolveFileBrowserPlaceholder(input({ connectionType: "serial" }));
    expect(p).toEqual({ kind: "unsupported", typeLabel: "Serial" });
    expect(fileBrowserPlaceholderTitle(p)).toBe("Serial connections have no file system");
  });

  it("falls back to the type id when the type is unregistered", () => {
    const p = resolveFileBrowserPlaceholder(input({ connectionType: "telnet" }));
    expect(p).toEqual({ kind: "unsupported", typeLabel: "telnet" });
  });

  it("reports disabled when a capable type has browsing turned off", () => {
    const p = resolveFileBrowserPlaceholder(
      input({ connectionType: "ssh", fileBrowserEnabled: false })
    );
    expect(p.kind).toBe("disabled");
  });

  it("reports connecting when a capable type has no session yet", () => {
    const p = resolveFileBrowserPlaceholder(input({ connectionType: "ssh", sessionId: null }));
    expect(p.kind).toBe("connecting");
  });

  it("names the agent's session type when the agent cannot browse it", () => {
    const p = resolveFileBrowserPlaceholder(
      input({ connectionType: "remote-session", agentTypeInfo: type("serial", "Serial", false) })
    );
    expect(p).toEqual({ kind: "unsupported", typeLabel: "Serial" });
  });

  it("reports unavailable for a remote desktop without a side channel", () => {
    const p = resolveFileBrowserPlaceholder(
      input({ contentType: "remote-desktop", connectionType: "vnc" })
    );
    expect(p.kind).toBe("unavailable");
  });
});
