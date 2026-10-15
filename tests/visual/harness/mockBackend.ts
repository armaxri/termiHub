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

/** Per-test knobs the spec sets before the app boots. */
export interface VisualScenario {
  /** Credential store mode/status reported at startup. */
  credentialStore?: {
    mode: "master_password" | "os_keychain" | "none";
    status: "unlocked" | "locked" | "unavailable";
  };
  /** Seed the sidebars with populated fixture rows (default true). */
  populated?: boolean;
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

function regionView(region: string, populated: boolean): unknown {
  const wire = connectionsWire.loadConnectionsAndFolders;
  if (region === "settings") return FRESH_SETTINGS;
  if (region === "connections") {
    return populated ? { folders: wire.folders, connections: wire.connections } : {};
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
      return FRESH_SETTINGS;
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
      return [];
    case "get_workspaces":
      return populated ? WORKSPACES : [];
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

    default:
      (window.__VISUAL_UNHANDLED__ ??= []).push(cmd);
      // List-shaped commands get an empty list so their panels render empty
      // instead of crashing on `null.length`.
      return /^list_|_list$|_history$|_runs$/.test(cmd) ? [] : null;
  }
}
