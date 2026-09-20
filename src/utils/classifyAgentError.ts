/**
 * Classifies a remote agent connection error into a user-friendly category.
 */

import type { IpcErrorCode } from "@/types/generated/IpcErrorCode";
import { AUTH_FAILED_CODE, parseBackendError } from "@/utils/backendErrorCode";

/** The specific error categories plus a generic fallback. */
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
 * or removal on the backend is a compile error here rather than silent drift —
 * the map is type-checked against the generated enum, not a hand-kept mirror.
 * Classifying by these codes (rather than by matching English message text) is
 * what makes the outcome correct under any locale or rewording (I18N-002 /
 * ERR-003 / ARCH-006 / TAURI-008).
 */
const CODE_TO_CATEGORY: Partial<Record<IpcErrorCode, Exclude<AgentErrorCategory, "unknown">>> = {
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

/**
 * Classify a backend agent-connect error into a user-facing error.
 *
 * Classification is purely code-driven (ARCH-006 / TAURI-008 / ERR-008 Phase 3):
 * every agent-connect error the backend produces for these categories now
 * carries a stable, locale-independent {@link IpcErrorCode} — auth rejections
 * (`auth_failed`), a host that could not be reached (`unreachable`), a missing
 * agent binary (`agent_missing`), a protocol-incompatible agent
 * (`agent_outdated`), and an already-connected agent (`already_connected`). The
 * former English-substring sniffing fallback has been retired now that all
 * producers emit codes; an error carrying no recognized code falls through to a
 * generic "unknown" that surfaces the raw message rather than guessing.
 */
export function classifyAgentError(error: unknown): ClassifiedAgentError {
  const parsed = parseBackendError(error);
  // Display the human message with any machine code marker stripped so a token
  // never leaks into the error dialog.
  const raw = parsed.message;

  if (parsed.code) {
    // `parsed.code` is an arbitrary backend slug; only the recognized
    // IpcErrorCode categories resolve, others fall through to "unknown".
    const category = CODE_TO_CATEGORY[parsed.code as IpcErrorCode];
    if (category) {
      return { category, ...CATEGORY_PRESENTATION[category], rawError: raw };
    }
  }

  return {
    category: "unknown",
    title: "Connection Failed",
    message: raw,
    rawError: raw,
  };
}
