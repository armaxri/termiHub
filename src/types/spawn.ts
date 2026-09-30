/**
 * Types for the interactive Session Picker (SI-3, #1366).
 *
 * The picker turns a `--pick` spawn request into an explicit {@link SpawnChoice}
 * — which target to open, and how. Resolving that choice into backend session
 * settings stays with the existing spawn commands (`resolve_shell_spawn` /
 * `resolve_container_spawn`), so this module describes the decision only.
 */

import type { ContainerRuntime as CoreContainerRuntime } from "./generated/ContainerRuntime";
import type { SpawnTarget } from "./generated/SpawnTarget";

/**
 * The container runtime backing a "new container" choice: the Rust
 * `ContainerRuntime` without the `"auto"` variant the picker never offers.
 */
export type ContainerRuntime = Exclude<CoreContainerRuntime, "auto">;

/**
 * The kind of session a spawn targets — the wire tokens of the Rust `SpawnKind`.
 * `"auto"` means "not explicitly stated": resolve by falling back to
 * presence-based inference.
 */
export type { SpawnKind } from "./generated/SpawnKind";

/**
 * The target a user picked, as a discriminated union on `kind` — generated via
 * ts-rs from the Rust `PickedTarget` (#3088). The `kind` values line up with the
 * Rust `SpawnKind` wire tokens, so a choice maps onto a spawn request without a
 * translation table.
 */
export type { SpawnTarget };

/**
 * A confirmed Session Picker selection: the chosen {@link SpawnTarget} plus the
 * two footer options.
 */
export interface SpawnChoice {
  /** The picked target. */
  target: SpawnTarget;
  /** Open the session in a new window instead of the running one. */
  newWindow: boolean;
  /** Save this selection as the triggering entry's new default. */
  remember: boolean;
}
