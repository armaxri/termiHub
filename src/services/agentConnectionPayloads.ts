/**
 * Builders for the agent `connections.*` / `connections.folders.*` RPC params
 * (AGT-028).
 *
 * Every frontend call site that creates, updates, moves or re-expands an agent
 * connection or folder builds its payload here, typed against the ts-rs-generated
 * core DTOs (`src/types/generated/`), so a key drift from the agent's snake_case
 * wire shape (e.g. the old `session_type` vs the wire's `type`) is a `tsc` error
 * rather than a silently dropped field. The desktop decodes the same payload into
 * the same Rust DTOs at the command boundary.
 *
 * The builders emit the **canonical** wire form — `connections.create` carries
 * every key (optional ones as `null`); the `*.update` patches omit untouched keys
 * and use `null` only on the tri-state fields that mean "clear / move to root".
 * `agentConnectionPayloads.contract.test.ts` pins that output to a fixture the
 * Rust contract test (`core/tests/agent_connection_params_contract.rs`) decodes
 * and re-encodes byte-for-byte.
 */
import type { ConnectionCreateParams } from "@/types/generated/ConnectionCreateParams";
import type { ConnectionUpdateParams } from "@/types/generated/ConnectionUpdateParams";
import type { FolderUpdateParams } from "@/types/generated/FolderUpdateParams";
import type { TerminalOptions } from "@/types/terminal";

/** The editor-level description of an agent connection definition. */
export interface AgentConnectionDraft {
  name: string;
  /** Connection type id (`local`, `ssh`, `serial`, …) — the wire's `type`. */
  type: string;
  config: Record<string, unknown>;
  persistent: boolean;
  /** Per-connection terminal options; `undefined` = none. */
  terminalOptions?: TerminalOptions;
  /** Icon name; `undefined`/`null` = none. */
  icon?: string | null;
}

/** `connections.create` params for a new definition placed in `folderId` (`null` = root). */
export function buildAgentConnectionCreate(
  draft: AgentConnectionDraft,
  folderId: string | null
): ConnectionCreateParams {
  return {
    name: draft.name,
    type: draft.type,
    config: draft.config,
    persistent: draft.persistent,
    folder_id: folderId,
    terminal_options: draft.terminalOptions ?? null,
    icon: draft.icon ?? null,
  };
}

/**
 * `connections.update` params replacing every editable field of definition `id`
 * (the folder is left unchanged; terminal options / icon are cleared when absent).
 */
export function buildAgentConnectionUpdate(
  id: string,
  draft: AgentConnectionDraft
): ConnectionUpdateParams {
  return {
    id,
    name: draft.name,
    type: draft.type,
    config: draft.config,
    persistent: draft.persistent,
    terminal_options: draft.terminalOptions ?? null,
    icon: draft.icon ?? null,
  };
}

/** `connections.update` params moving definition `id` into `folderId` (`null` = root). */
export function buildAgentConnectionMove(
  id: string,
  folderId: string | null
): ConnectionUpdateParams {
  return { id, folder_id: folderId };
}

/** `connections.folders.update` params persisting folder `id`'s expansion state. */
export function buildAgentFolderExpanded(id: string, isExpanded: boolean): FolderUpdateParams {
  return { id, is_expanded: isExpanded };
}
