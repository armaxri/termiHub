import { describe, it, expect } from "vitest";
import { keyFileName, sshSecurityChip, sshTrustLevel } from "./sshSecurityChip";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import type { ConnectionConfig } from "@/types/terminal";

const SSH: ConnectionConfig = {
  type: "ssh",
  config: {
    host: "127.0.0.1",
    port: 22400,
    username: "arne",
    authMethod: "key",
    keyPath: "~/.ssh/pr_ed25519",
  },
};

function key(
  trust: SshHostKeyTrustedEvent["trust"],
  host = "127.0.0.1",
  port = 22400
): SshHostKeyTrustedEvent {
  return {
    owner: "tab-1:0",
    host,
    port,
    key_type: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    trust,
  };
}

describe("sshTrustLevel (#5839)", () => {
  it("maps remembered keys to trusted, session-only keys to once", () => {
    expect(sshTrustLevel(key("knownHosts"))).toBe("trusted");
    expect(sshTrustLevel(key("remembered"))).toBe("trusted");
    expect(sshTrustLevel(key("firstSeenRemembered"))).toBe("trusted");
    expect(sshTrustLevel(key("changedReplaced"))).toBe("trusted");
    expect(sshTrustLevel(key("firstSeenOnce"))).toBe("once");
    expect(sshTrustLevel(key("changedOnce"))).toBe("once");
    expect(sshTrustLevel(undefined)).toBe("pending");
  });
});

describe("keyFileName (#5956)", () => {
  it("keeps only the file name of a POSIX, home-relative or Windows path", () => {
    expect(keyFileName("/Users/me/work/run/sshd/keys/pr_ed25519")).toBe("pr_ed25519");
    expect(keyFileName("~/.ssh/id_rsa")).toBe("id_rsa");
    expect(keyFileName("C:\\Users\\me\\.ssh\\id_ed25519")).toBe("id_ed25519");
    expect(keyFileName("id_ed25519")).toBe("id_ed25519");
    expect(keyFileName("/keys/dir/")).toBe("dir");
  });
});

describe("sshSecurityChip (#5839)", () => {
  it("returns null for non-SSH configs and SSH configs without a host", () => {
    expect(sshSecurityChip({ type: "local", config: { shell: "zsh" } })).toBeNull();
    expect(sshSecurityChip({ type: "ssh", config: {} })).toBeNull();
    expect(sshSecurityChip(undefined)).toBeNull();
  });

  it("names a trusted, encrypted session and lists its security rows", () => {
    const chip = sshSecurityChip(SSH, [key("remembered")])!;
    expect(chip.label).toBe("arne@127.0.0.1:22400");
    expect(chip.trust).toBe("trusted");
    expect(chip.ariaLabel).toBe(
      "SSH: arne@127.0.0.1:22400, encrypted, host key trusted. Show connection security"
    );
    const rows = Object.fromEntries(chip.rows.map((r) => [r.id, r.value]));
    expect(rows).toEqual({
      endpoint: "arne@127.0.0.1:22400",
      encryption: "Encrypted (SSH)",
      auth: "key pr_ed25519",
      hostKey: "trusted · ssh-ed25519 SHA256:abc",
    });
    // The full key path stays reachable on hover (#5956).
    expect(chip.rows.find((r) => r.id === "auth")!.title).toBe("~/.ssh/pr_ed25519");
    // The hover tooltip of #5669 is kept.
    expect(chip.tooltip).toContain("Host key: trusted (SHA256:abc)");
  });

  it("marks a key trusted for this session only", () => {
    const chip = sshSecurityChip(SSH, [key("firstSeenOnce")])!;
    expect(chip.trust).toBe("once");
    expect(chip.ariaLabel).toContain("host key trusted once");
  });

  it("says the key is not checked yet before the connect reports it", () => {
    const chip = sshSecurityChip(SSH)!;
    expect(chip.trust).toBe("pending");
    expect(chip.rows.find((r) => r.id === "hostKey")!.value).toBe(
      "Not checked yet (still connecting)"
    );
  });

  it("ignores a jump hop's key and accepts a numeric-string port", () => {
    const config: ConnectionConfig = {
      type: "ssh",
      config: { host: "app", port: "2222", username: "deploy", authMethod: "agent" },
    };
    const chip = sshSecurityChip(config, [key("remembered", "bastion", 22)])!;
    expect(chip.trust).toBe("pending");
    const target = sshSecurityChip(config, [key("changedOnce", "app", 2222)])!;
    expect(target.trust).toBe("once");
    expect(target.rows.find((r) => r.id === "auth")!.value).toBe("SSH agent");
  });
});
