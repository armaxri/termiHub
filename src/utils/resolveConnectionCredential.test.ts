import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  resolveCredential: vi.fn(),
}));

import { resolveCredential } from "@/services/api";
import { resolveConnectionCredential } from "./resolveConnectionCredential";

const mockedResolveCredential = vi.mocked(resolveCredential);

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
});
