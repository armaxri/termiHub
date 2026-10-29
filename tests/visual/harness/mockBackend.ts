/**
 * In-browser stand-in for the Rust backend used by the rendered visual checks
 * (#4712).
 *
 * The harness page installs this through `@tauri-apps/api/mocks` `mockIPC`, the
 * same Tauri-provided IPC mock the unit tests build on, so the real `src/main.tsx`
 * boots in plain headless Chromium with no Tauri shell. Responses are seeded from
 * the golden wire fixtures the Rust side serialises (`src/test/fixtures/wire/`),
 * so the sidebars render real-shaped rows rather than hand-typed guesses.
 *
 * A scenario (set by the Playwright spec before the page loads, through
 * `window.__VISUAL_SCENARIO__`) switches the few responses a surface depends on,
 * e.g. a locked master-password store for the unlock dialog.
 */

import connectionsWire from "../../../src/test/fixtures/wire/connections.json";
import {
  PLUGIN_UPDATE_PACKAGE,
  PLUGIN_UPDATE_PREVIEW,
  PLUGIN_UPDATE_TRUST,
} from "./pluginUpdatePreview";
import { STORED_SECRET_CONNECTIONS } from "./storedSecretIds";
import { MONITOR_KEY, MONITOR_SESSION_ID, VISUAL_SESSION_ID } from "./interactionIds";
import { MOBAXTERM_CANDIDATES, MOBAXTERM_PREVIEW } from "./mobaxtermImportPreview";

/** Per-test knobs the spec sets before the app boots. */
export interface VisualScenario {
  /** Credential store mode/status reported at startup. */
  credentialStore?: {
    mode: "master_password" | "os_keychain" | "none";
    status: "unlocked" | "locked" | "unavailable";
  };
  /** Seed the sidebars with populated fixture rows (default true). */
  populated?: boolean;
  /**
   * Seed confirmed imported workspace commands (#4445): `ws-1` holds two of
   * them, and one more key matches no saved workspace.
   */
  importConfirmations?: boolean;
  /**
   * Seed saved connections whose schema secrets are stored (#4431): a plugin
   * connection with stored token fields and an SSH connection whose inline
   * jump-host hop has a stored password, with real-shaped connection types.
   */
  storedSecrets?: boolean;
  /**
   * Answer the plugin file picker, `preview_plugin` and `assess_plugin_trust`
   * with an update whose preview carries an access diff (#4418).
   */
  pluginUpdate?: boolean;
  /**
   * Answer `discover_mobaxterm_configs` with a found configuration and
   * `preview_mobaxterm_import` with a mixed preview (#4850).
   */
  mobaxtermImport?: boolean;
  /**
   * Answer `create_connection` with {@link VISUAL_SESSION_ID}, so a terminal
   * tab gets a live session the spec feeds output to through `emit` (#4949).
   */
  terminal?: boolean;
  /** Seed one live SSH host monitor ({@link MONITOR_KEY}) for Open Connections (#4949). */
  monitoring?: boolean;
  /** Seed root connections (#5008) and folders (#5020) with icon colours and emoji. */
  iconStyles?: boolean;
}

declare global {
  interface Window {
    __VISUAL_SCENARIO__?: VisualScenario;
    /** Commands the app invoked that the mock has no explicit answer for. */
    __VISUAL_UNHANDLED__?: string[];
    /**
     * Every command the app invoked, in order (`intent_dispatch:<kind>` for an
     * intent), so a check can compare what two triggers of one action did.
     */
    __VISUAL_INVOKED__?: string[];
    /** Every PTY resize the app sent, in order (#5065). */
    __VISUAL_RESIZES__?: { sessionId: string; cols: number; rows: number }[];
    /** `sessionId:intervalMs` of every refresh-interval change the app asked for (#4949). */
    __VISUAL_MONITOR_INTERVALS__?: string[];
  }
}

type Args = Record<string, unknown> | undefined;

const STAMP = "2026-10-01T12:00:00Z";

/** Workspaces with names long enough to expose premature truncation (#4709). */
const WORKSPACES = [
  { id: "ws-1", name: "test", connectionCount: 3 },
  { id: "ws-2", name: "sshtest", connectionCount: 1 },
  { id: "ws-3", name: "a-workspace-with-a-reasonably-long-name", connectionCount: 2 },
];

const MACROS = [
  { id: "m-1", name: "Deploy staging", tags: [], steps: [], createdAt: STAMP, updatedAt: STAMP },
  {
    id: "m-2",
    name: "Collect diagnostics",
    tags: [],
    steps: [],
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

const WORKFLOWS = [
  {
    id: "wf-1",
    name: "Nightly backup",
    tags: [],
    steps: [],
    triggers: [],
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

const SCHEDULES = {
  paused: false,
  schedules: [
    {
      id: "sch-1",
      name: "Backup every night",
      running: false,
      action: { kind: "workflow", workflowId: "wf-1" },
      targets: { kind: "connections", connectionIds: [] },
      rule: { kind: "daily", time: "02:00" },
      missedRuns: "skip",
      enabled: true,
      createdAt: STAMP,
      updatedAt: STAMP,
    },
  ],
};

/**
 * Row data for the sidebars the wire fixtures leave empty (#4954), with names
 * long enough to be cut at the minimum sidebar width so the row checks can see
 * a cut name keep its tooltip.
 */
const LONG_CONNECTION = {
  id: "Work/Production database replica in the Frankfurt datacenter",
  name: "Production database replica in the Frankfurt datacenter",
  folderId: "Work",
  config: { type: "local", config: {} },
};

const AGENT_SETTINGS = {
  enableDocker: true,
  enableFileBrowser: true,
  enableMonitoring: true,
  logLevel: "info",
  persistentScrollbackBufferSizeMb: 1,
  startingDirectory: "~",
  verboseTracing: false,
};

function agentRow(id: string, name: string, connectionState: string) {
  return {
    id,
    name,
    config: {
      host: `${id}.example.com`,
      port: 22,
      username: "ops",
      authMethod: "password",
      allowSelfUpdate: false,
      updateStrategy: "immediate",
    },
    agentSettings: AGENT_SETTINGS,
    isExpanded: false,
    connectionState,
  };
}

/** The `agents` region: one connected and one dropped remote agent. */
const AGENTS_VIEW = {
  agents: [
    agentRow("agent-lab", "Raspberry Pi in the lab behind the office firewall", "connected"),
    agentRow("agent-edge", "Edge gateway in the Frankfurt datacenter rack", "disconnected"),
  ],
  sessions: {},
  definitions: {},
  folders: {},
};

/** An agent definition row for the icon-style scenario (#5021). */
function agentDefinition(id: string, name: string, style: Record<string, string>) {
  return {
    id,
    name,
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
    ...style,
  };
}

/**
 * The `agents` region for the icon-style scenario (#5021): the connected lab
 * agent expanded, with an emoji definition and a palette-coloured one.
 */
const ICON_STYLE_AGENTS_VIEW = {
  ...AGENTS_VIEW,
  agents: AGENTS_VIEW.agents.map((a) => (a.id === "agent-lab" ? { ...a, isExpanded: true } : a)),
  definitions: {
    "agent-lab": [
      agentDefinition("agent-def-emoji", "Lab shell", { iconEmoji: "\u{1F9EA}" }),
      agentDefinition("agent-def-green", "Lab serial console", { iconColor: "green" }),
    ],
  },
};

const TUNNEL_STATS = {
  bytesSent: 2048,
  bytesReceived: 8192,
  activeConnections: 1,
  totalConnections: 3,
};

/** The `tunnels` region: a running local forward and a stopped dynamic one. */
const TUNNELS_VIEW = {
  tunnels: [
    {
      id: "tun-db",
      name: "Postgres on the production database replica",
      sshConnectionId: "Work/Build Box",
      tunnelType: {
        type: "local",
        config: { localHost: "127.0.0.1", localPort: 15432, remoteHost: "db", remotePort: 5432 },
      },
      autoStart: false,
      reconnectOnDisconnect: true,
    },
    {
      id: "tun-socks",
      name: "SOCKS proxy through the build box for the staging network",
      sshConnectionId: "Work/Build Box",
      tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
      autoStart: false,
      reconnectOnDisconnect: false,
    },
  ],
  states: {
    "tun-db": { tunnelId: "tun-db", status: "connected", stats: TUNNEL_STATS },
  },
};

/** Embedded services: a running HTTP share and a stopped FTP server. */
const EMBEDDED_SERVERS = [
  {
    id: "srv-http",
    name: "Release artifacts for the staging deployment",
    serverType: "http",
    rootDirectory: "/home/visual/releases",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: true,
  },
  {
    id: "srv-ftp",
    name: "Firmware images for the lab devices",
    serverType: "ftp",
    rootDirectory: "/home/visual/firmware",
    bindHost: "0.0.0.0",
    port: 2121,
    autoStart: false,
    readOnly: false,
  },
];

const EMBEDDED_SERVER_STATES = [
  {
    serverId: "srv-http",
    status: "running",
    stats: { activeConnections: 0, totalConnections: 2, bytesSent: 4096, bytesReceived: 512 },
    startedAt: STAMP,
  },
];

/** HTTP monitors: a healthy running one and a paused one, both with long URLs. */
const HTTP_MONITORS = [
  {
    config: {
      id: "mon-api",
      url: "https://api.staging.example.com/v2/health/readiness",
      intervalMs: 30000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 5000,
    },
    running: true,
    paused: false,
    lastResult: {
      monitorId: "mon-api",
      statusCode: 200,
      latencyMs: 42,
      ok: true,
      timestampMs: Date.parse(STAMP),
    },
  },
  {
    config: {
      id: "mon-docs",
      url: "https://documentation.internal.example.com/status",
      intervalMs: 60000,
      method: "HEAD",
      expectedStatus: 200,
      timeoutMs: 5000,
    },
    running: true,
    paused: true,
    lastResult: null,
  },
];

/**
 * A fresh-install settings document (the backend's seed baseline), with the
 * experimental sidebars switched on so every sidebar can be captured and the
 * first-launch shell-integration banner dismissed so it does not cover the
 * status bar in every screenshot.
 */
const FRESH_SETTINGS = {
  version: "2",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  experimentalFeaturesEnabled: true,
  shellIntegration: {
    entries: [],
    fallback: "picker",
    firstLaunchBannerDismissed: true,
    linuxFileManagers: { kde: false, nautilus: false, thunar: false },
    openInNewWindow: false,
    registered: false,
  },
};

/** A held command long enough to expose wrapping in the confirmations list. */
const LONG_COMMAND =
  "ssh -o StrictHostKeyChecking=accept-new deploy@build-server-with-a-long-hostname.example.com " +
  '"cd /srv/app && ./scripts/release.sh --environment=staging --verbose"';

/** `ws-1` as an imported workspace whose tabs hold commands (#4434). */
const IMPORTED_WORKSPACE = {
  id: "ws-1",
  name: "test",
  tabGroups: [
    {
      name: "Main",
      layout: {
        type: "leaf",
        tabs: [
          { title: "Build", pendingInitialCommand: "make deploy" },
          { title: "Release", pendingInitialCommand: LONG_COMMAND },
        ],
      },
    },
  ],
};

/**
 * The settings with `IMPORTED_WORKSPACE`'s commands confirmed (sha256 of each
 * command's exact text, as `importedCommandKey` computes it) plus a stale key.
 */
const IMPORT_CONFIRMED_SETTINGS = {
  ...FRESH_SETTINGS,
  workspaceImportAllowlist: [
    "cmd:c28716624ab42f2fdbc840b2e95f7541211a11a2513c53f6b4f89a724ba55c6b",
    "cmd:7ddd5e3b188edce0a853e811ccabf50b1d13fa88e67b027ff9780a2493f928c6",
    `cmd:${"ab".repeat(32)}`,
  ],
};

/** The password-bearing fields of the SSH schema the editor and hop editor render. */
const SSH_FIELDS = [
  { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
  { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 22 },
  { key: "username", label: "Username", fieldType: { type: "text" }, required: false },
  {
    key: "authMethod",
    label: "Authentication",
    fieldType: {
      type: "select",
      options: [
        { value: "key", label: "SSH Key" },
        { value: "password", label: "Password" },
        { value: "agent", label: "SSH Agent" },
      ],
    },
    required: true,
    default: "key",
  },
  {
    key: "password",
    label: "Password",
    fieldType: { type: "password" },
    required: false,
    visibleWhen: { field: "authMethod", equals: "password" },
  },
  {
    key: "keyPath",
    label: "Key Path",
    fieldType: { type: "filePath", kind: "file" },
    required: false,
    visibleWhen: { field: "authMethod", equals: "key" },
  },
];

const CAPABILITIES = { monitoring: false, fileBrowser: false, resize: true, persistent: false };

/** Connection types for the stored-secrets editor surfaces (#4431). */
const STORED_SECRET_TYPES = [
  {
    typeId: "ssh",
    displayName: "SSH",
    icon: "terminal",
    schema: { groups: [{ key: "connection", label: "Connection", fields: SSH_FIELDS }] },
    capabilities: CAPABILITIES,
  },
  {
    typeId: "plugin:visual:api",
    displayName: "Metrics API",
    icon: "plug",
    schema: {
      groups: [
        {
          key: "connection",
          label: "Connection",
          fields: [
            { key: "endpoint", label: "Endpoint", fieldType: { type: "text" }, required: true },
            { key: "apiToken", label: "API Token", fieldType: { type: "password" } },
            { key: "signingSecret", label: "Signing Secret", fieldType: { type: "password" } },
          ],
        },
      ],
    },
    capabilities: CAPABILITIES,
  },
];

/**
 * Root connections carrying a per-connection icon colour and/or emoji (#5008):
 * an emoji-only row, palette colours, an emoji that overrides a colour, and a
 * near-black custom hex the renderer must lighten to stay legible in Dark.
 */
export const ICON_STYLE_ROWS = [
  {
    id: "icon-emoji",
    name: "Prod web",
    folderId: null,
    config: { type: "ssh", config: { host: "web.prod.example.com" } },
    iconEmoji: "\u{1F680}",
  },
  {
    id: "icon-red",
    name: "Prod database",
    folderId: null,
    config: { type: "ssh", config: { host: "db.prod.example.com" } },
    iconColor: "red",
  },
  {
    id: "icon-teal-emoji",
    name: "Docker host",
    folderId: null,
    config: { type: "ssh", config: { host: "docker.example.com" } },
    iconColor: "teal",
    iconEmoji: "\u{1F433}",
  },
  {
    id: "icon-yellow",
    name: "Staging",
    folderId: null,
    config: { type: "local", config: { shell: "zsh" } },
    iconColor: "yellow",
  },
  {
    id: "icon-custom-dark",
    name: "Custom near-black",
    folderId: null,
    config: { type: "ssh", config: { host: "lab.example.com" } },
    iconColor: "#202020",
  },
];

/**
 * Root folders carrying an icon colour and/or emoji (#5020): an emoji folder,
 * a palette colour, and a near-black custom hex the renderer must lighten.
 */
export const ICON_STYLE_FOLDERS = [
  {
    id: "Containers",
    name: "Containers",
    parentId: null,
    isExpanded: false,
    iconEmoji: "\u{1F4E6}",
  },
  { id: "Customers", name: "Customers", parentId: null, isExpanded: false, iconColor: "purple" },
  { id: "Lab", name: "Lab", parentId: null, isExpanded: false, iconColor: "#1a1a1a" },
];

const STORED_SECRET_ROWS = [
  {
    id: STORED_SECRET_CONNECTIONS.plugin,
    name: "Metrics API",
    folderId: "Work",
    config: {
      type: "plugin:visual:api",
      config: { endpoint: "https://metrics.internal.example.com/v2" },
    },
  },
  {
    id: STORED_SECRET_CONNECTIONS.hop,
    name: "Behind Bastion",
    folderId: "Work",
    config: {
      type: "ssh",
      config: {
        host: "10.20.0.5",
        port: 22,
        username: "deploy",
        authMethod: "key",
        proxyJump: [
          {
            host: "bastion-with-a-long-hostname.example.com",
            port: 22,
            username: "ops",
            authMethod: "password",
          },
        ],
      },
    },
  },
];

/** The stored field secret names — never values — each connection reports. */
const STORED_SECRET_KEYS: Record<string, { fields: string[]; hops: string[] }> = {
  [STORED_SECRET_CONNECTIONS.plugin]: { fields: ["apiToken", "signingSecret"], hops: [] },
  [STORED_SECRET_CONNECTIONS.hop]: {
    fields: [],
    hops: ["ops@bastion-with-a-long-hostname.example.com:22"],
  },
};

/** The `system-monitors` region: one live SSH host monitor at the default interval. */
const MONITORS_VIEW = {
  monitors: {
    [MONITOR_KEY]: {
      key: MONITOR_KEY,
      host: MONITOR_KEY,
      monitorSessionId: MONITOR_SESSION_ID,
      stats: null,
      loading: false,
      error: null,
      status: "live",
      sampleCount: 2,
      paused: false,
      intervalMs: 2000,
    },
  },
  statsCache: {},
};

function settingsFor(scenario: VisualScenario): unknown {
  return scenario.importConfirmations ? IMPORT_CONFIRMED_SETTINGS : FRESH_SETTINGS;
}

function regionView(region: string, populated: boolean): unknown {
  const wire = connectionsWire.loadConnectionsAndFolders;
  if (region === "settings") return settingsFor(window.__VISUAL_SCENARIO__ ?? {});
  if (region === "connections") {
    if (!populated) return {};
    const scenario = window.__VISUAL_SCENARIO__ ?? {};
    const extra = [
      ...(scenario.storedSecrets ? STORED_SECRET_ROWS : []),
      ...(scenario.iconStyles ? ICON_STYLE_ROWS : []),
    ];
    return {
      folders: [...wire.folders, ...(scenario.iconStyles ? ICON_STYLE_FOLDERS : [])],
      connections: [...wire.connections, LONG_CONNECTION, ...extra],
    };
  }
  if (region === "agents") {
    if (!populated) return {};
    return window.__VISUAL_SCENARIO__?.iconStyles ? ICON_STYLE_AGENTS_VIEW : AGENTS_VIEW;
  }
  if (region === "tunnels") return populated ? TUNNELS_VIEW : {};
  if (region === "system-monitors") {
    return window.__VISUAL_SCENARIO__?.monitoring ? MONITORS_VIEW : {};
  }
  return {};
}

let version = 0;
/** Terminal sessions created so far (each `create_connection` makes one). */
let terminalSessions = 0;

/** Answer one IPC command. Unknown commands resolve to `null` and are recorded. */
export function handleCommand(cmd: string, args: Args): unknown {
  const scenario = window.__VISUAL_SCENARIO__ ?? {};
  const populated = scenario.populated ?? true;
  const wire = connectionsWire.loadConnectionsAndFolders;
  const intentKind = (args?.intent as { kind?: string } | undefined)?.kind;
  (window.__VISUAL_INVOKED__ ??= []).push(intentKind ? `${cmd}:${intentKind}` : cmd);

  switch (cmd) {
    // ── projection substrate ──
    case "projection_subscribe": {
      const region = String(args?.region ?? "");
      return { kind: "snapshot", region, version: ++version, view: regionView(region, populated) };
    }
    case "projection_resync":
      return null;
    case "projection_unsubscribe":
      return null;
    case "intent_dispatch": {
      const intent = (args?.intent ?? {}) as { intentId?: string };
      return { intentId: intent.intentId ?? "", status: "applied", produced: [] };
    }

    // ── app / window ──
    case "get_settings":
      return settingsFor(scenario);
    case "get_app_info":
      return { version: "0.1.0", gitHash: "visual", isDev: true, buildBranch: "develop" };
    case "get_app_mode":
      return { isPortable: false, dataDir: null };
    case "list_windows":
      return [{ label: "main", tabCount: 0 }];
    case "list_session_owners":
      return {};
    case "get_shell_integration_status":
      return {
        registered: false,
        exePathMatches: true,
        stale: false,
        portable: false,
        detectedFileManagers: [],
      };
    case "get_crash_report_notice":
    case "take_pending_spawn":
    case "get_active_workspace":
    case "get_cli_workspace":
    case "load_last_session":
    case "get_default_shell":
      return null;
    case "get_session_history":
    case "get_agent_crash_notices":
    case "folder_paste_take_interrupted":
    case "get_recovery_warnings":
    case "list_plugins":
      return [];
    case "list_available_shells":
      return ["bash", "zsh"];
    case "vscode_available":
      return false;
    case "restore_resolve_mode":
      return "never";
    case "check_for_updates":
      return {
        available: false,
        latestVersion: "0.1.0",
        releaseUrl: "",
        releaseNotes: "",
        isSecurity: false,
      };
    case "get_os_auth_info":
      return {
        exportReauth: { available: false },
        biometricUnlock: { available: false, enabled: false },
      };

    // ── data the sidebars list ──
    case "list_embedded_servers":
      return populated ? EMBEDDED_SERVERS : [];
    case "get_embedded_server_states":
      return populated ? EMBEDDED_SERVER_STATES : [];
    case "network_http_monitor_list":
      return populated ? HTTP_MONITORS : [];
    case "load_connections_and_folders":
      return populated ? wire : { connections: [], folders: [], agents: [], externalErrors: [] };
    case "get_connection_types":
      return scenario.storedSecrets ? STORED_SECRET_TYPES : [];
    case "list_stored_field_secret_keys":
      return STORED_SECRET_KEYS[String(args?.connectionId ?? "")] ?? { fields: [], hops: [] };
    case "get_workspaces":
      return populated ? WORKSPACES : [];
    case "load_workspace": {
      const id = String(args?.workspaceId ?? "");
      if (id === IMPORTED_WORKSPACE.id && scenario.importConfirmations) return IMPORTED_WORKSPACE;
      const summary = WORKSPACES.find((ws) => ws.id === id);
      return summary ? { id, name: summary.name, tabGroups: [] } : null;
    }
    case "list_macros":
      return populated ? MACROS : [];
    case "list_workflows":
      return populated ? WORKFLOWS : [];
    case "list_schedules":
      return populated ? SCHEDULES : { paused: false, schedules: [] };
    case "get_credential_store_status":
      return scenario.credentialStore ?? { mode: "none", status: "unavailable" };
    case "unlock_credential_store":
      // No master password matches, so the unlock dialog shows its error line.
      throw new Error("invalid master password");

    // ── fire-and-forget ──
    case "record_frontend_log":
    case "clear_last_session":
    case "save_settings":
    case "report_window_tab_count":
    case "register_schedule_window":
      return null;

    case "get_home_dir":
      return "/home/visual";
    case "get_log_file_path":
      return "/home/visual/.local/share/termihub/termihub.log";
    case "local_list_dir":
      return [];
    case "session_monitoring_set_interval":
      (window.__VISUAL_MONITOR_INTERVALS__ ??= []).push(`${args?.sessionId}:${args?.intervalMs}`);
      return null;
    case "create_connection":
      if (!scenario.terminal) return null;
      // The first terminal keeps the well-known id; later ones get their own,
      // so each tab has its own session (#5065).
      terminalSessions += 1;
      return terminalSessions === 1
        ? VISUAL_SESSION_ID
        : `${VISUAL_SESSION_ID}-${terminalSessions}`;
    case "resize_terminal":
      (window.__VISUAL_RESIZES__ ??= []).push({
        sessionId: String(args?.sessionId ?? ""),
        cols: Number(args?.cols),
        rows: Number(args?.rows),
      });
      return null;
    case "plugin:dialog|open":
      return scenario.pluginUpdate ? PLUGIN_UPDATE_PACKAGE : null;
    case "preview_plugin":
      // Answered at once, like every other mock: a loading toast dismissed
      // before it mounted is still removed (#4812).
      return scenario.pluginUpdate ? PLUGIN_UPDATE_PREVIEW : null;
    case "assess_plugin_trust":
      return scenario.pluginUpdate ? PLUGIN_UPDATE_TRUST : null;
    case "discover_mobaxterm_configs":
      return scenario.mobaxtermImport ? MOBAXTERM_CANDIDATES : [];
    case "preview_mobaxterm_import":
      return scenario.mobaxtermImport ? MOBAXTERM_PREVIEW : null;

    default:
      (window.__VISUAL_UNHANDLED__ ??= []).push(cmd);
      // List-shaped commands get an empty list so their panels render empty
      // instead of crashing on `null.length`.
      return /^list_|_list$|_history$|_runs$/.test(cmd) ? [] : null;
  }
}
