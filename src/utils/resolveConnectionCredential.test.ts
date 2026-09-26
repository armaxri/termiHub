import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  resolveCredential: vi.fn(),
}));

vi.mock("@/services/namedCredentials", () => ({
  resolveNamedCredential: vi.fn(),
}));

import { resolveCredential } from "@/services/api";
import { resolveNamedCredential } from "@/services/namedCredentials";
import { resolveConnectionCredential } from "./resolveConnectionCredential";

const mockedResolveCredential = vi.mocked(resolveCredential);
const mockedResolveNamed = vi.mocked(resolveNamedCredential);

describe("resolveConnectionCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves stored password for password auth", async () => {
    mockedResolveCredential.mockResolvedValue("stored-pw");

    const result = await resolveConnectionCredential("conn-1", "password");

    expect(mockedResolveCredential).toHaveBeenCalledWith("conn-1", "password");
    expect(result).toEqual({
      password: "stored-pw",
      usedStoredCredential: true,
      credentialType: "password",
    });
  });

  it("returns null when no stored password exists", async () => {
    mockedResolveCredential.mockResolvedValue(null);

    const result = await resolveConnectionCredential("conn-1", "password");

    expect(mockedResolveCredential).toHaveBeenCalledWith("conn-1", "password");
    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
  });

  it("resolves stored key passphrase when savePassword is true", async () => {
    mockedResolveCredential.mockResolvedValue("key-pass");

    const result = await resolveConnectionCredential("conn-2", "key", true);

    expect(mockedResolveCredential).toHaveBeenCalledWith("conn-2", "key_passphrase");
    expect(result).toEqual({
      password: "key-pass",
      usedStoredCredential: true,
      credentialType: "key_passphrase",
    });
  });

  it("skips store for agent auth", async () => {
    const result = await resolveConnectionCredential("conn-3", "agent");

    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
  });

  it("skips store for key auth without savePassword", async () => {
    const result = await resolveConnectionCredential("conn-4", "key", false);

    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
  });

  it("treats empty string password as not found", async () => {
    mockedResolveCredential.mockResolvedValue("");

    const result = await resolveConnectionCredential("conn-1", "password");

    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
  });

  it("treats empty string key passphrase as not found", async () => {
    mockedResolveCredential.mockResolvedValue("");

    const result = await resolveConnectionCredential("conn-2", "key", true);

    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "key_passphrase",
    });
  });

  it("falls through on store error for password auth", async () => {
    mockedResolveCredential.mockRejectedValue(new Error("Store locked"));

    const result = await resolveConnectionCredential("conn-5", "password");

    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "password",
    });
  });

  it("falls through on store error for key passphrase", async () => {
    mockedResolveCredential.mockRejectedValue(new Error("Store locked"));

    const result = await resolveConnectionCredential("conn-6", "key", true);

    expect(result).toEqual({
      password: null,
      usedStoredCredential: false,
      credentialType: "key_passphrase",
    });
  });

  describe("with a shared named credential (#3557)", () => {
    it("resolves the named credential instead of the per-connection secret", async () => {
      mockedResolveNamed.mockResolvedValue("shared-pw");

      const result = await resolveConnectionCredential("conn-1", "password", false, "nc-1");

      expect(mockedResolveNamed).toHaveBeenCalledWith("nc-1", "password");
      expect(mockedResolveCredential).not.toHaveBeenCalled();
      expect(result).toEqual({
        password: "shared-pw",
        usedStoredCredential: true,
        credentialType: "password",
        namedCredentialId: "nc-1",
      });
    });

    it("resolves a key passphrase even without savePassword", async () => {
      mockedResolveNamed.mockResolvedValue("phrase");

      const result = await resolveConnectionCredential("conn-2", "key", false, "nc-2");

      expect(mockedResolveNamed).toHaveBeenCalledWith("nc-2", "key_passphrase");
      expect(result.password).toBe("phrase");
      expect(result.credentialType).toBe("key_passphrase");
      expect(result.namedCredentialId).toBe("nc-2");
    });

    it("never falls back to the per-connection secret when the named one is missing", async () => {
      mockedResolveNamed.mockResolvedValue(null);
      mockedResolveCredential.mockResolvedValue("stale-own");

      const result = await resolveConnectionCredential("conn-1", "password", true, "nc-gone");

      expect(mockedResolveCredential).not.toHaveBeenCalled();
      expect(result).toEqual({
        password: null,
        usedStoredCredential: false,
        credentialType: "password",
        namedCredentialId: "nc-gone",
      });
    });

    it("treats a store error as not found", async () => {
      mockedResolveNamed.mockRejectedValue(new Error("locked"));

      const result = await resolveConnectionCredential("conn-1", "password", false, "nc-1");

      expect(result.password).toBeNull();
      expect(result.usedStoredCredential).toBe(false);
      expect(result.namedCredentialId).toBe("nc-1");
    });

    it("ignores the reference for agent auth", async () => {
      const result = await resolveConnectionCredential("conn-3", "agent", false, "nc-1");

      expect(mockedResolveNamed).not.toHaveBeenCalled();
      expect(result.password).toBeNull();
      expect(result.namedCredentialId).toBeUndefined();
    });

    it("treats an empty reference as no reference", async () => {
      mockedResolveCredential.mockResolvedValue("own");

      const result = await resolveConnectionCredential("conn-1", "password", false, "");

      expect(mockedResolveNamed).not.toHaveBeenCalled();
      expect(result.password).toBe("own");
      expect(result.namedCredentialId).toBeUndefined();
    });
  });
});
