export type SessionId = string;

export type ShellType = "zsh" | "bash" | "cmd" | "powershell" | "gitbash" | `wsl:${string}`;

export type ConnectionType =
  | "local"
  | "ssh"
  | "telnet"
  | "serial"
  | "remote"
  | "remote-session"
  | "docker"
  | (string & {});

export type TabContentType =
  | "terminal"
  | "settings"
  | "editor"
  | "connection-editor"
  | "log-viewer"
  | "tunnel-editor";

export interface EditorTabMeta {
  filePath: string;
  isRemote: boolean;
  sftpSessionId?: string;
}

export interface ConnectionEditorMeta {
  connectionId: string;
  folderId: string | null;
}

export interface TunnelEditorMeta {
  tunnelId: string | null;
}

export interface TerminalOptions {
  horizontalScrolling?: boolean;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
}

/** SSH transport configuration for a remote agent (no session details). */
export interface RemoteAgentConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
  savePassword?: boolean;
  /** Path to the agent binary on the remote host (default: ~/.local/bin/termihub-agent). */
  agentPath?: string;
}

/** Key-value pair for Docker environment variables. */
export interface EnvVar {
  key: string;
  value: string;
}

/** Host-to-container volume mount. */
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/**
 * Generic connection configuration for saved connections.
 * The `type` field identifies the connection type (e.g. "ssh", "local"),
 * and `config` holds type-specific settings as unstructured key-value pairs.
 */
export interface ConnectionConfig {
  type: string;
  config: Record<string, unknown>;
}

export interface TerminalTab {
  id: string;
  sessionId: SessionId | null;
  title: string;
  connectionType: ConnectionType;
  contentType: TabContentType;
  config: ConnectionConfig;
  panelId: string;
  isActive: boolean;
  editorMeta?: EditorTabMeta;
  connectionEditorMeta?: ConnectionEditorMeta;
  tunnelEditorMeta?: TunnelEditorMeta;
}

export interface LeafPanel {
  type: "leaf";
  id: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
}

export interface SplitContainer {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: PanelNode[];
}

export type PanelNode = LeafPanel | SplitContainer;
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export interface LanguageInfo {
  id: string;
  name: string;
}

export interface EditorStatus {
  line: number;
  column: number;
  language: string;
  availableLanguages: LanguageInfo[];
  eol: "LF" | "CRLF";
  tabSize: number;
  insertSpaces: boolean;
  encoding: string;
}

export interface EditorActions {
  setIndent: (tabSize: number, insertSpaces: boolean) => void;
  toggleEol: () => void;
  setLanguage: (languageId: string) => void;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}
