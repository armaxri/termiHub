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
});
