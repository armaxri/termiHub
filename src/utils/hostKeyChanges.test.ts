import { describe, it, expect } from "vitest";
import { hostKeyChanges } from "./hostKeyChanges";

const base = { changed: true, key_type: "ssh-ed25519" };

describe("hostKeyChanges (#5862)", () => {
  it("says nothing on first contact", () => {
    expect(hostKeyChanges({ ...base, changed: false, previous_keys: null })).toEqual([]);
  });

  it("names the different fingerprint even without a recorded prior", () => {
    expect(hostKeyChanges({ ...base, previous_keys: null })).toEqual([
      "The fingerprint is different from the key trusted before.",
    ]);
  });

  it("says the key type is unchanged", () => {
    const previous_keys = [{ key_type: "ssh-ed25519", fingerprint: "SHA256:a" }];
    expect(hostKeyChanges({ ...base, previous_keys })).toEqual([
      "The fingerprint is different from the key trusted before.",
      "The key type is the same (ssh-ed25519).",
    ]);
  });

  it("names a key type change", () => {
    const previous_keys = [{ key_type: "ssh-rsa", fingerprint: "SHA256:a" }];
    expect(hostKeyChanges({ ...base, previous_keys })[1]).toBe(
      "The key type changed from ssh-rsa to ssh-ed25519."
    );
  });

  it("covers several priors and skips unknown types", () => {
    const previous_keys = [
      { key_type: null, fingerprint: "SHA256:a" },
      { key_type: "ssh-rsa", fingerprint: "SHA256:b" },
    ];
    expect(hostKeyChanges({ ...base, previous_keys })).toEqual([
      "The fingerprint matches none of the keys trusted before.",
      "The key type changed from ssh-rsa to ssh-ed25519.",
    ]);
    expect(
      hostKeyChanges({ ...base, previous_keys: [{ key_type: null, fingerprint: "SHA256:a" }] })
    ).toHaveLength(1);
  });
});
