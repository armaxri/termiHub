import { describe, it, expect } from "vitest";
import {
  AUTH_FAILED_CODE,
  parseBackendError,
  isAuthFailure,
  backendErrorMessage,
} from "./backendErrorCode";

describe("backendErrorCode", () => {
  it("extracts the code and strips the marker for display", () => {
    const parsed = parseBackendError("[thub-code:auth_failed] Authentication failed");
    expect(parsed.code).toBe(AUTH_FAILED_CODE);
    expect(parsed.message).toBe("Authentication failed");
  });

  it("reads the marker from an Error's message", () => {
    const parsed = parseBackendError(new Error("[thub-code:auth_failed] boom"));
    expect(parsed.code).toBe(AUTH_FAILED_CODE);
    expect(parsed.message).toBe("boom");
  });

  it("returns no code and the raw message when unmarked", () => {
    const parsed = parseBackendError("SSH error: Connection failed: timed out");
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toBe("SSH error: Connection failed: timed out");
  });

  it("detects auth failure regardless of the human message language", () => {
    // A localized / reworded remote message that no English substring test
    // would match — the typed code still identifies it (I18N-001).
    expect(isAuthFailure("[thub-code:auth_failed] Authentifizierung fehlgeschlagen")).toBe(true);
    expect(isAuthFailure("[thub-code:auth_failed] 認証に失敗しました")).toBe(true);
  });

  it("does NOT report auth failure for a non-auth error, even one mentioning auth", () => {
    // The inverse mis-fire I18N-001 warns about: a transport error whose text
    // happens to contain "auth failed" must never be treated as a rejection.
    expect(isAuthFailure("SSH error: ssh-agent auth failed: broken pipe")).toBe(false);
    expect(isAuthFailure("SSH error: Password auth failed: connection reset")).toBe(false);
    expect(isAuthFailure(new Error("Authentication failed"))).toBe(false);
  });

  it("strips the marker for display messages", () => {
    expect(backendErrorMessage("[thub-code:auth_failed] Authentication failed")).toBe(
      "Authentication failed"
    );
    expect(backendErrorMessage("plain message")).toBe("plain message");
  });

  describe("structured envelope (ARCH-006 / TAURI-008)", () => {
    it("reads the code and message from the structured object shape", () => {
      const parsed = parseBackendError({
        code: "auth_failed",
        message: "Authentication failed",
        details: null,
      });
      expect(parsed.code).toBe(AUTH_FAILED_CODE);
      expect(parsed.message).toBe("Authentication failed");
    });

    it("takes the envelope message verbatim (backend already stripped the marker)", () => {
      const parsed = parseBackendError({
        code: "unreachable",
        message: "Connection failed: Connection refused",
      });
      expect(parsed.code).toBe("unreachable");
      expect(parsed.message).toBe("Connection failed: Connection refused");
      expect(parsed.message).not.toContain("[thub-code:");
    });

    it("detects auth failure from the object shape regardless of language", () => {
      expect(
        isAuthFailure({ code: "auth_failed", message: "Authentifizierung fehlgeschlagen" })
      ).toBe(true);
    });

    it("does not misread a plain Error carrying a message as a structured envelope", () => {
      // An Error has a string `message` but no string `code`, so it stays on the
      // legacy path and its marker is parsed from the message text.
      const parsed = parseBackendError(new Error("[thub-code:auth_failed] boom"));
      expect(parsed.code).toBe(AUTH_FAILED_CODE);
      expect(parsed.message).toBe("boom");
    });

    it("exposes the display message for the object shape via backendErrorMessage", () => {
      expect(
        backendErrorMessage({ code: "spawn_failed", message: "Failed to spawn terminal: x" })
      ).toBe("Failed to spawn terminal: x");
    });
  });
});
