import { describe, it, expect, beforeEach } from "vitest";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import { recordSshHostKeyTrust, useSshHostKeyTrustStore } from "./sshHostKeyTrustBridge";

function trusted(owner: string, host: string, fingerprint: string): SshHostKeyTrustedEvent {
  return { owner, host, port: 22, key_type: "ssh-ed25519", fingerprint, trust: "remembered" };
}

const keysOf = (tabId: string) =>
  useSshHostKeyTrustStore.getState().byTab[tabId]?.map((e) => `${e.host}=${e.fingerprint}`);

describe("sshHostKeyTrustBridge (#5669)", () => {
  beforeEach(() => useSshHostKeyTrustStore.setState({ byTab: {} }));

  it("keeps one key per host:port for the tab's attempt", () => {
    recordSshHostKeyTrust(trusted("tab-1:0", "bastion", "SHA256:B"));
    recordSshHostKeyTrust(trusted("tab-1:0", "target", "SHA256:T"));
    recordSshHostKeyTrust(trusted("tab-1:0", "target", "SHA256:T2"));
    expect(keysOf("tab-1")).toEqual(["bastion=SHA256:B", "target=SHA256:T2"]);
  });

  it("a newer attempt replaces the earlier attempt's keys", () => {
    recordSshHostKeyTrust(trusted("tab-1:0", "bastion", "SHA256:B"));
    recordSshHostKeyTrust(trusted("tab-1:1", "target", "SHA256:T"));
    expect(keysOf("tab-1")).toEqual(["target=SHA256:T"]);
  });

  it("ignores an owner without a tab prefix", () => {
    recordSshHostKeyTrust(trusted("bogus", "h", "SHA256:X"));
    expect(useSshHostKeyTrustStore.getState().byTab).toEqual({});
  });
});
