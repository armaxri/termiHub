import { useEffect, useMemo } from "react";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { SettingsField } from "@/types/schema";
import { Select } from "@/components/ui";
import { savedConnectionOptions } from "@/utils/jumpHost";
import { isSameNamedHost } from "@/utils/sameHost";

/** The option value standing for "no connection" (Radix items cannot be ""). */
export const NO_SAVED_CONNECTION = "__none__";

/**
 * What a `savedConnection` field needs from the form (#4194): the saved
 * connections it may list, their folders (for path labels), and the current
 * value of the field its `matchHostField` names.
 */
export interface SavedConnectionContext {
  connections: SavedConnection[];
  folders: ConnectionFolder[];
  /** The host an unset picker preselects a connection by. */
  matchHost?: string;
}

interface SavedConnectionFieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldType: { type: "savedConnection"; connectionType: string; matchHostField?: string };
  context?: SavedConnectionContext;
  /** The control's `id`, `aria-describedby` and invalid state from DynamicField. */
  a11y: { id: string; describedBy?: string; invalid: boolean };
  testIdBase: string;
}

/** The `host` setting of a saved connection, if it has one. */
function hostOf(connection: SavedConnection | undefined): string {
  const host = connection?.config.config.host;
  return typeof host === "string" ? host : "";
}

/**
 * A schema `savedConnection` field (#4194): a select of the saved connections
 * of one type, plus "None". The value is the chosen connection's id, or `""`
 * for none. An unset value (never chosen) preselects a connection whose host
 * is the `matchHostField` host; an explicit None is left alone. A value whose
 * connection no longer exists stays selected and is flagged, so the user sees
 * the link is broken instead of it silently reading as None.
 */
export function SavedConnectionField({
  field,
  value,
  onChange,
  fieldType,
  context,
  a11y,
  testIdBase,
}: SavedConnectionFieldProps) {
  const connections = useMemo(() => context?.connections ?? [], [context?.connections]);
  const folders = useMemo(() => context?.folders ?? [], [context?.folders]);
  const options = useMemo(
    () => savedConnectionOptions(connections, folders, fieldType.connectionType),
    [connections, folders, fieldType.connectionType]
  );
  const unset = value === undefined || value === null;
  const selected = typeof value === "string" ? value : "";
  const missing = selected !== "" && !options.some((o) => o.id === selected);

  const matchHost = context?.matchHost?.trim() ?? "";
  const preselect = useMemo(() => {
    if (!unset || matchHost === "") return undefined;
    return options.find(
      (o) =>
        !o.ambiguous && isSameNamedHost(matchHost, hostOf(connections.find((c) => c.id === o.id)))
    )?.id;
  }, [unset, matchHost, options, connections]);

  useEffect(() => {
    if (preselect !== undefined) onChange(preselect);
  }, [preselect, onChange]);

  const selectOptions = [
    { value: NO_SAVED_CONNECTION, label: "None" },
    ...options.map((o) =>
      o.ambiguous
        ? { value: o.id, label: `${o.label} (in several connection files)`, disabled: true }
        : { value: o.id, label: o.label }
    ),
    ...(missing ? [{ value: selected, label: `${selected} (deleted)`, disabled: true }] : []),
  ];
  const missingId = `${a11y.id}-missing`;

  return (
    <>
      <Select
        id={a11y.id}
        value={selected === "" ? NO_SAVED_CONNECTION : selected}
        onChange={(v) => onChange(v === NO_SAVED_CONNECTION ? "" : v)}
        options={selectOptions}
        aria-label={field.label}
        aria-describedby={
          [a11y.describedBy, missing ? missingId : null].filter(Boolean).join(" ") || undefined
        }
        aria-invalid={a11y.invalid || missing}
        data-testid={testIdBase}
      />
      {missing && (
        <p
          id={missingId}
          className="settings-form__hint settings-form__hint--warning"
          data-testid={`${testIdBase}-missing`}
        >
          The saved connection &ldquo;{selected}&rdquo; no longer exists. Pick another one, or None.
        </p>
      )}
    </>
  );
}
