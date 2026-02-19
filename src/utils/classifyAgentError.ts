/**
 * Classifies a remote agent connection error into a user-friendly category.
 */

/** The three specific error categories plus a generic fallback. */
export type AgentErrorCategory = "unreachable" | "auth-failure" | "agent-missing" | "unknown";

export interface ClassifiedAgentError {
  category: AgentErrorCategory;
  title: string;
  message: string;
  rawError: string;
}

/** Classify a backend error string into a user-facing error. */
export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes("Connection failed")) {
    return {
      category: "unreachable",
      title: "Could Not Reach Host",
      message:
        "The host could not be reached. Check that the hostname, port, and network connection are correct.",
      rawError: raw,
    };
  }

  if (raw.toLowerCase().includes("auth failed") || raw.includes("Authentication failed")) {
    return {
      category: "auth-failure",
      title: "Authentication Failed",
      message:
        "SSH authentication was rejected. Check your username, password, or SSH key configuration.",
      rawError: raw,
    };
  }

  if (
    raw.includes("Exec failed") ||
    raw.includes("Read initialize response") ||
    raw.includes("Write initialize failed")
  ) {
    return {
      category: "agent-missing",
      title: "Agent Not Installed",
      message:
        "SSH connected successfully, but the termihub-agent binary could not be started on the remote host.",
      rawError: raw,
    };
  }

  return {
    category: "unknown",
    title: "Connection Failed",
    message: raw,
    rawError: raw,
  };
}
