import { SessionId } from "./terminal";

export interface TerminalOutputEvent {
  sessionId: SessionId;
  data: Uint8Array;
}

export interface TerminalExitEvent {
  sessionId: SessionId;
  exitCode: number | null;
}

export interface TerminalResizeEvent {
  sessionId: SessionId;
  cols: number;
  rows: number;
}
