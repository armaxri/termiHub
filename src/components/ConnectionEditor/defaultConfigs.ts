import {
  ConnectionType,
  ConnectionConfig,
  LocalShellConfig,
  RemoteAgentConfig,
} from "@/types/terminal";
import { AppSettings } from "@/types/connection";

/**
 * Build default connection configs for every connection type.
 * When `settings` is provided, SSH defaults are populated from
 * `defaultUser` and `defaultSshKeyPath`.
 */
export function getDefaultConfigs(
  defaultShell: string,
  settings?: AppSettings
): Partial<Record<ConnectionType, ConnectionConfig>> {
  const sshUsername = settings?.defaultUser ?? "";
  const sshKeyPath = settings?.defaultSshKeyPath;
  const sshAuthMethod = sshKeyPath ? "key" : "password";

  return {
    local: { type: "local", config: { shellType: defaultShell } as LocalShellConfig },
    ssh: {
      type: "ssh",
      config: {
        host: "",
        port: 22,
        username: sshUsername,
        authMethod: sshAuthMethod,
        ...(sshKeyPath ? { keyPath: sshKeyPath } : {}),
        enableX11Forwarding: false,
      },
    },
    telnet: { type: "telnet", config: { host: "", port: 23 } },
    serial: {
      type: "serial",
      config: {
        port: "",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      },
    },
    docker: {
      type: "docker",
      config: {
        image: "",
        envVars: [],
        volumes: [],
        removeOnExit: true,
      },
    },
    "remote-session": {
      type: "remote-session",
      config: {
        agentId: "",
        sessionType: "shell",
        persistent: false,
      },
    },
  };
}

/**
 * Build the default RemoteAgentConfig, applying settings defaults
 * for `username` and SSH key authentication.
 */
export function getDefaultAgentConfig(settings?: AppSettings): RemoteAgentConfig {
  const username = settings?.defaultUser ?? "";
  const keyPath = settings?.defaultSshKeyPath;
  const authMethod = keyPath ? "key" : "password";

  return {
    host: "",
    port: 22,
    username,
    authMethod,
    ...(keyPath ? { keyPath } : {}),
  };
}
