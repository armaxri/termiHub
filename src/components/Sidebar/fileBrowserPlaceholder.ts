import type { ConnectionTypeInfo } from "@/services/api";

/**
 * Why the File Browser has nothing to list (#5299, audit UX-019 / UI-019).
 *
 * The sidebar used to show "No filesystem available for this connection type"
 * for every reason it had no browser — including when no tab was open at all.
 * Each reason now gets its own copy:
 *
 * - `no-tab` — nothing (or a non-connection tab such as Settings) is active;
 *   the placeholder offers a New Terminal action.
 * - `unsupported` — the active connection's type has no file system; the copy
 *   names the type by its display label (e.g. "Serial connections have no file
 *   system").
 * - `disabled` — the type can browse files, but browsing is turned off for this
 *   connection (per-connection override or the global setting).
 * - `connecting` — the type can browse files, but the session is not up yet.
 * - `unavailable` — any other tab without a browser (e.g. a remote desktop whose
 *   "Browse remote files" side channel is not open).
 */
export type FileBrowserPlaceholder =
  | { kind: "no-tab" }
  | { kind: "unsupported"; typeLabel: string }
  | { kind: "disabled" }
  | { kind: "connecting" }
  | { kind: "unavailable" };

/** Copy for a {@link FileBrowserPlaceholder}, in sentence case. */
export function fileBrowserPlaceholderTitle(placeholder: FileBrowserPlaceholder): string {
  switch (placeholder.kind) {
    case "no-tab":
      return "Open a terminal or connection to browse its files";
    case "unsupported":
      return `${placeholder.typeLabel} connections have no file system`;
    case "disabled":
      return "File browsing is turned off for this connection";
    case "connecting":
      return "Waiting for the connection to open";
    case "unavailable":
      return "This tab has no file system to browse";
  }
}

/** Inputs to {@link resolveFileBrowserPlaceholder}: the active tab and its context. */
export interface FileBrowserPlaceholderInput {
  /** Whether any tab is active in this window. */
  hasActiveTab: boolean;
  /** The active tab's content type (`"terminal"`, `"settings"`, …). */
  contentType: string | null;
  /** The active tab's connection type id (`"serial"`, `"remote-session"`, …). */
  connectionType: string | null;
  /** The active tab's session id, once established. */
  sessionId: string | null;
  /** Whether file browsing is enabled for this tab's connection (override or global). */
  fileBrowserEnabled: boolean;
  /** Registered connection types, for capability + display-label lookup. */
  connectionTypes: ConnectionTypeInfo[];
  /**
   * For a `remote-session` tab: the agent's entry for the session's type, or
   * `undefined` when the agent (or its type) is unknown.
   */
  agentTypeInfo?: ConnectionTypeInfo;
}

/**
 * Decide which placeholder to show while the File Browser is in mode `"none"`.
 * Mirrors the branches of the mode-sync effect in `FileBrowser.tsx`; it is only
 * consulted when that effect resolved to `"none"`.
 */
export function resolveFileBrowserPlaceholder(
  input: FileBrowserPlaceholderInput
): FileBrowserPlaceholder {
  const { hasActiveTab, contentType, connectionType } = input;
  if (!hasActiveTab || contentType === "settings") return { kind: "no-tab" };
  if (contentType === "remote-desktop" || contentType === "editor") return { kind: "unavailable" };
  if (!connectionType) return { kind: "no-tab" };

  if (connectionType === "remote-session") {
    const info = input.agentTypeInfo;
    if (!info) return { kind: "unavailable" };
    if (!info.capabilities.fileBrowser) return { kind: "unsupported", typeLabel: info.displayName };
    return input.fileBrowserEnabled ? { kind: "unavailable" } : { kind: "disabled" };
  }

  const info = input.connectionTypes.find((ct) => ct.typeId === connectionType);
  if (info?.capabilities.fileBrowser) {
    if (!input.fileBrowserEnabled) return { kind: "disabled" };
    if (!input.sessionId) return { kind: "connecting" };
    return { kind: "unavailable" };
  }
  return { kind: "unsupported", typeLabel: info?.displayName ?? connectionType };
}
