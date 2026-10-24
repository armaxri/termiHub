/**
 * What the rendered visual checks (#4712) render: window sizes, sidebar widths
 * and surfaces. Shared by the spec and the global teardown, so this module must
 * not register tests.
 */

import { join } from "node:path";

/** Default window, a mid size, and the app's minimum window (tauri.conf.json). */
export const WINDOWS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x700", width: 1024, height: 700 },
  { name: "800x600", width: 800, height: 600 },
] as const;

/**
 * The `uiChromeSlice` default width, and the minimum the resize handle allows.
 * The minimum is read from the handle's `aria-valuemin` at run time, so the
 * check follows `useSidebarResize` when its minimum changes.
 */
export const SIDEBAR_WIDTHS = [
  { name: "default", width: 260 },
  { name: "min", width: "aria-valuemin" },
] as const;

/** Every sidebar (experimental ones are switched on by the mock settings). */
export const SIDEBARS = [
  "connections",
  "files",
  "recent-sessions",
  "workspaces",
  "macros",
  "tunnels",
  "services",
  "network-tools",
  "workflows",
  "plugins",
] as const;

/**
 * One kind of sidebar row the row checks (#4954, MT-UI-53) grade: where its
 * rows render, the element holding the name, and the action controls that
 * must be visible and usable while the row is hovered or holds keyboard focus.
 * Every kind is seeded (harness/mockBackend.ts) with a name long enough to be
 * cut at the minimum sidebar width.
 */
export interface SidebarRowKind {
  /** Short id used in surface names. */
  kind: string;
  /** The sidebar view the rows render in. */
  view: (typeof SIDEBARS)[number];
  /** Selector of one row, inside the sidebar. */
  row: string;
  /** Selector of the row's name, inside the row. */
  name: string;
  /** Selector of the row's action controls, inside the row. */
  actions: string;
}

export const SIDEBAR_ROWS: readonly SidebarRowKind[] = [
  {
    kind: "connection",
    view: "connections",
    row: ".connection-tree__item-row",
    name: ".connection-tree__label",
    actions: ".connection-tree__connect, .connection-tree__persistent-actions button",
  },
  {
    kind: "agent",
    view: "connections",
    row: ".connection-list__group-header--agent",
    name: ".connection-list__group-title",
    actions: ".connection-list__group-actions button",
  },
  {
    kind: "tunnel",
    view: "tunnels",
    row: "[data-testid^=tunnel-item-]",
    name: ".sidebar-list-item__name",
    actions: ".sidebar-list-item__actions button",
  },
  {
    kind: "service",
    view: "services",
    row: ".sidebar-list-item",
    name: ".sidebar-list-item__name",
    actions: ".sidebar-list-item__actions button",
  },
  {
    kind: "http-monitor",
    view: "network-tools",
    row: ".network-sidebar__monitor",
    name: ".network-sidebar__monitor-url",
    actions: ":scope > button:not(.network-sidebar__monitor-info)",
  },
  {
    kind: "workspace",
    view: "workspaces",
    row: ".sidebar-list-item",
    name: ".sidebar-list-item__name",
    actions: ".sidebar-list-item__actions button",
  },
];

/** Dialogs opened by one app-store action (the unlock and shortcuts tests are separate). */
export const STORE_DIALOGS: ReadonlyArray<{ name: string; action: string; args: unknown[] }> = [
  { name: "command-palette", action: "setCommandPaletteOpen", args: [true] },
  { name: "customize-layout", action: "setLayoutDialogOpen", args: [true] },
  { name: "export", action: "setExportDialogOpen", args: [true] },
  {
    name: "password-prompt",
    action: "requestPassword",
    args: ["build.example.com", "ci", "The saved password was rejected by the server."],
  },
  {
    // The window-close decision with every row kind, the #4501 move summary and
    // the #4500 note on typed secrets that reopen empty.
    name: "close-window",
    action: "setPendingWindowClose",
    args: [
      {
        sessions: [
          {
            tabId: "t1",
            sessionId: "s1",
            title: "build.example.com",
            connectionType: "ssh",
            contentType: "terminal",
            outcome: "detach",
          },
          {
            tabId: "t2",
            sessionId: "s2",
            title: "zsh",
            connectionType: "local",
            contentType: "terminal",
            outcome: "terminate",
          },
        ],
        otherWindows: [{ label: "main" }, { label: "win-3" }],
        dirtyEditors: [
          { tabId: "e1", title: "deploy.yaml", movable: true },
          { tabId: "c1", title: "Edit: prod-db", movable: true, clearedSecrets: ["Password"] },
        ],
        otherTabs: [
          { tabId: "e2", title: "hosts", contentType: "editor", movable: true },
          { tabId: "st", title: "Settings", contentType: "settings", movable: true },
          { tabId: "lv", title: "Logs", contentType: "log-viewer", movable: true },
          { tabId: "tv", title: "Transfers", contentType: "transfer-view", movable: false },
        ],
      },
    ],
  },
];

/**
 * Tests per window: settings, imported confirmations, sidebars, sidebar rows,
 * unlock, shortcuts, the connection editor with stored secrets, the plugin
 * update dialog with an access diff, the MobaXterm import from Settings, the
 * Settings create-file prompt, and STORE_DIALOGS; plus the one narrow Settings
 * tab test and one overflow-menu parity test per sidebar.
 */
export const EXPECTED_TESTS = WINDOWS.length * (10 + STORE_DIALOGS.length) + 1 + SIDEBARS.length;

const RESULTS = join(import.meta.dirname, "test-results");
/** Where every surface's screenshot goes (uploaded as a CI artifact). */
export const SCREENS = join(RESULTS, "screens");
/** Per-test record of the allowlist entries it used (read by globalTeardown). */
export const USAGE_DIR = join(RESULTS, "allowlist-usage");
