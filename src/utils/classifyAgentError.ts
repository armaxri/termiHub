/**
 * Classifies a remote agent connection error into a user-friendly category.
 */

import type { IpcErrorCode } from "@/types/generated/IpcErrorCode";
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

/**
 * Locale-independent backend error-code slugs mapped to their frontend category.
 * The keys are typed against the ts-rs-generated {@link IpcErrorCode} (the Rust
 * single source of truth in `src-tauri/src/utils/errors.rs`), so a slug rename
 * or removal on the backend is a compile error here rather than silent drift.
 * Classifying by these codes (rather than by matching English message text) is
 * what makes the outcome correct under any locale or rewording (I18N-002 /
 * ERR-003).
 */
const CODE_TO_CATEGORY: Partial<Record<IpcErrorCode, AgentErrorCategory>> = {
  [AUTH_FAILED_CODE]: "auth-failure",
  unreachable: "unreachable",
  agent_missing: "agent-missing",
  agent_outdated: "agent-outdated",
  already_connected: "already-connected",
};

/** Static per-category presentation (title + user-facing message). */
const CATEGORY_PRESENTATION: Record<
  Exclude<AgentErrorCategory, "unknown">,
  { title: string; message: string }
> = {
  unreachable: {
    title: "Could Not Reach Host",
    message:
      "The host could not be reached. Check that the hostname, port, and network connection are correct.",
  },
  "auth-failure": {
    title: "Authentication Failed",
    message:
      "SSH authentication was rejected. Check your username, password, or SSH key configuration.",
  },
  "agent-missing": {
    title: "Agent Not Installed",
    message:
      "SSH connected successfully, but the termihub-agent binary could not be started on the remote host.",
  },
  "agent-outdated": {
    title: "Agent Version Incompatible",
    message:
      "The remote agent binary is not compatible with this version of termiHub. Please re-deploy the agent to update it.",
  },
  "already-connected": {
    title: "Already Connected",
    message:
      "This agent is already connected. You can force a reconnect to drop the existing connection and establish a new one.",
  },
};

/** Classify a backend error string into a user-facing error. */
export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const parsed = parseBackendError(error);
  // Display the human message with any machine code marker stripped so a token
  // never leaks into the error dialog.
  const raw = parsed.message;

  // Prefer the typed, locale-independent code marker (I18N-002 / ERR-003): the
  // backend tags each connection/agent error with a stable `[thub-code:<code>]`
  // marker, so classification stays correct under any locale or rewording. The
  // English substring checks below remain only as a fallback for legacy/uncoded
  // errors, so no existing input regresses if a marker is ever missing.
  if (parsed.code) {
    // `parsed.code` is an arbitrary backend slug; only the recognized
    // IpcErrorCode categories resolve, others fall through to the substring path.
    const category = CODE_TO_CATEGORY[parsed.code as IpcErrorCode];
    if (category && category !== "unknown") {
      return { category, ...CATEGORY_PRESENTATION[category], rawError: raw };
    }
  }

  if (raw.includes("Connection failed")) {
    return { category: "unreachable", ...CATEGORY_PRESENTATION.unreachable, rawError: raw };
  }

  if (raw.toLowerCase().includes("auth failed") || raw.includes("Authentication failed")) {
    return { category: "auth-failure", ...CATEGORY_PRESENTATION["auth-failure"], rawError: raw };
  }

  if (
    raw.includes("Exec failed") ||
    raw.includes("Read initialize response") ||
    raw.includes("Write initialize failed")
  ) {
    return { category: "agent-missing", ...CATEGORY_PRESENTATION["agent-missing"], rawError: raw };
  }

  if (raw.includes("Initialize rejected") || raw.includes("Unsupported protocol version")) {
    return {
      category: "agent-outdated",
      ...CATEGORY_PRESENTATION["agent-outdated"],
      rawError: raw,
    };
  }

  if (raw.includes("is already connected")) {
    return {
      category: "already-connected",
      ...CATEGORY_PRESENTATION["already-connected"],
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
