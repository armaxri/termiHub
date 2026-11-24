import { describe, it, expect } from "vitest";
import { keyFileName, plainAlgorithmName, sshSecurityChip, sshTrustLevel } from "./sshSecurityChip";
import type { SshNegotiatedAlgorithms } from "@/types/generated/SshNegotiatedAlgorithms";
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

describe("negotiated algorithms in the popover (#5896)", () => {
  const AEAD: SshNegotiatedAlgorithms = {
    kex: "curve25519-sha256",
    hostKey: "ssh-ed25519",
    cipher: "chacha20-poly1305@openssh.com",
    mac: null,
  };
  const WITH_MAC: SshNegotiatedAlgorithms = {
    kex: "sntrup761x25519-sha512@openssh.com",
    hostKey: "rsa-sha2-512",
    cipher: "aes256-ctr",
    mac: "hmac-sha2-256-etm@openssh.com",
  };

  function rows(algorithms?: SshNegotiatedAlgorithms | null) {
    return sshSecurityChip(SSH, [key("remembered")], algorithms)!.rows;
  }

  it("drops the vendor suffix of a wire name", () => {
    expect(plainAlgorithmName("chacha20-poly1305@openssh.com")).toBe("chacha20-poly1305");
    expect(plainAlgorithmName("curve25519-sha256")).toBe("curve25519-sha256");
    expect(plainAlgorithmName(" aes256-gcm@openssh.com ")).toBe("aes256-gcm");
  });

  it("keeps the plain encryption row while the algorithms are unknown", () => {
    for (const unknown of [undefined, null]) {
      const r = rows(unknown);
      expect(r.map((row) => row.id)).toEqual(["endpoint", "encryption", "auth", "hostKey"]);
      expect(r.find((row) => row.id === "encryption")!.value).toBe("Encrypted (SSH)");
    }
  });

  it("names the cipher and key exchange, and no MAC for an AEAD cipher", () => {
    const r = rows(AEAD);
    expect(r.map((row) => row.id)).toEqual([
      "endpoint",
      "encryption",
      "keyExchange",
      "auth",
      "hostKey",
      "hostKeyAlgorithm",
    ]);
    const encryption = r.find((row) => row.id === "encryption")!;
    expect(encryption).toMatchObject({
      label: "Encryption",
      value: "chacha20-poly1305",
      title: "chacha20-poly1305@openssh.com",
    });
    const kex = r.find((row) => row.id === "keyExchange")!;
    expect(kex).toEqual({ id: "keyExchange", label: "Key exchange", value: "curve25519-sha256" });
    expect(r.find((row) => row.id === "hostKeyAlgorithm")!.value).toBe("ssh-ed25519");
  });

  it("adds the integrity MAC for a cipher that needs one", () => {
    const r = rows(WITH_MAC);
    expect(r.find((row) => row.id === "encryption")!.value).toBe("aes256-ctr");
    expect(r.find((row) => row.id === "integrity")).toMatchObject({
      label: "Integrity",
      value: "hmac-sha2-256-etm",
    });
    expect(r.find((row) => row.id === "keyExchange")!.value).toBe("sntrup761x25519-sha512");
    expect(r.find((row) => row.id === "hostKeyAlgorithm")!.value).toBe("rsa-sha2-512");
  });

  it("never names the algorithms on the chip itself", () => {
    const plain = sshSecurityChip(SSH, [key("remembered")])!;
    const known = sshSecurityChip(SSH, [key("remembered")], WITH_MAC)!;
    expect(known.label).toBe(plain.label);
    expect(known.ariaLabel).toBe(plain.ariaLabel);
    expect(known.tooltip).toBe(plain.tooltip);
  });
});
