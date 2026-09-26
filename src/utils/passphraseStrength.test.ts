import { describe, it, expect } from "vitest";
import { MIN_EXPORT_PASSPHRASE_LENGTH, ratePassphrase } from "./passphraseStrength";

describe("ratePassphrase", () => {
  it("flags anything below the minimum length as too short", () => {
    expect(ratePassphrase("a".repeat(MIN_EXPORT_PASSPHRASE_LENGTH - 1)).strength).toBe("tooShort");
    expect(ratePassphrase("").strength).toBe("tooShort");
  });

  it("rates repeated characters as weak even when long enough", () => {
    expect(ratePassphrase("aaaaaaaaaaaaaaaa").strength).toBe("weak");
  });

  it("rates a minimum-length single-class passphrase as weak", () => {
    expect(ratePassphrase("abcdefghijkl").strength).toBe("weak");
  });

  it("rates a mixed or longer passphrase as fair", () => {
    expect(ratePassphrase("Abcdefghijk1").strength).toBe("fair");
    expect(ratePassphrase("abcdefghijklmn").strength).toBe("fair");
  });

  it("rates a long multi-word passphrase as strong", () => {
    expect(ratePassphrase("correct horse battery staple").strength).toBe("strong");
  });

  it("always returns a hint", () => {
    for (const value of ["", "short", "abcdefghijkl", "correct horse battery staple"]) {
      expect(ratePassphrase(value).hint.length).toBeGreaterThan(0);
    }
  });
});
