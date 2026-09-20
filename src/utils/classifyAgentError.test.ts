import { describe, it, expect } from "vitest";
import { classifyAgentError } from "./classifyAgentError";

describe("classifyAgentError", () => {
  // Code-driven classification (ARCH-006 / TAURI-008 / ERR-008 Phase 3): every
  // agent-connect error the backend produces for these categories carries a
  // stable, locale-independent `IpcErrorCode`, so classification keys off the
  // code alone — no English-substring sniffing.

  // The structured IPC error envelope `{ code, message, details }` is the shape
  // `TerminalError` serializes to. Each category classifies purely by its code,
  // and the human `message` is surfaced verbatim as `rawError`.
  describe("classifies the structured envelope by code", () => {
    const cases: Array<{
      code: string;
      category: string;
      title: string;
      // A localized/reworded message no English substring test would match.
      localized: string;
    }> = [
      {
        code: "unreachable",
        category: "unreachable",
        title: "Could Not Reach Host",
        localized: "Verbindung fehlgeschlagen: Zeitüberschreitung",
      },
      {
        code: "auth_failed",
        category: "auth-failure",
        title: "Authentication Failed",
        localized: "認証に失敗しました",
      },
      {
        code: "agent_missing",
        category: "agent-missing",
        title: "Agent Not Installed",
        localized: "Ausführung fehlgeschlagen: Datei nicht gefunden",
      },
      {
        code: "agent_outdated",
        category: "agent-outdated",
        title: "Agent Version Incompatible",
        localized: "Initialisierung abgelehnt: nicht unterstützte Version",
      },
      {
        code: "already_connected",
        category: "already-connected",
        title: "Already Connected",
        localized: "エージェントは既に接続されています",
      },
    ];

    it.each(cases)("maps { code: $code } to $category", ({ code, category, title, localized }) => {
      const result = classifyAgentError({ code, message: localized, details: null });
      expect(result.category).toBe(category);
      expect(result.title).toBe(title);
      expect(result.rawError).toBe(localized);
    });
  });

  // The legacy flat string `[thub-code:<code>] <message>` is still read via the
  // dual-read parser, so classification is identical to the envelope form and
  // the marker is always stripped from the displayed raw error.
  describe("classifies the legacy string marker by code", () => {
    const cases: Array<{ code: string; category: string; title: string; localized: string }> = [
      {
        code: "unreachable",
        category: "unreachable",
        title: "Could Not Reach Host",
        localized: "Verbindung fehlgeschlagen: Zeitüberschreitung",
      },
      {
        code: "auth_failed",
        category: "auth-failure",
        title: "Authentication Failed",
        localized: "認証に失敗しました",
      },
      {
        code: "agent_missing",
        category: "agent-missing",
        title: "Agent Not Installed",
        localized: "Ausführung fehlgeschlagen: Datei nicht gefunden",
      },
      {
        code: "agent_outdated",
        category: "agent-outdated",
        title: "Agent Version Incompatible",
        localized: "Initialisierung abgelehnt: nicht unterstützte Version",
      },
      {
        code: "already_connected",
        category: "already-connected",
        title: "Already Connected",
        localized: "エージェントは既に接続されています",
      },
    ];

    it.each(cases)(
      "maps [thub-code:$code] to $category",
      ({ code, category, title, localized }) => {
        const result = classifyAgentError(`[thub-code:${code}] ${localized}`);
        expect(result.category).toBe(category);
        expect(result.title).toBe(title);
        // The marker is stripped from the raw error shown in the dialog.
        expect(result.rawError).toBe(localized);
        expect(result.rawError).not.toContain("thub-code");
      }
    );

    it("wraps the real backend ConnectionFailed rendering (marker mid-message)", () => {
      // TerminalError::ConnectionFailed renders "Connection failed: [marker] {e}".
      const result = classifyAgentError(
        "Connection failed: [thub-code:unreachable] Connection refused (os error 111)"
      );
      expect(result.category).toBe("unreachable");
      expect(result.rawError).not.toContain("thub-code");
    });
  });

  it("classifies a typed auth-failure code regardless of message language (I18N-001)", () => {
    const result = classifyAgentError("[thub-code:auth_failed] Authentifizierung fehlgeschlagen");
    expect(result.category).toBe("auth-failure");
    expect(result.title).toBe("Authentication Failed");
    // The machine marker is stripped from the raw error shown in the dialog.
    expect(result.rawError).toBe("Authentifizierung fehlgeschlagen");
    expect(result.rawError).not.toContain("thub-code");
  });

  it("preserves the raw (marker-stripped) message for display", () => {
    const result = classifyAgentError({
      code: "auth_failed",
      message: "Authentication failed",
      details: null,
    });
    expect(result.rawError).toBe("Authentication failed");
  });

  it("handles Error objects carrying a legacy marker", () => {
    const result = classifyAgentError(
      new Error("Connection failed: [thub-code:unreachable] timeout")
    );
    expect(result.category).toBe("unreachable");
  });

  // Now that every producer emits a code, an error carrying no recognized code
  // is the only path to "unknown": it surfaces the raw message under a generic
  // title rather than being guessed at from English substrings.
  describe("uncoded / unrecognized errors fall through to unknown", () => {
    it("classifies an uncoded plain string as unknown", () => {
      const result = classifyAgentError("Something unexpected");
      expect(result.category).toBe("unknown");
      expect(result.title).toBe("Connection Failed");
      expect(result.message).toBe("Something unexpected");
      expect(result.rawError).toBe("Something unexpected");
    });

    it("does NOT guess a category from English substrings (fallback retired)", () => {
      // These strings would have been substring-matched before Phase 3; with the
      // fallback retired an uncoded error is classified as unknown, never guessed.
      expect(classifyAgentError("SSH error: Connection failed: refused").category).toBe("unknown");
      expect(classifyAgentError("SSH error: Password auth failed: nope").category).toBe("unknown");
      expect(classifyAgentError("Remote agent error: Exec failed: nope").category).toBe("unknown");
      expect(classifyAgentError("Remote agent error: Initialize rejected: bad").category).toBe(
        "unknown"
      );
      expect(classifyAgentError("Remote agent error: Agent x is already connected").category).toBe(
        "unknown"
      );
    });

    it("classifies an unrecognized (future) code as unknown", () => {
      // A code that is not one of the classified categories must not be forced
      // into one — it falls through to the generic unknown default.
      const result = classifyAgentError({
        code: "internal_error",
        message: "boom",
        details: null,
      });
      expect(result.category).toBe("unknown");
      expect(result.title).toBe("Connection Failed");
      expect(result.message).toBe("boom");
    });

    it("classifies an unknown code marker as unknown", () => {
      const result = classifyAgentError("[thub-code:some_future_code] Connection failed: refused");
      expect(result.category).toBe("unknown");
      // The marker is still stripped from the displayed message.
      expect(result.rawError).not.toContain("thub-code");
    });
  });
});
