import type { TunnelType } from "@/types/tunnel";
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

const HOST_LABELS: Record<string, string> = {
  localHost: "Local host",
  remoteHost: "Remote host",
};

const PORT_LABELS: Record<string, string> = {
  localPort: "Local port",
  remotePort: "Remote port",
};

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
  const config = tunnelType.config as Record<string, string | number>;

  for (const [key, value] of Object.entries(config)) {
    if (key.endsWith("Host")) {
      const err = validateHost(value as string, HOST_LABELS[key] ?? "Host");
      if (err) errors[key] = err;
    } else if (key.endsWith("Port")) {
      const err = validatePort(value as number, { label: PORT_LABELS[key] ?? "Port" });
      if (err) errors[key] = err;
    }
  }

  return { errors, valid: Object.keys(errors).length === 0 };
}
