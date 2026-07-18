import { describe, it, expect } from "vitest";
import type { EditorTabMeta, TerminalTab } from "@/types/terminal";
import {
  getEditorSessionQualifier,
  getEditorTabDisplayTitle,
} from "./editorTabTitle";

function makeTab(overrides: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    sessionId: null,
    title: "tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: false,
    ...overrides,
  };
}

function makeEditorTab(
  id: string,
  title: string,
  meta: Partial<EditorTabMeta> & { filePath: string; isRemote: boolean }
): TerminalTab {
  return makeTab({
    id,
    title,
    contentType: "editor",
    editorMeta: meta,
  });
}

describe("getEditorSessionQualifier", () => {
  it("returns the host label for an SFTP-backed tab", () => {
    const tab = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-a:22",
    });
    expect(getEditorSessionQualifier(tab, [tab])).toBe("user@host-a:22");
  });

  it("returns the owning terminal tab's title for a session-layer tab", () => {
    const owner = makeTab({ id: "owner-1", title: "prod-box" });
    const editor = makeEditorTab("a", "config.yml", {
      filePath: "/app/config.yml",
      isRemote: true,
      sessionKey: "session:owner-1",
    });
    expect(getEditorSessionQualifier(editor, [owner, editor])).toBe("prod-box");
  });

  it("returns undefined for a local tab (no sessionKey)", () => {
    const tab = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: false,
    });
    expect(getEditorSessionQualifier(tab, [tab])).toBeUndefined();
  });

  it("returns undefined when the session-layer owner is gone", () => {
    const editor = makeEditorTab("a", "config.yml", {
      filePath: "/app/config.yml",
      isRemote: true,
      sessionKey: "session:missing",
    });
    expect(getEditorSessionQualifier(editor, [editor])).toBeUndefined();
  });
});

describe("getEditorTabDisplayTitle", () => {
  it("keeps the plain basename for a lone remote editor tab", () => {
    const tab = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-a:22",
    });
    expect(getEditorTabDisplayTitle(tab, [tab])).toBe("hosts");
  });

  it("disambiguates two same-basename tabs from different sessions", () => {
    const a = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-a:22",
    });
    const b = makeEditorTab("b", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-b:22",
    });
    const all = [a, b];
    expect(getEditorTabDisplayTitle(a, all)).toBe("hosts — user@host-a:22");
    expect(getEditorTabDisplayTitle(b, all)).toBe("hosts — user@host-b:22");
    // The two titles must differ.
    expect(getEditorTabDisplayTitle(a, all)).not.toBe(getEditorTabDisplayTitle(b, all));
  });

  it("does not suffix a remote tab whose basename is unique", () => {
    const a = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-a:22",
    });
    const b = makeEditorTab("b", "passwd", {
      filePath: "/etc/passwd",
      isRemote: true,
      sessionKey: "sftp:user@host-b:22",
    });
    const all = [a, b];
    expect(getEditorTabDisplayTitle(a, all)).toBe("hosts");
    expect(getEditorTabDisplayTitle(b, all)).toBe("passwd");
  });

  it("leaves a local editor tab plain even when a remote tab shares the basename", () => {
    const local = makeEditorTab("a", "hosts", {
      filePath: "/etc/hosts",
      isRemote: false,
    });
    const remote = makeEditorTab("b", "hosts", {
      filePath: "/etc/hosts",
      isRemote: true,
      sessionKey: "sftp:user@host-b:22",
    });
    const all = [local, remote];
    // Local keeps the bare basename; the remote one carries the qualifier.
    expect(getEditorTabDisplayTitle(local, all)).toBe("hosts");
    expect(getEditorTabDisplayTitle(remote, all)).toBe("hosts — user@host-b:22");
  });

  it("does not touch non-editor tabs", () => {
    const term = makeTab({ id: "t", title: "bash", contentType: "terminal" });
    expect(getEditorTabDisplayTitle(term, [term])).toBe("bash");
  });
});
