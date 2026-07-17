/**
 * Types for the interactive Session Picker (SI-3, #1366).
 *
 * The picker turns a `--pick` spawn request into an explicit {@link SpawnChoice}
 * — which target to open, and how. Resolving that choice into backend session
 * settings stays with the existing spawn commands (`resolve_shell_spawn` /
 * `resolve_container_spawn`), so this module describes the decision only.
 */

/** The container runtime backing a "new container" choice. */
export type ContainerRuntime = "docker" | "podman";

/**
 * The container runtime *saved* on a shell-integration entry (#1561). Widens
 * {@link ContainerRuntime} with `"auto"` — the default, meaning "no remembered
 * preference, detect whichever runtime is installed". Mirrors the Rust
 * `ContainerRuntime`, which carries the `Auto` variant the picker never offers.
 */
export type SavedContainerRuntime = ContainerRuntime | "auto";

/**
 * The kind of session a spawn targets — the wire tokens of the Rust `SpawnKind`.
 * `"auto"` means "not explicitly stated": resolve by falling back to
 * presence-based inference.
 */
export type SpawnKind = "container" | "local" | "wsl" | "ssh" | "auto";

/**
 * The target a user picked, as a discriminated union on `kind`. The `kind`
 * values line up with the Rust `SpawnKind` wire tokens, so a choice maps onto a
 * spawn request without a translation table.
 */
export type SpawnTarget =
  /** A local shell, by detected shell name (e.g. `"bash"`). */
  | { kind: "local"; shell: string }
  /** A WSL distribution, by name (e.g. `"Ubuntu-22.04"`). Windows only. */
  | { kind: "wsl"; distro: string }
  /** A new container bind-mounting the spawn location at `mount`. */
  | {
      kind: "container";
      runtime: ContainerRuntime;
      /** Image reference (`repository:tag`). */
      image: string;
      /** In-container mount target for the spawn location (e.g. `"/workspace"`). */
      mount: string;
    };

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
