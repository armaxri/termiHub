/**
 * Types for the protocol-agnostic graphical remote-desktop session layer (#1680).
 *
 * These mirror the Rust `core::connection::graphical` types and the
 * `remote-desktop-*` Tauri event payloads. The whole frontend surface (canvas,
 * toolbar, overlays, input pipeline) is protocol-blind — VNC (#1681) and RDP
 * (#1682) both drive it through these same generic types.
 */

/** Maximum automatic reconnect attempts (mirrors Rust `MAX_RECONNECT_ATTEMPTS`). */
export const MAX_RECONNECT_ATTEMPTS = 3;

/** How the remote framebuffer fills the tab. */
export type ScaleMode = "fit" | "pixel" | "match";

/**
 * The shared graphical-session lifecycle state (matches Rust `GraphicalState`,
 * serialized camelCase). The frontend renders overlays and the tab state-dot
 * purely from this.
 */
export type GraphicalSessionState =
  | "connecting"
  | "authenticating"
  | "active"
  | "resizing"
  | "disconnected"
  | "reconnecting"
  | "serverClosed"
  | "authFailed"
  | "connectFailed"
  | "closed";

/** A decoded dirty rectangle: tightly-packed RGBA (`width*height*4`) at (x,y). */
export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA bytes; reconstructed into an `ImageData` for a canvas blit. */
  data: number[];
}

/** A framebuffer update: full dimensions plus the changed rectangles. */
export interface FrameUpdate {
  width: number;
  height: number;
  rects: DirtyRect[];
}

/** An RGBA cursor bitmap with hotspot. */
export interface CursorShape {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  data: number[];
}

/** A cursor position / shape update. */
export interface CursorUpdate {
  x: number;
  y: number;
  visible: boolean;
  shape?: CursorShape;
}

/**
 * A protocol-agnostic input event sent to the backend (matches Rust
 * `InputEvent`, tagged by `kind`). Pointer coordinates are already
 * reverse-scaled to framebuffer pixels before being sent.
 */
export type RemoteDesktopInput =
  | { kind: "key"; code: string; pressed: boolean }
  | { kind: "pointer"; x: number; y: number; buttons: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number };

/** `remote-desktop-frame` event payload (snake_case session id on the wire). */
export interface RemoteDesktopFramePayload extends FrameUpdate {
  session_id: string;
}

/** `remote-desktop-cursor` event payload. */
export interface RemoteDesktopCursorPayload extends CursorUpdate {
  session_id: string;
}

/** `remote-desktop-clipboard` event payload (remote → local text). */
export interface RemoteDesktopClipboardPayload {
  session_id: string;
  text: string;
}

/** `remote-desktop-state` event payload. */
export interface RemoteDesktopStatePayload {
  session_id: string;
  state: GraphicalSessionState;
  reconnect_attempt: number;
  message?: string;
}

/**
 * `remote-desktop-cert-prompt` event payload (#1767): the server presented an
 * untrusted certificate and needs an interactive trust decision. `changed`
 * distinguishes first contact (`false`) from a *changed* fingerprint for a
 * previously-trusted host (`true`) — the possible-MITM case the dialog warns
 * about prominently.
 */
export interface RemoteDesktopCertPromptPayload {
  session_id: string;
  host: string;
  fingerprint: string;
  subject?: string;
  issuer?: string;
  changed: boolean;
}

/** Whether a state means the session is painting (or about to). */
export function isLiveState(state: GraphicalSessionState): boolean {
  return state === "active" || state === "resizing";
}

/** Whether a state is terminal (no further transitions). */
export function isTerminalState(state: GraphicalSessionState): boolean {
  return state === "closed" || state === "serverClosed" || state === "connectFailed";
}

/** Human-readable label for a scale mode (for the toolbar menu). */
export const SCALE_MODE_LABELS: Record<ScaleMode, string> = {
  fit: "Fit to Tab",
  pixel: "1:1 Pixel",
  match: "Match Window",
};
