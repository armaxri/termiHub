export type SessionId = string;

export type ShellType = "zsh" | "bash" | "cmd" | "powershell" | "gitbash";

export type ConnectionType = "local" | "ssh" | "telnet" | "serial";

export type TabContentType = "terminal" | "settings";

export interface TerminalOptions {
  horizontalScrolling?: boolean;
}

export interface LocalShellConfig {
  shellType: ShellType;
  initialCommand?: string;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  password?: string;
  keyPath?: string;
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

export type ConnectionConfig =
  | { type: "local"; config: LocalShellConfig }
  | { type: "ssh"; config: SshConfig }
  | { type: "telnet"; config: TelnetConfig }
  | { type: "serial"; config: SerialConfig };

export interface TerminalTab {
  id: string;
  sessionId: SessionId | null;
  title: string;
  connectionType: ConnectionType;
  contentType: TabContentType;
  config: ConnectionConfig;
  panelId: string;
  isActive: boolean;
}

export interface LeafPanel {
  type: 'leaf';
  id: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
}

export interface SplitContainer {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: PanelNode[];
}

export type PanelNode = LeafPanel | SplitContainer;
export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';
