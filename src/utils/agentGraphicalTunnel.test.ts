import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/types/connection";
import {
  agentGraphicalTabConfig,
  isAgentTunnelledGraphicalType,
  withAgentTunnelledTypes,
} from "./agentGraphicalTunnel";

function type(typeId: string, graphical: boolean, groups: string[] = ["general"]) {
  return {
    typeId,
    displayName: typeId.toUpperCase(),
    icon: typeId,
    schema: { groups: groups.map((key) => ({ key, label: key, fields: [] })) },
    capabilities: {
      monitoring: false,
      fileBrowser: false,
      resize: false,
      persistent: false,
      graphical,
    },
  } as ConnectionTypeInfo;
}

describe("agentGraphicalTunnel (#3241)", () => {
  it("recognizes only VNC and RDP as agent-tunnelled types", () => {
    expect(isAgentTunnelledGraphicalType("vnc")).toBe(true);
    expect(isAgentTunnelledGraphicalType("rdp")).toBe(true);
    expect(isAgentTunnelledGraphicalType("mock-remote-desktop")).toBe(false);
    expect(isAgentTunnelledGraphicalType("ssh")).toBe(false);
  });

  it("offers this computer's VNC/RDP types after the agent's own types", () => {
    const agentTypes = [type("local", false), type("ssh", false)];
    const desktopTypes = [
      type("ssh", false),
      type("vnc", true, ["general", "sshTunnel"]),
      type("rdp", true),
      type("mock-remote-desktop", true),
    ];
    const merged = withAgentTunnelledTypes(agentTypes, desktopTypes);
    expect(merged.map((t) => t.typeId)).toEqual(["local", "ssh", "vnc", "rdp"]);
    // VNC's own SSH tunnel cannot combine with the agent route.
    const vnc = merged.find((t) => t.typeId === "vnc")!;
    expect(vnc.schema.groups.map((g) => g.key)).toEqual(["general"]);
    // The desktop registry entry itself is untouched.
    expect(desktopTypes[1].schema.groups).toHaveLength(2);
  });

  it("drops the linked SSH file route, which only applies to direct connections (#4194)", () => {
    const vnc = type("vnc", true, ["fileTransfer"]);
    vnc.schema.groups[0].fields = [
      "fileTransfer",
      "fileTransferVia",
      "fileTransferViaHostWarning",
    ].map((key) => ({ key, label: key, fieldType: { type: "text" }, required: false }));
    const merged = withAgentTunnelledTypes([], [vnc]);
    expect(merged[0].schema.groups[0].fields.map((f) => f.key)).toEqual(["fileTransfer"]);
    expect(vnc.schema.groups[0].fields).toHaveLength(3);
  });

  it("offers nothing extra when this build has no graphical types", () => {
    const agentTypes = [type("local", false)];
    expect(withAgentTunnelledTypes(agentTypes, [type("ssh", false)])).toEqual(agentTypes);
  });

  it("keeps a type the agent already reports as the agent describes it", () => {
    const agentVnc = type("vnc", true, ["agentOwn"]);
    const merged = withAgentTunnelledTypes([agentVnc], [type("vnc", true, ["general"])]);
    expect(merged).toEqual([agentVnc]);
  });

  it("builds a remote-desktop tab config routed through the agent", () => {
    expect(agentGraphicalTabConfig("agent-1", "vnc", { host: "10.0.0.5", port: 5901 })).toEqual({
      type: "vnc",
      config: { host: "10.0.0.5", port: 5901, agentId: "agent-1" },
    });
  });
});
