import { describe, it, expect } from "vitest";
import { classifyAgentError } from "./classifyAgentError";

describe("classifyAgentError", () => {
  it("classifies TCP/DNS failure as unreachable", () => {
    const result = classifyAgentError("SSH error: Connection failed: Connection refused");
    expect(result.category).toBe("unreachable");
    expect(result.title).toBe("Could Not Reach Host");
  });

  it("classifies password auth failure", () => {
    const result = classifyAgentError("SSH error: Password auth failed: Authentication failed");
    expect(result.category).toBe("auth-failure");
    expect(result.title).toBe("Authentication Failed");
  });

  it("classifies key auth failure", () => {
    const result = classifyAgentError("SSH error: Key auth failed: Unable to extract public key");
    expect(result.category).toBe("auth-failure");
  });

  it("classifies agent auth failure", () => {
    const result = classifyAgentError("SSH error: Agent auth failed: Agent failure");
    expect(result.category).toBe("auth-failure");
  });

  it("classifies bare Authentication failed", () => {
    const result = classifyAgentError("SSH error: Authentication failed");
    expect(result.category).toBe("auth-failure");
  });

  it("classifies exec failure as agent-missing", () => {
    const result = classifyAgentError("Remote agent error: Exec failed: No such file");
    expect(result.category).toBe("agent-missing");
    expect(result.title).toBe("Agent Not Installed");
  });

  it("classifies read initialize failure as agent-missing", () => {
    const result = classifyAgentError("Remote agent error: Read initialize response: EOF");
    expect(result.category).toBe("agent-missing");
  });

  it("classifies write initialize failure as agent-missing", () => {
    const result = classifyAgentError("Remote agent error: Write initialize failed: broken pipe");
    expect(result.category).toBe("agent-missing");
  });

  it("classifies initialize rejected as agent-outdated", () => {
    const result = classifyAgentError(
      "Remote agent error: Initialize rejected: Invalid initialize params: missing field `protocolVersion`"
    );
    expect(result.category).toBe("agent-outdated");
    expect(result.title).toBe("Agent Version Incompatible");
  });

  it("classifies unsupported protocol version as agent-outdated", () => {
    const result = classifyAgentError(
      "Remote agent error: Initialize rejected: Unsupported protocol version: 1.0.0 (agent supports 0.x)"
    );
    expect(result.category).toBe("agent-outdated");
  });

  it("classifies already-connected error", () => {
    const result = classifyAgentError(
      "Remote agent error: Agent agent-1776461038114 is already connected"
    );
    expect(result.category).toBe("already-connected");
    expect(result.title).toBe("Already Connected");
  });

  it("classifies unknown errors with raw message", () => {
    const result = classifyAgentError("Something unexpected");
    expect(result.category).toBe("unknown");
    expect(result.title).toBe("Connection Failed");
    expect(result.message).toBe("Something unexpected");
  });

  it("handles Error objects", () => {
    const result = classifyAgentError(new Error("SSH error: Connection failed: timeout"));
    expect(result.category).toBe("unreachable");
  });

  it("preserves raw error string", () => {
    const raw = "SSH error: Password auth failed: wrong password";
    const result = classifyAgentError(raw);
    expect(result.rawError).toBe(raw);
  });

  it("classifies a typed auth-failure code regardless of message language (I18N-001)", () => {
    const result = classifyAgentError("[thub-code:auth_failed] Authentifizierung fehlgeschlagen");
    expect(result.category).toBe("auth-failure");
    expect(result.title).toBe("Authentication Failed");
    // The machine marker is stripped from the raw error shown in the dialog.
    expect(result.rawError).toBe("Authentifizierung fehlgeschlagen");
    expect(result.rawError).not.toContain("thub-code");
  });

  // Marker-first classification (I18N-002 / ERR-003): a `[thub-code:<code>]`
  // marker classifies the error regardless of the human message language, and
  // the marker is always stripped from the displayed raw error.
  describe("typed code markers classify regardless of message language (I18N-002)", () => {
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

    it("falls back to substring matching when no marker is present", () => {
      // An uncoded/legacy error still classifies via the English substrings, so
      // nothing regresses if a marker is ever missing.
      expect(classifyAgentError("SSH error: Connection failed: refused").category).toBe(
        "unreachable"
      );
      expect(classifyAgentError("Remote agent error: Exec failed: nope").category).toBe(
        "agent-missing"
      );
      expect(classifyAgentError("Remote agent error: Initialize rejected: bad").category).toBe(
        "agent-outdated"
      );
      expect(classifyAgentError("Remote agent error: Agent x is already connected").category).toBe(
        "already-connected"
      );
    });

    it("ignores an unknown code marker and falls through to substrings", () => {
      // A future/unrecognized code must not be mistaken for a known category;
      // classification continues with the substring fallback.
      const result = classifyAgentError("[thub-code:some_future_code] Connection failed: refused");
      expect(result.category).toBe("unreachable");
    });
  });
});
