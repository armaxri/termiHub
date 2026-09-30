/**
 * The connection settings-schema types, generated from their Rust source of
 * truth (`core/src/connection/schema.rs`, and `Capabilities` from
 * `core/src/connection/mod.rs`) via ts-rs (audit DUP-030, ts-rs rollout #3088).
 *
 * `Capabilities.terminal` / `graphical` / `tunneling` stay optional to match the
 * wire reality: an agent or config predating them omits them. Decide with
 * `terminal === false`, `graphical === true` and `tunneling === true`.
 */
export type { SettingsSchema } from "./generated/SettingsSchema";
export type { SettingsGroup } from "./generated/SettingsGroup";
export type { SettingsField } from "./generated/SettingsField";
export type { Condition } from "./generated/Condition";
export type { FieldType } from "./generated/FieldType";
export type { Capabilities } from "./generated/Capabilities";
