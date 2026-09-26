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

/**
 * Upper bound on either framebuffer dimension, in pixels (mirrors Rust
 * `MAX_FRAMEBUFFER_DIMENSION`, MOCK-011). The backend frame pump already drops
 * frames above it; the canvas re-checks before sizing its offscreen buffer.
 */
export const MAX_FRAMEBUFFER_DIMENSION = 8192;

/** How the remote framebuffer fills the tab. */
export type ScaleMode = "fit" | "pixel" | "match";

// The core graphical DTOs are generated from their Rust source of truth
// (core/src/connection/graphical.rs) via ts-rs (audit DUP-030 / MOCK-010, ts-rs
// rollout #3088). `FrameUpdate`/`CursorUpdate`/`GraphicalSessionState` are also
// referenced within this file (the `extends` payloads, the state helpers), so
// they are imported locally and re-exported; `DirtyRect`/`CursorShape` are only
// consumed externally and are re-exported directly.
//
// `GraphicalSessionState` is the frontend's historical name for the Rust
// `GraphicalState` string union — the shared graphical-session lifecycle state
// the frontend renders overlays and the tab state-dot from.
import type { GraphicalState as GraphicalSessionState } from "./generated/GraphicalState";
import type { FrameUpdate } from "./generated/FrameUpdate";
import type { CursorUpdate } from "./generated/CursorUpdate";

export type { GraphicalSessionState, FrameUpdate, CursorUpdate };
export type { DirtyRect } from "./generated/DirtyRect";
export type { CursorShape } from "./generated/CursorShape";

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

/**
 * `remote-desktop-clipboard` event payload (remote → local text).
 *
 * Generated from the Rust `RemoteDesktopClipboardEvent` via ts-rs (MOCK-010,
 * ts-rs rollout #3088); re-exported under the historical `…Payload` name so
 * consumers stay unchanged.
 */
export type { RemoteDesktopClipboardEvent as RemoteDesktopClipboardPayload } from "./generated/RemoteDesktopClipboardEvent";

/**
 * One file the remote copied to its clipboard, surfaced to the host for a local
 * paste with delayed rendering (#1793/#1804). Mirrors the Rust
 * `RemoteClipboardFile` (camelCase). The bytes are not present — they are fetched
 * from the remote only on the actual paste gesture, keyed by {@link index}.
 */
export interface RemoteClipboardFile {
  /** Sanitized basename (no path separators). */
  name: string;
  /** Sanitized `/`-separated directory portion within the copied collection, or null for a top-level entry. */
  relativePath: string | null;
  /** File size when the remote advertised it; null means "resolve on fetch". */
  size: number | null;
  /** Whether this entry is a directory (no bytes to fetch). */
  isDir: boolean;
  /** Position in the remote's advertised file list — the opaque fetch token. */
  index: number;
}

/**
 * Dimensions of a remote-desktop clipboard image (PROD-021), mirroring the Rust
 * `ClipboardImageInfo`. The pixels never reach the webview — the backend moves
 * them between the session and the host OS clipboard itself.
 */
export interface ClipboardImageInfo {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Image-clipboard state the clipboard panel renders from (PROD-021). */
export interface ClipboardImageStatus {
  /** Whether the session's protocol bridges clipboard images (RDP yes, VNC no). */
  supported: boolean;
  /** The image the remote most recently copied, if any. */
  image: ClipboardImageInfo | null;
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
 *
 * Generated from the Rust `RemoteDesktopCertPromptEvent` via ts-rs (MOCK-010,
 * ts-rs rollout #3088); re-exported under the historical `…Payload` name so
 * consumers stay unchanged.
 */
export type { RemoteDesktopCertPromptEvent as RemoteDesktopCertPromptPayload } from "./generated/RemoteDesktopCertPromptEvent";

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
