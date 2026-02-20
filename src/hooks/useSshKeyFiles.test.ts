import { describe, it, expect } from "vitest";
import { isBlockedFile } from "./useSshKeyFiles";

describe("useSshKeyFiles", () => {
  describe("isBlockedFile", () => {
    it("blocks .pub files", () => {
      expect(isBlockedFile("id_ed25519.pub")).toBe(true);
      expect(isBlockedFile("id_rsa.pub")).toBe(true);
    });

    it("blocks known_hosts and related files", () => {
      expect(isBlockedFile("known_hosts")).toBe(true);
      expect(isBlockedFile("known_hosts.old")).toBe(true);
    });

    it("blocks authorized_keys variants", () => {
      expect(isBlockedFile("authorized_keys")).toBe(true);
      expect(isBlockedFile("authorized_keys2")).toBe(true);
    });

    it("blocks config and environment", () => {
      expect(isBlockedFile("config")).toBe(true);
      expect(isBlockedFile("environment")).toBe(true);
    });

    it("blocks .old, .bak, and .log extensions", () => {
      expect(isBlockedFile("id_rsa.old")).toBe(true);
      expect(isBlockedFile("id_rsa.bak")).toBe(true);
      expect(isBlockedFile("debug.log")).toBe(true);
    });

    it("blocks extensions case-insensitively", () => {
      expect(isBlockedFile("key.PUB")).toBe(true);
      expect(isBlockedFile("key.Bak")).toBe(true);
    });

    it("allows valid key files", () => {
      expect(isBlockedFile("id_ed25519")).toBe(false);
      expect(isBlockedFile("id_rsa")).toBe(false);
      expect(isBlockedFile("id_ecdsa")).toBe(false);
      expect(isBlockedFile("my_server_key")).toBe(false);
    });

    it("allows key files with non-blocked extensions", () => {
      expect(isBlockedFile("id_ed25519-cert")).toBe(false);
      expect(isBlockedFile("work_key")).toBe(false);
    });
  });
});
