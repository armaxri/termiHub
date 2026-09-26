/** Which open tabs can back the transfer view's remote pane (PROD-007, #3558). */
import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/services/api";
import type { TabContent } from "@/types/terminal";
import { transferRemoteOptions } from "./transferViewRemotes";

function typeInfo(typeId: string, fileBrowser: boolean): ConnectionTypeInfo {
  return { typeId, capabilities: { fileBrowser } } as unknown as ConnectionTypeInfo;
}

function tab(id: string, partial: Partial<TabContent>): TabContent {
  return {
    id,
    sessionId: `s-${id}`,
    title: id,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    ...partial,
  } as TabContent;
}

const types = [typeInfo("ssh", true), typeInfo("telnet", false), typeInfo("ftp", true)];

describe("transferRemoteOptions", () => {
  it("lists connected remote tabs whose type can browse files", () => {
    const options = transferRemoteOptions(
      [
        tab("a", {}),
        tab("b", { connectionType: "telnet" }),
        tab("c", { connectionType: "local" }),
        tab("d", { connectionType: "ftp", contentType: "file-browser" }),
        tab("e", { contentType: "editor" }),
        tab("f", { sessionId: null }),
      ],
      types,
      []
    );
    expect(options.map((o) => o.tabId)).toEqual(["a", "d"]);
    expect(options[0]).toEqual({ tabId: "a", title: "a", sessionId: "s-a" });
  });

  it("honours a connection's file-browser opt-out", () => {
    const optedOut = tab("a", {
      config: { type: "ssh", config: { enableFileBrowser: false } },
    });
    expect(transferRemoteOptions([optedOut], types, [])).toEqual([]);
  });

  it("includes agent sessions whose agent type can browse files", () => {
    const agentTab = tab("g", {
      connectionType: "remote-session",
      config: { type: "remote-session", config: { agentId: "ag", sessionType: "local" } },
    });
    const agents = [{ id: "ag", capabilities: { connectionTypes: [typeInfo("local", true)] } }];
    expect(transferRemoteOptions([agentTab], types, agents).map((o) => o.tabId)).toEqual(["g"]);
    const noFiles = [{ id: "ag", capabilities: { connectionTypes: [typeInfo("local", false)] } }];
    expect(transferRemoteOptions([agentTab], types, noFiles)).toEqual([]);
  });
});
