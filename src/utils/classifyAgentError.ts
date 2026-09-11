/**
 * Classifies a remote agent connection error into a user-friendly category.
 */

import { AUTH_FAILED_CODE, parseBackendError } from "@/utils/backendErrorCode";

/** The three specific error categories plus a generic fallback. */
export type AgentErrorCategory =
  | "unreachable"
  | "auth-failure"
  | "agent-missing"
  | "agent-outdated"
  | "already-connected"
  | "unknown";

export interface ClassifiedAgentError {
  category: AgentErrorCategory;
  title: string;
  message: string;
  rawError: string;
}

/** Classify a backend error string into a user-facing error. */
export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const parsed = parseBackendError(error);
  // Display the human message with any machine code marker stripped so a token
  // never leaks into the error dialog.
  const raw = parsed.message;

  // Prefer the typed, locale-independent auth signal (I18N-001): a genuine
  // credential rejection is identified by the backend code, not by matching
  // English text — so it stays correct under any locale or rewording. The
  // English substring below remains only as a fallback for legacy/uncoded
  // errors (the remaining non-auth categories are still text-matched — I18N-002).
  if (parsed.code === AUTH_FAILED_CODE) {
    return {
      category: "auth-failure",
      title: "Authentication Failed",
      message:
        "SSH authentication was rejected. Check your username, password, or SSH key configuration.",
      rawError: raw,
    };
  }

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

  if (raw.includes("Initialize rejected") || raw.includes("Unsupported protocol version")) {
    return {
      category: "agent-outdated",
      title: "Agent Version Incompatible",
      message:
        "The remote agent binary is not compatible with this version of termiHub. Please re-deploy the agent to update it.",
      rawError: raw,
    };
  }

  if (raw.includes("is already connected")) {
    return {
      category: "already-connected",
      title: "Already Connected",
      message:
        "This agent is already connected. You can force a reconnect to drop the existing connection and establish a new one.",
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
