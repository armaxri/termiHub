import { describe, it, expect } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message of an Error subclass", () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError("nope"))).toBe("nope");
  });

  it("returns a string value unchanged", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  it("stringifies non-Error, non-string values", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: 1 })).toBe("[object Object]");
  });

  it("returns the message of a structured backend error envelope", () => {
    // The object shape TerminalError now serializes to (ARCH-006 / TAURI-008).
    expect(
      errorMessage({ code: "auth_failed", message: "Authentication failed", details: null })
    ).toBe("Authentication failed");
  });

  it("stringifies an object whose message is not a string", () => {
    expect(errorMessage({ message: 42 })).toBe("[object Object]");
  });
});
