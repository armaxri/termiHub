import type { TunnelType } from "@/types/tunnel";
import { t } from "@/i18n/catalog";
import { bindField } from "./tunnelForm";
import { validateHost, validatePort } from "@/utils/fieldValidation";

/** Field-keyed validation messages for the tunnel forwarding config. */
export type TunnelFieldErrors = Partial<Record<string, string>>;

/** Result of validating a tunnel's forwarding configuration. */
export interface TunnelValidation {
  /** Per-field error messages, keyed by the config field name. */
  errors: TunnelFieldErrors;
  /** True when every visible host/port field is valid. */
  valid: boolean;
}

/**
 * Validate the host/port fields of a tunnel's forwarding config.
 *
 * Every `*Host` field must be a non-empty string and every `*Port` field must
 * be an integer in 1–65535. This replaces the previous `parseInt(...) || 0`
 * coercion that let port 0, a blank host, or a >65535 port save and then fail
 * at connect time.
 */
export function validateTunnelType(tunnelType: TunnelType): TunnelValidation {
  const errors: TunnelFieldErrors = {};

  // `TunnelType` is a discriminated union whose members' fields are all `string`
  // hosts or `PortValue` (`number | ""`) ports, so the bag is iterated with real
  // types — no cast — and each value is narrowed by its own `typeof`.
  for (const [key, value] of Object.entries(tunnelType.config)) {
    if (key.endsWith("Host")) {
      const host = typeof value === "string" ? value : "";
      const err = validateHost(host, key === bindField(tunnelType) ? "Address" : "Host");
      // What a local tunnel reaches is asked for in words (V-006).
      const target = tunnelType.type === "local" && key === "remoteHost";
      if (err) errors[key] = target && host.trim() === "" ? t("tunnel.editor.target.missing") : err;
    } else if (key.endsWith("Port")) {
      const port = typeof value === "number" || value === "" ? value : "";
      const err = validatePort(port, { label: "Port" });
      if (err) errors[key] = err;
    }
  }

  return { errors, valid: Object.keys(errors).length === 0 };
}
