import { describe, expect, it } from "vitest";
import type { RemoteAgentConfig } from "@/types/generated/RemoteAgentConfig";
import { remoteAgentConfigToRecord, toRemoteAgentConfig } from "./remoteAgentConfig";

describe("remoteAgentConfig conversions (#3162)", () => {
  it("builds a well-formed DTO from a minimal form bag, defaulting required fields", () => {
    const config = toRemoteAgentConfig({});
    expect(config).toEqual({
      host: "",
      port: 22,
      username: "",
      authMethod: "password",
    });
  });

  it("reads each field from the form bag with the right type", () => {
    const config = toRemoteAgentConfig({
      host: "pi.local",
      port: 2222,
      username: "pi",
      authMethod: "key",
      keyPath: "~/.ssh/id_ed25519",
      savePassword: true,
      agentPath: "~/bin/termihub-agent",
      allowSelfUpdate: false,
      updateStrategy: "coordinated",
      externalConnectionFiles: [{ path: "/etc/agent.json", enabled: true }],
    });
    expect(config).toEqual({
      host: "pi.local",
      port: 2222,
      username: "pi",
      authMethod: "key",
      keyPath: "~/.ssh/id_ed25519",
      savePassword: true,
      agentPath: "~/bin/termihub-agent",
      allowSelfUpdate: false,
      updateStrategy: "coordinated",
      externalConnectionFiles: [{ path: "/etc/agent.json", enabled: true }],
    });
  });

  it("falls back to defaults for wrongly-typed required fields", () => {
    const config = toRemoteAgentConfig({
      host: 123,
      port: "2222",
      username: null,
      authMethod: "bogus",
    });
    expect(config).toEqual({ host: "", port: 22, username: "", authMethod: "password" });
  });

  it("drops malformed external-connection-file entries", () => {
    const config = toRemoteAgentConfig({
      host: "h",
      port: 22,
      username: "u",
      authMethod: "agent",
      externalConnectionFiles: [
        { path: "/ok", enabled: true },
        { path: 5, enabled: true },
        { path: "/no-enabled" },
        "not-an-object",
        null,
      ],
    });
    expect(config.externalConnectionFiles).toEqual([{ path: "/ok", enabled: true }]);
  });

  it("ignores an unknown updateStrategy value", () => {
    const config = toRemoteAgentConfig({
      host: "h",
      port: 22,
      username: "u",
      authMethod: "agent",
      updateStrategy: "later",
    });
    expect(config.updateStrategy).toBeUndefined();
  });

  it("projects a DTO back into a form bag, copying only present optionals", () => {
    const config: RemoteAgentConfig = {
      host: "pi.local",
      port: 2222,
      username: "pi",
      authMethod: "password",
      password: "secret",
      savePassword: true,
    };
    expect(remoteAgentConfigToRecord(config)).toEqual({
      host: "pi.local",
      port: 2222,
      username: "pi",
      authMethod: "password",
      password: "secret",
      savePassword: true,
    });
  });

  it("round-trips a full DTO through record and back without dropping fields", () => {
    const config: RemoteAgentConfig = {
      host: "pi.local",
      port: 2222,
      username: "pi",
      authMethod: "key",
      keyPath: "~/.ssh/id_ed25519",
      savePassword: false,
      agentPath: "~/bin/termihub-agent",
      externalConnectionFiles: [
        { path: "/etc/agent.json", enabled: true },
        { path: "/etc/other.json", enabled: false },
      ],
      allowSelfUpdate: true,
      updateStrategy: "immediate",
    };
    expect(toRemoteAgentConfig(remoteAgentConfigToRecord(config))).toEqual(config);
  });
});
