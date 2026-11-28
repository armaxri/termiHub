/**
 * One wording for connection states (#6159, audit UX-023 / UX-029).
 *
 * The sidebar, tabs, the status bar, overlays and toasts all say a
 * connection's state with these words, so a dropped link reads the same
 * wherever it shows. The words live in the message catalog; this module is
 * the one way to reach them. `docs/copy-style.md` ("Connection states") is the
 * spec, and `connectionStateCopy.test.ts` fails when a surface types its own.
 *
 * Why a connect failed is not a state word: an agent row says it with
 * {@link agentFailureReason} (`src/components/Sidebar/agentFailureReason.ts`),
 * a terminal with its failure screen.
 */
import { t } from "@/i18n/catalog";

/** The states a connection or session can be in, as the user reads them. */
export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "ended"
  | "notConnected";

/** The states an overlay, banner or toast puts in its heading. */
export type ConnectionHeadingState = "connecting" | "reconnecting" | "failed" | "ended";

/** The verbs: one per state that offers something to do. */
export type ConnectionVerb = "connect" | "abort" | "retry" | "reconnect" | "stopReconnecting";

const WORD_IDS = {
  connecting: "connection.state.connecting",
  connected: "connection.state.connected",
  reconnecting: "connection.state.reconnecting",
  failed: "connection.state.failed",
  ended: "connection.state.ended",
  notConnected: "connection.state.notConnected",
} as const satisfies Record<ConnectionState, string>;

const HEADING_IDS = {
  connecting: "connection.heading.connecting",
  reconnecting: "connection.heading.reconnecting",
  failed: "connection.heading.failed",
  ended: "connection.heading.ended",
} as const satisfies Record<ConnectionHeadingState, string>;

const VERB_IDS = {
  connect: "connection.verb.connect",
  abort: "connection.verb.abort",
  retry: "connection.verb.retry",
  reconnect: "connection.verb.reconnect",
  stopReconnecting: "connection.verb.stopReconnecting",
} as const satisfies Record<ConnectionVerb, string>;

const VERB_FOR_STATE: Record<ConnectionState, ConnectionVerb | null> = {
  connecting: "abort",
  connected: null,
  reconnecting: "stopReconnecting",
  failed: "retry",
  ended: "reconnect",
  notConnected: "connect",
};

/** The state's word, for a status dot, a tooltip or an accessible name. */
export function connectionStateWord(state: ConnectionState): string {
  return t(WORD_IDS[state]);
}

/** The heading an overlay, banner or toast shows while the state lasts. */
export function connectionStateHeading(state: ConnectionHeadingState): string {
  return t(HEADING_IDS[state]);
}

/** A verb's label. */
export function connectionVerb(verb: ConnectionVerb): string {
  return t(VERB_IDS[verb]);
}

/** The one verb a state offers, or `null` when there is nothing to do. */
export function verbForState(state: ConnectionState): ConnectionVerb | null {
  return VERB_FOR_STATE[state];
}

/**
 * Words the app no longer uses for a state (#6159): a drop is "Reconnecting…"
 * while it is retried and "Session ended" after; an agent that went down reads
 * "Connection failed". `connectionStateCopy.test.ts` keeps them out of `src/`.
 */
export const RETIRED_CONNECTION_STATE_WORDS = [
  "Connection lost",
  "Connection lost — reconnecting…",
  "Disconnected",
  "Session disconnected",
] as const;

/**
 * The files that show a connection's state, relative to `src/`. Each takes its
 * words from this module; the test checks that every one imports it.
 */
export const CONNECTION_STATE_SURFACES = [
  // Sidebar
  "components/Sidebar/AgentNode.tsx",
  "components/Sidebar/ConnectionPathDialog.tsx",
  // Tabs and the terminal's overlays
  "components/Terminal/Tab.tsx",
  "components/Terminal/TerminalConnectionOverlay.tsx",
  "components/Terminal/TerminalReconnectStrip.tsx",
  "components/Terminal/TerminalDisconnectOverlay.tsx",
  "components/Terminal/TerminalViewModeBanner.tsx",
  "components/Terminal/ConnectFailure.tsx",
  "components/Terminal/AgentErrorTab.tsx",
  "components/Terminal/FileBrowserTab.tsx",
  "components/Terminal/dropCopy.ts",
  "components/ui/ConnectProgress.tsx",
  "components/RemoteDesktop/RemoteDesktopOverlay.tsx",
  // Status bar
  "components/StatusBar/StatusBar.tsx",
  // Toasts and the labels behind dots
  "utils/connectSavedConnection.ts",
  "components/ConnectionEditor/ConnectionEditor.tsx",
  "utils/classifyAgentError.ts",
  "utils/statusLabel.ts",
  "utils/reconnectStatus.ts",
  "themes/colorTokens.ts",
  "components/Automations/RunTargetsDialog.tsx",
] as const;
