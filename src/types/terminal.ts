export type SessionId = string;

export type ShellType = "zsh" | "bash" | "cmd" | "powershell" | "gitbash" | `wsl:${string}`;

export type ConnectionType = "local" | "ssh" | "telnet" | "serial" | "remote";

export type TabContentType = "terminal" | "settings" | "editor" | "connection-editor";

export interface EditorTabMeta {
  filePath: string;
  isRemote: boolean;
  sftpSessionId?: string;
}

export interface ConnectionEditorMeta {
  connectionId: string;
  folderId: string | null;
}

export interface TerminalOptions {
  horizontalScrolling?: boolean;
  color?: string;
}

export interface LocalShellConfig {
  shellType: ShellType;
  initialCommand?: string;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
  enableX11Forwarding?: boolean;
}

export interface TelnetConfig {
  host: string;
  port: number;
}

export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "odd" | "even";
  flowControl: "none" | "hardware" | "software";
}

export interface RemoteConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
  sessionType: "shell" | "serial";
  shell?: string;
  serialPort?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "odd" | "even";
  flowControl?: "none" | "hardware" | "software";
  title?: string;
}

export type ConnectionConfig =
  | { type: "local"; config: LocalShellConfig }
  | { type: "ssh"; config: SshConfig }
  | { type: "telnet"; config: TelnetConfig }
  | { type: "serial"; config: SerialConfig }
  | { type: "remote"; config: RemoteConfig };

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
