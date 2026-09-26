/**
 * Per-workspace settings overrides (PROD-052).
 *
 * A workspace may override a curated subset of the global settings (theme,
 * terminal font family / size) and carry defaults for new local shells (working
 * directory, extra environment variables). Precedence is
 * `global < workspace < connection`.
 *
 * The **backend** owns which workspace is active: it merges the directory /
 * environment into new local shells itself and broadcasts
 * `active-workspace-changed` to every window whenever the active workspace or its
 * overrides change. This module is each window's view of that state: it keeps
 * the active overrides, resolves the *effective* settings for display (theme,
 * terminal font) and re-applies the theme live on a switch. The persisted global
 * settings document is never modified by an override.
 */

import { useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import { applyTheme } from "@/themes";
import { currentSettingsView } from "@/store/settingsBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import type { AppSettings } from "@/types/connection";
import type { ActiveWorkspaceInfo, WorkspaceEnvVar, WorkspaceSettings } from "@/types/workspace";
import {
  getActiveWorkspace as apiGetActiveWorkspace,
  loadWorkspace as apiLoadWorkspace,
  saveWorkspace as apiSaveWorkspace,
  setActiveWorkspace as apiSetActiveWorkspace,
} from "@/services/workspaceApi";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** Global settings a workspace can override (ids match `SETTINGS_REGISTRY`). */
export type WorkspaceOverridableKey = "theme" | "fontFamily" | "fontSize";

/** The global settings a workspace can override, in display order. */
export const WORKSPACE_OVERRIDABLE_SETTINGS: readonly WorkspaceOverridableKey[] = [
  "theme",
  "fontFamily",
  "fontSize",
];

export type { ActiveWorkspaceInfo };

/** Accepted terminal font size override range (mirrors Settings and the backend). */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

/** Tauri event carrying the active workspace (or `null`) to every window. */
export const ACTIVE_WORKSPACE_CHANGED_EVENT = "active-workspace-changed";

let active: ActiveWorkspaceInfo | null = null;
const listeners = new Set<() => void>();

/** The active workspace, or `null` when none is active. */
export function getActiveWorkspace(): ActiveWorkspaceInfo | null {
  return active;
}

/** Subscribe to active-workspace changes; returns an unsubscribe. */
export function subscribeActiveWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Replace this window's active workspace and apply its overrides live (the theme
 * is re-applied; font consumers re-render through {@link useEffectiveSettings}).
 */
export function setActiveWorkspaceLocal(info: ActiveWorkspaceInfo | null): void {
  active = info;
  applyEffectiveTheme();
  for (const listener of listeners) listener();
}

/**
 * Resolve the effective settings: the global document with the workspace's
 * overrides layered on top. Connection-level values are applied later by their
 * consumers (e.g. a tab's own terminal font) and still win.
 */
export function resolveEffectiveSettings(
  global: AppSettings,
  overrides: WorkspaceSettings | null | undefined
): AppSettings {
  if (!overrides) return global;
  const effective: AppSettings = { ...global };
  if (overrides.theme) effective.theme = overrides.theme as AppSettings["theme"];
  if (overrides.fontFamily) effective.fontFamily = overrides.fontFamily;
  if (overrides.fontSize != null) effective.fontSize = overrides.fontSize;
  return effective;
}

/** The current effective settings (global document + active workspace overrides). */
export function currentEffectiveSettings(): AppSettings {
  return resolveEffectiveSettings(currentSettingsView(), active?.settings);
}

/** Whether the active workspace overrides `key`. */
export function isOverriddenByWorkspace(
  info: ActiveWorkspaceInfo | null,
  key: WorkspaceOverridableKey
): boolean {
  const value = info?.settings?.[key];
  return value !== undefined && value !== null && value !== "";
}

/** Apply the effective theme for `settings` (default: the current global document). */
export function applyEffectiveTheme(settings: AppSettings = currentSettingsView()): void {
  const effective = resolveEffectiveSettings(settings, active?.settings);
  applyTheme(effective.theme, effective.customThemes);
}

/**
 * Make `workspaceId` the active workspace (or clear it with `null`). The backend
 * broadcasts the change to every window; this window also applies it at once.
 */
export async function activateWorkspace(workspaceId: string | null): Promise<void> {
  try {
    await apiSetActiveWorkspace(workspaceId);
    setActiveWorkspaceLocal((await apiGetActiveWorkspace()) ?? null);
  } catch (err) {
    frontendLog("workspace_settings", `Failed to activate workspace: ${errorMessage(err)}`);
  }
}

/**
 * The stored settings overrides of workspace `id`, or `undefined` when it has
 * none or cannot be read — used to carry them over when a layout re-capture
 * overwrites the workspace in place.
 */
export async function loadExistingWorkspaceSettings(
  id: string
): Promise<WorkspaceSettings | undefined> {
  try {
    return (await apiLoadWorkspace(id)).settings;
  } catch (err) {
    frontendLog("workspace_settings", `Could not read workspace ${id}: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * Remove workspace `id`'s override of `key` so the global setting applies again
 * ("Reset to global"). The backend re-broadcasts the active workspace on save, so
 * every window picks the change up live.
 */
export async function clearWorkspaceOverride(
  id: string,
  key: WorkspaceOverridableKey
): Promise<void> {
  const definition = await apiLoadWorkspace(id);
  const settings: WorkspaceSettings = { ...(definition.settings ?? {}) };
  delete settings[key];
  await apiSaveWorkspace({ ...definition, settings });
  if (active?.id === id) {
    setActiveWorkspaceLocal({ ...active, settings });
  }
}

/**
 * Read the backend's active workspace into this window **without** applying the
 * theme, so the caller's next theme application already includes the workspace
 * override. Called at startup before the first theme apply: the backend may have
 * re-activated the last session's workspace (#3517), and applying the global
 * theme first would flash it. Best-effort — a failure leaves the state unchanged.
 */
export async function primeActiveWorkspace(): Promise<void> {
  try {
    active = (await apiGetActiveWorkspace()) ?? null;
    for (const listener of listeners) listener();
  } catch (err) {
    frontendLog("workspace_settings", `Failed to read active workspace: ${errorMessage(err)}`);
  }
}

/**
 * Start following the backend's active workspace in this window: read the
 * current one and listen for changes. Returns an unsubscribe.
 */
export async function initActiveWorkspaceSync(): Promise<() => void> {
  const unlisten = await listen<ActiveWorkspaceInfo | null>(
    ACTIVE_WORKSPACE_CHANGED_EVENT,
    (event) => setActiveWorkspaceLocal(event.payload ?? null)
  );
  try {
    setActiveWorkspaceLocal((await apiGetActiveWorkspace()) ?? null);
  } catch (err) {
    frontendLog("workspace_settings", `Failed to read active workspace: ${errorMessage(err)}`);
  }
  return unlisten;
}

/** React hook: the active workspace, re-rendering on change. */
export function useActiveWorkspace(): ActiveWorkspaceInfo | null {
  return useSyncExternalStore(subscribeActiveWorkspace, getActiveWorkspace, getActiveWorkspace);
}

/** React hook: the effective settings (global document + active workspace overrides). */
export function useEffectiveSettings(): AppSettings {
  const global = useProjectedSettings();
  const workspace = useActiveWorkspace();
  return useMemo(() => resolveEffectiveSettings(global, workspace?.settings), [global, workspace]);
}

// ── Environment variable helpers for the workspace settings editor ────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME_RE = /(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

/** Whether `name` is a valid environment variable name (mirrors the backend rule). */
export function isValidEnvVarName(name: string): boolean {
  return name.length <= 256 && ENV_NAME_RE.test(name);
}

/**
 * Whether `name` looks like it holds a secret. Workspace env vars are stored in
 * plain text in `workspaces.json` (and backups), so the editor warns on these.
 */
export function looksLikeSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Test-only: reset module state. */
export function __resetActiveWorkspaceForTest(): void {
  active = null;
  listeners.clear();
}

/**
 * Validation problem for env var row `index` of `envVars`, or `null` when the
 * row is valid. A fully blank row is valid (it is dropped on save).
 */
export function envVarRowError(envVars: WorkspaceEnvVar[], index: number): string | null {
  const row = envVars[index];
  if (!row || (row.key === "" && row.value === "")) return null;
  if (!isValidEnvVarName(row.key)) {
    return "Use letters, digits and underscores; must not start with a digit";
  }
  if (envVars.findIndex((v) => v.key === row.key) !== index) {
    return `Duplicate variable "${row.key}"`;
  }
  return null;
}

/**
 * Normalize editor input for storage: trim text, drop blank values and blank
 * env rows, and return `undefined` when nothing is overridden. Throws with a
 * user-facing message when an env var row is invalid (mirrors the backend).
 */
export function normalizeWorkspaceSettings(
  input: WorkspaceSettings
): WorkspaceSettings | undefined {
  const out: WorkspaceSettings = {};
  if (input.theme) out.theme = input.theme;
  const fontFamily = input.fontFamily?.trim();
  if (fontFamily) out.fontFamily = fontFamily;
  if (input.fontSize != null) {
    if (input.fontSize < MIN_FONT_SIZE || input.fontSize > MAX_FONT_SIZE) {
      throw new Error(`Font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}`);
    }
    out.fontSize = input.fontSize;
  }
  const dir = input.defaultWorkingDirectory?.trim();
  if (dir) out.defaultWorkingDirectory = dir;
  const envVars = (input.envVars ?? []).map((v) => ({ key: v.key.trim(), value: v.value }));
  for (let i = 0; i < envVars.length; i++) {
    const problem = envVarRowError(envVars, i);
    if (problem) throw new Error(`Environment variable "${envVars[i].key}": ${problem}`);
  }
  const kept = envVars.filter((v) => v.key !== "");
  if (kept.length > 0) out.envVars = kept;
  return Object.keys(out).length > 0 ? out : undefined;
}
