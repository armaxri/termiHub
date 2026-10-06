/** Agent session-type aliasing (#4017). */
import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/services/api";
import { findAgentConnectionType, normalizeAgentTypeId } from "./agentSessionType";

function typeInfo(typeId: string): ConnectionTypeInfo {
  return { typeId, capabilities: { fileBrowser: true } } as unknown as ConnectionTypeInfo;
}

describe("normalizeAgentTypeId", () => {
  it("maps the user-facing `shell` alias to the registry's `local`", () => {
    expect(normalizeAgentTypeId("shell", [typeInfo("local")])).toBe("local");
  });

  it("keeps an id the registry lists, even an alias", () => {
    expect(normalizeAgentTypeId("shell", [typeInfo("shell")])).toBe("shell");
    expect(normalizeAgentTypeId("ssh", [typeInfo("ssh")])).toBe("ssh");
  });

  it("passes unknown ids through", () => {
    expect(normalizeAgentTypeId("serial", [])).toBe("serial");
  });
});

describe("findAgentConnectionType", () => {
  it("finds the agent's `local` entry for a `shell` tab", () => {
    const local = typeInfo("local");
    expect(findAgentConnectionType([typeInfo("ssh"), local], "shell")).toBe(local);
  });

  it("is undefined when the agent lists no matching type", () => {
    expect(findAgentConnectionType([typeInfo("ssh")], "shell")).toBeUndefined();
  });
});
