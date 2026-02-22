/**
 * Tauri command wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  SessionId,
  ConnectionConfig,
  SshConfig,
  RemoteAgentConfig,
  LogEntry,
} from "@/types/terminal";
import { SettingsSchema, Capabilities } from "@/types/schema";
import { SystemStats } from "@/types/monitoring";
import { CredentialStoreStatusInfo, SwitchCredentialStoreResult } from "@/types/credential";
import {
  SavedConnection,
  ConnectionFolder,
  FileEntry,
  ExternalFileError,
  AppSettings,
  AgentCapabilities,
} from "@/types/connection";

// --- Terminal / session commands ---

/** Info about a connection type from the backend registry. */
export interface ConnectionTypeInfo {
  typeId: string;
  displayName: string;
  icon: string;
  schema: SettingsSchema;
  capabilities: Capabilities;
}

/** Get the list of available connection types with their schemas. */
export async function getConnectionTypes(): Promise<ConnectionTypeInfo[]> {
  return await invoke<ConnectionTypeInfo[]>("get_connection_types");
}

// --- Schema conversion helpers ---

/**
 * Convert a backend ConnectionConfig (`{ type, config }`) into
 * the frontend's `{ typeId, settings }` format for schema-driven editing.
 */
export function fromConnectionConfig(config: ConnectionConfig): {
  typeId: string;
  settings: Record<string, unknown>;
} {
  return {
    typeId: config.type,
    settings: config.config as unknown as Record<string, unknown>,
  };
}

/**
 * Convert the frontend's `{ typeId, settings }` back into a backend
 * ConnectionConfig (`{ type, config }`) for persistence and session creation.
 */
export function toConnectionConfig(
  typeId: string,
  settings: Record<string, unknown>
): ConnectionConfig {
  return { type: typeId, config: settings } as unknown as ConnectionConfig;
}

/** Create a new connection session (type-agnostic). */
export async function createConnection(
  typeId: string,
  settings: Record<string, unknown>,
  agentId?: string
): Promise<SessionId> {
  return await invoke<string>("create_connection", {
    typeId,
    settings,
    agentId: agentId ?? null,
  });
}

/**
 * Create a new terminal session (legacy adapter).
 *
 * Converts the old `ConnectionConfig` discriminated union into the new
 * `create_connection(typeId, settings, agentId?)` call.
 */
export async function createTerminal(config: ConnectionConfig): Promise<SessionId> {
  if (config.type === "remote-session") {
    // Extract agentId from the config and forward the rest as settings.
    const { agentId, sessionType, ...rest } = config.config;
    return await createConnection(sessionType, rest, agentId);
  }
  // Local connection types: pass config as settings directly.
  return await createConnection(config.type, config.config as unknown as Record<string, unknown>);
}

/** Send input data to a terminal session */
export async function sendInput(sessionId: SessionId, data: string): Promise<void> {
  await invoke("send_input", { sessionId, data });
}

/** Resize a terminal session */
export async function resizeTerminal(
  sessionId: SessionId,
  cols: number,
  rows: number
): Promise<void> {
  await invoke("resize_terminal", { sessionId, cols, rows });
}

/** Close a terminal session */
export async function closeTerminal(sessionId: SessionId): Promise<void> {
  await invoke("close_terminal", { sessionId });
}

/** List available serial ports */
export async function listSerialPorts(): Promise<string[]> {
  return await invoke<string[]>("list_serial_ports");
}

/** List available shells on this platform */
export async function listAvailableShells(): Promise<string[]> {
  return await invoke<string[]>("list_available_shells");
}

/** Detect the user's default shell on this platform */
export async function getDefaultShell(): Promise<string | null> {
  return await invoke<string | null>("get_default_shell");
}

/** Check if a local X server is available for X11 forwarding */
export async function checkX11Available(): Promise<boolean> {
  return await invoke<boolean>("check_x11_available");
}

/** Check whether the SSH agent is running, stopped, or not installed. */
export async function checkSshAgentStatus(): Promise<string> {
  return await invoke<string>("check_ssh_agent_status");
}

/** Result of validating an SSH key file path. */
export interface SshKeyValidation {
  status: "valid" | "warning" | "error";
  message: string;
  keyType: string;
}

/** Validate an SSH key file path and return a user-facing hint. */
export async function validateSshKey(path: string): Promise<SshKeyValidation> {
  return await invoke<SshKeyValidation>("validate_ssh_key", { path });
}

/** Check if Docker is available on the local system. */
export async function checkDockerAvailable(): Promise<boolean> {
  return await invoke<boolean>("check_docker_available");
}

/** List locally available Docker images. */
export async function listDockerImages(): Promise<string[]> {
  return await invoke<string[]>("list_docker_images");
}

// --- Connection persistence commands ---

/** Saved remote agent (persisted form, no ephemeral state). */
export interface SavedRemoteAgent {
  id: string;
  name: string;
  config: RemoteAgentConfig;
}

interface ConnectionData {
  connections: SavedConnection[];
  folders: ConnectionFolder[];
  agents: SavedRemoteAgent[];
  externalErrors: ExternalFileError[];
}

/** Load all saved connections and folders from disk */
export async function loadConnectionsAndFolders(): Promise<ConnectionData> {
  return await invoke<ConnectionData>("load_connections_and_folders");
}

/** Save (add or update) a connection */
export async function saveConnection(connection: SavedConnection): Promise<void> {
  await invoke("save_connection", { connection });
}

/** Delete a connection by ID, optionally from an external file */
export async function deleteConnectionFromBackend(
  id: string,
  sourceFile?: string | null
): Promise<void> {
  await invoke("delete_connection", { id, sourceFile: sourceFile ?? null });
}

/** Move a connection between storage files */
export async function moveConnectionToFile(
  connectionId: string,
  currentSource: string | null,
  targetSource: string | null
): Promise<SavedConnection> {
  return await invoke<SavedConnection>("move_connection_to_file", {
    connectionId,
    currentSource,
    targetSource,
  });
}

/** Save (add or update) a folder */
export async function saveFolder(folder: ConnectionFolder): Promise<void> {
  await invoke("save_folder", { folder });
}

/** Delete a folder by ID */
export async function deleteFolderFromBackend(id: string): Promise<void> {
  await invoke("delete_folder", { id });
}

/** Export all connections as a JSON string */
export async function exportConnections(): Promise<string> {
  return await invoke<string>("export_connections");
}

/** Import connections from a JSON string. Returns count imported. */
export async function importConnections(json: string): Promise<number> {
  return await invoke<number>("import_connections", { json });
}

/** Preview of an import file before the user confirms. */
export interface ImportPreview {
  connectionCount: number;
  folderCount: number;
  agentCount: number;
  hasEncryptedCredentials: boolean;
}

/** Result of a completed import operation. */
export interface ImportResult {
  connectionsImported: number;
  credentialsImported: number;
}

/** Preview the contents of an import file without performing the import. */
export async function previewImport(json: string): Promise<ImportPreview> {
  return await invoke<ImportPreview>("preview_import", { json });
}

/** Export connections with optional encrypted credentials. */
export async function exportConnectionsEncrypted(
  exportPassword: string | null,
  connectionIds: string[] | null
): Promise<string> {
  return await invoke<string>("export_connections_encrypted", {
    exportPassword,
    connectionIds,
  });
}

/** Import connections with optional credential decryption. */
export async function importConnectionsWithCredentials(
  json: string,
  importPassword: string | null
): Promise<ImportResult> {
  return await invoke<ImportResult>("import_connections_with_credentials", {
    json,
    importPassword,
  });
}

// --- Settings commands ---

/** Get the current application settings */
export async function getSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>("get_settings");
}

/** Update and persist application settings */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

/** Save an external connection file to disk */
export async function saveExternalFile(
  filePath: string,
  name: string,
  folders: ConnectionFolder[],
  connections: SavedConnection[]
): Promise<void> {
  await invoke("save_external_file", { filePath, name, folders, connections });
}

/** Reload external connection files */
export async function reloadExternalConnections(): Promise<SavedConnection[]> {
  return await invoke<SavedConnection[]>("reload_external_connections");
}

// --- SFTP commands ---

/** Open a new SFTP session. Returns session ID. */
export async function sftpOpen(config: SshConfig): Promise<string> {
  return await invoke<string>("sftp_open", { config });
}

/** Close an SFTP session. */
export async function sftpClose(sessionId: string): Promise<void> {
  await invoke("sftp_close", { sessionId });
}

/** List directory contents via SFTP. */
export async function sftpListDir(sessionId: string, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("sftp_list_dir", { sessionId, path });
}

/** Download a remote file to a local path. Returns bytes transferred. */
export async function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string
): Promise<number> {
  return await invoke<number>("sftp_download", { sessionId, remotePath, localPath });
}

/** Upload a local file to a remote path. Returns bytes transferred. */
export async function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string
): Promise<number> {
  return await invoke<number>("sftp_upload", { sessionId, localPath, remotePath });
}

/** Create a directory on the remote host. */
export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  await invoke("sftp_mkdir", { sessionId, path });
}

/** Delete a file or directory on the remote host. */
export async function sftpDelete(
  sessionId: string,
  path: string,
  isDirectory: boolean
): Promise<void> {
  await invoke("sftp_delete", { sessionId, path, isDirectory });
}

/** Rename a file or directory on the remote host. */
export async function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await invoke("sftp_rename", { sessionId, oldPath, newPath });
}

// --- Local filesystem commands ---

/** Return the current user's home directory path. */
export async function getHomeDir(): Promise<string> {
  return await invoke<string>("get_home_dir");
}

/** List directory contents on the local filesystem. */
export async function localListDir(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("local_list_dir", { path });
}

/** Create a directory on the local filesystem. */
export async function localMkdir(path: string): Promise<void> {
  await invoke("local_mkdir", { path });
}

/** Delete a file or directory on the local filesystem. */
export async function localDelete(path: string, isDirectory: boolean): Promise<void> {
  await invoke("local_delete", { path, isDirectory });
}

/** Rename a file or directory on the local filesystem. */
export async function localRename(oldPath: string, newPath: string): Promise<void> {
  await invoke("local_rename", { oldPath, newPath });
}

/** Read a local file's contents as a UTF-8 string. */
export async function localReadFile(path: string): Promise<string> {
  return await invoke<string>("local_read_file", { path });
}

/** Write a string to a local file. */
export async function localWriteFile(path: string, content: string): Promise<void> {
  await invoke("local_write_file", { path, content });
}

/** Read a remote file's contents as a UTF-8 string via SFTP. */
export async function sftpReadFileContent(sessionId: string, remotePath: string): Promise<string> {
  return await invoke<string>("sftp_read_file_content", { sessionId, remotePath });
}

/** Write a string to a remote file via SFTP. */
export async function sftpWriteFileContent(
  sessionId: string,
  remotePath: string,
  content: string
): Promise<void> {
  await invoke("sftp_write_file_content", { sessionId, remotePath, content });
}

// --- VS Code integration ---

/** Check if VS Code CLI (`code`) is available on PATH. */
export async function vscodeAvailable(): Promise<boolean> {
  return await invoke<boolean>("vscode_available");
}

/** Open a local file in VS Code (fire-and-forget). */
export async function vscodeOpenLocal(path: string): Promise<void> {
  await invoke("vscode_open_local", { path });
}

/** Open a remote file in VS Code: download, edit, re-upload. */
export async function vscodeOpenRemote(sessionId: string, remotePath: string): Promise<void> {
  await invoke("vscode_open_remote", { sessionId, remotePath });
}

// --- Agent commands ---

/** Info about a remote session on an agent. */
export interface AgentSessionInfo {
  sessionId: string;
  title: string;
  type: string;
  status: string;
  attached: boolean;
}

/** Info about a saved session definition on an agent. */
export interface AgentDefinitionInfo {
  id: string;
  name: string;
  sessionType: string;
  config: Record<string, unknown>;
  persistent: boolean;
}

/** Result of connecting to an agent. */
interface AgentConnectResult {
  capabilities: AgentCapabilities;
  agentVersion: string;
  protocolVersion: string;
}

/** Connect to a remote agent via SSH. Returns capabilities. */
export async function connectAgent(
  agentId: string,
  config: RemoteAgentConfig
): Promise<AgentConnectResult> {
  return await invoke<AgentConnectResult>("connect_agent", { agentId, config });
}

/** Disconnect from a remote agent. */
export async function disconnectAgent(agentId: string): Promise<void> {
  await invoke("disconnect_agent", { agentId });
}

/** Gracefully shut down a remote agent and disconnect. Returns detached session count. */
export async function shutdownAgent(agentId: string, reason?: string): Promise<number> {
  return await invoke<number>("shutdown_agent", { agentId, reason: reason ?? null });
}

/** Get capabilities of a connected agent. */
export async function getAgentCapabilities(agentId: string): Promise<AgentCapabilities> {
  return await invoke<AgentCapabilities>("get_agent_capabilities", { agentId });
}

/** List active sessions on an agent. */
export async function listAgentSessions(agentId: string): Promise<AgentSessionInfo[]> {
  return await invoke<AgentSessionInfo[]>("list_agent_sessions", { agentId });
}

/** List saved session definitions on an agent. */
export async function listAgentDefinitions(agentId: string): Promise<AgentDefinitionInfo[]> {
  return await invoke<AgentDefinitionInfo[]>("list_agent_definitions", { agentId });
}

/** Save a session definition on an agent. */
export async function saveAgentDefinition(
  agentId: string,
  definition: Record<string, unknown>
): Promise<AgentDefinitionInfo> {
  return await invoke<AgentDefinitionInfo>("save_agent_definition", { agentId, definition });
}

/** Delete a session definition on an agent. */
export async function deleteAgentDefinition(agentId: string, definitionId: string): Promise<void> {
  await invoke("delete_agent_definition", { agentId, definitionId });
}

// --- Agent setup commands ---

/** Configuration for setting up a remote agent. */
export interface AgentSetupConfig {
  binaryPath: string;
  remotePath?: string;
  installService: boolean;
}

/** Result of initiating the agent setup flow. */
export interface AgentSetupResult {
  sessionId: string;
}

/** Upload and install the remote agent binary on a host. */
export async function setupRemoteAgent(
  agentId: string,
  config: RemoteAgentConfig,
  setupConfig: AgentSetupConfig
): Promise<AgentSetupResult> {
  return await invoke<AgentSetupResult>("setup_remote_agent", {
    agentId,
    config,
    setupConfig,
  });
}

// --- Agent deployment commands ---

/** Result of probing a remote host for the agent binary. */
export interface AgentProbeResult {
  found: boolean;
  version: string | null;
  remoteArch: string;
  remoteOs: string;
  compatible: boolean;
}

/** Configuration for deploying the agent to a remote host. */
export interface AgentDeployConfig {
  remotePath?: string;
}

/** Result of deploying the agent to a remote host. */
export interface AgentDeployResult {
  success: boolean;
  installedVersion: string | null;
}

/** Probe a remote host for an existing agent binary. */
export async function probeRemoteAgent(
  config: RemoteAgentConfig,
  expectedVersion?: string
): Promise<AgentProbeResult> {
  return await invoke<AgentProbeResult>("probe_remote_agent", {
    config,
    expectedVersion: expectedVersion ?? null,
  });
}

/** Deploy the agent binary to a remote host via SFTP. */
export async function deployAgent(
  agentId: string,
  config: RemoteAgentConfig,
  deployConfig: AgentDeployConfig
): Promise<AgentDeployResult> {
  return await invoke<AgentDeployResult>("deploy_agent", { agentId, config, deployConfig });
}

/** Update the agent: shut down the running instance, then deploy a new binary. */
export async function updateAgent(
  agentId: string,
  config: RemoteAgentConfig,
  deployConfig: AgentDeployConfig
): Promise<AgentDeployResult> {
  return await invoke<AgentDeployResult>("update_agent", { agentId, config, deployConfig });
}

// --- Agent persistence commands ---

/** Save (add or update) a remote agent definition to disk. */
export async function saveRemoteAgent(agent: SavedRemoteAgent): Promise<void> {
  await invoke("save_remote_agent", { agent });
}

/** Delete a remote agent definition from disk. */
export async function deleteRemoteAgentFromBackend(id: string): Promise<void> {
  await invoke("delete_remote_agent", { id });
}

// --- Monitoring commands ---

/** Open a new monitoring session. Returns session ID. */
export async function monitoringOpen(config: SshConfig): Promise<string> {
  return await invoke<string>("monitoring_open", { config });
}

/** Close a monitoring session. */
export async function monitoringClose(sessionId: string): Promise<void> {
  await invoke("monitoring_close", { sessionId });
}

/** Fetch system stats from a monitoring session. */
export async function monitoringFetchStats(sessionId: string): Promise<SystemStats> {
  return await invoke<SystemStats>("monitoring_fetch_stats", { sessionId });
}

// --- Log commands ---

/** Retrieve the most recent log entries from the backend ring buffer. */
export async function getLogs(count: number): Promise<LogEntry[]> {
  return await invoke<LogEntry[]>("get_logs", { count });
}

/** Clear all buffered log entries in the backend. */
export async function clearLogs(): Promise<void> {
  await invoke("clear_logs");
}

// --- Credential store commands ---

/** Get the current credential store status. */
export async function getCredentialStoreStatus(): Promise<CredentialStoreStatusInfo> {
  return await invoke<CredentialStoreStatusInfo>("get_credential_store_status");
}

/** Unlock the master password credential store. */
export async function unlockCredentialStore(password: string): Promise<void> {
  await invoke("unlock_credential_store", { password });
}

/** Lock the master password credential store. */
export async function lockCredentialStore(): Promise<void> {
  await invoke("lock_credential_store");
}

/** Set up a new master password for the credential store. */
export async function setupMasterPassword(password: string): Promise<void> {
  await invoke("setup_master_password", { password });
}

/** Change the master password for the credential store. */
export async function changeMasterPassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  await invoke("change_master_password", { currentPassword, newPassword });
}

/** Switch the credential storage backend. Optionally migrates existing credentials. */
export async function switchCredentialStore(
  newMode: string,
  masterPassword?: string
): Promise<SwitchCredentialStoreResult> {
  return await invoke<SwitchCredentialStoreResult>("switch_credential_store", {
    newMode,
    masterPassword: masterPassword ?? null,
  });
}

/** Check whether the OS keychain is accessible. */
export async function checkKeychainAvailable(): Promise<boolean> {
  return await invoke<boolean>("check_keychain_available");
}

/** Update the auto-lock timeout for the master password credential store. */
export async function setAutoLockTimeout(minutes: number | null): Promise<void> {
  await invoke("set_auto_lock_timeout", { minutes });
}

/** Resolve a stored credential for a connection. Returns the value or null if not found. */
export async function resolveCredential(
  connectionId: string,
  credentialType: "password" | "key_passphrase"
): Promise<string | null> {
  return await invoke<string | null>("resolve_credential", { connectionId, credentialType });
}

/** Remove a stored credential for a connection (e.g., after auth failure). */
export async function removeCredential(
  connectionId: string,
  credentialType: "password" | "key_passphrase"
): Promise<void> {
  await invoke("remove_credential", { connectionId, credentialType });
}
