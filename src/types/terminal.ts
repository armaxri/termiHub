export type SessionId = string;

export type ShellType = "zsh" | "bash" | "cmd" | "powershell" | "gitbash" | `wsl:${string}`;

export type ConnectionType =
  | "local"
  | "ssh"
  | "telnet"
  | "serial"
  | "remote"
  | "remote-session"
  | "docker";

export type TabContentType =
  | "terminal"
  | "settings"
  | "editor"
  | "connection-editor"
  | "log-viewer";

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
  startingDirectory?: string;
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

/** SSH transport configuration for a remote agent (no session details). */
export interface RemoteAgentConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
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

/** Configuration for a Docker container shell. */
export interface DockerConfig {
  image: string;
  shell?: string;
  envVars: EnvVar[];
  volumes: VolumeMount[];
  workingDirectory?: string;
  removeOnExit: boolean;
}

/** Session configuration for a session running on a remote agent. */
export interface RemoteSessionConfig {
  agentId: string;
  sessionType: "shell" | "serial" | "docker" | "ssh";
  shell?: string;
  serialPort?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "odd" | "even";
  flowControl?: "none" | "hardware" | "software";
  title?: string;
  /** Whether this session survives reconnection (re-attach vs recreate). */
  persistent: boolean;
  /** Docker image name (for docker session type). */
  dockerImage?: string;
  /** Docker environment variables (for docker session type). */
  dockerEnvVars?: EnvVar[];
  /** Docker volume mounts (for docker session type). */
  dockerVolumes?: VolumeMount[];
  /** Docker working directory (for docker session type). */
  dockerWorkingDirectory?: string;
  /** Remove Docker container on exit (for docker session type). */
  dockerRemoveOnExit?: boolean;
  /** SSH target host (for ssh session type — jump host). */
  sshHost?: string;
  /** SSH target port (for ssh session type). */
  sshPort?: number;
  /** SSH username (for ssh session type). */
  sshUsername?: string;
  /** SSH auth method (for ssh session type). */
  sshAuthMethod?: "key" | "password" | "agent";
  /** SSH password (for ssh session type, password auth). */
  sshPassword?: string;
  /** SSH private key path (for ssh session type, key auth). */
  sshKeyPath?: string;
}

export type ConnectionConfig =
  | { type: "local"; config: LocalShellConfig }
  | { type: "ssh"; config: SshConfig }
  | { type: "telnet"; config: TelnetConfig }
  | { type: "serial"; config: SerialConfig }
  | { type: "remote-session"; config: RemoteSessionConfig }
  | { type: "docker"; config: DockerConfig };

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

export interface LogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}
