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
}

declare global {
  interface Window {
    __VISUAL_SCENARIO__?: VisualScenario;
    /** Commands the app invoked that the mock has no explicit answer for. */
    __VISUAL_UNHANDLED__?: string[];
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

function settingsFor(scenario: VisualScenario): unknown {
  return scenario.importConfirmations ? IMPORT_CONFIRMED_SETTINGS : FRESH_SETTINGS;
}

function regionView(region: string, populated: boolean): unknown {
  const wire = connectionsWire.loadConnectionsAndFolders;
  if (region === "settings") return settingsFor(window.__VISUAL_SCENARIO__ ?? {});
  if (region === "connections") {
    if (!populated) return {};
    const extra = window.__VISUAL_SCENARIO__?.storedSecrets ? STORED_SECRET_ROWS : [];
    return { folders: wire.folders, connections: [...wire.connections, ...extra] };
  }
  return {};
}

let version = 0;

/** Answer one IPC command. Unknown commands resolve to `null` and are recorded. */
export function handleCommand(cmd: string, args: Args): unknown {
  const scenario = window.__VISUAL_SCENARIO__ ?? {};
  const populated = scenario.populated ?? true;
  const wire = connectionsWire.loadConnectionsAndFolders;

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
    case "list_embedded_servers":
    case "get_embedded_server_states":
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
