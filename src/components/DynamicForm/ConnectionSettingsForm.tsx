import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Controller } from "react-hook-form";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { ChevronRight } from "lucide-react";
import type { SettingsSchema, SettingsGroup } from "@/types/schema";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import { interpolateSettings, isFieldVisible, withSchemaDefaults } from "@/utils/schemaDefaults";
import { parseHostPort } from "@/utils/parseHostPort";
import { ftpPortForTlsMode } from "@/utils/ftpSecurity";
import { vncPortForDisplay } from "@/utils/vncDisplayPort";
import { settingsSchemaToZod } from "./settingsSchemaToZod";
import { DynamicField } from "./DynamicField";
import { savedConnectionValues } from "./savedConnectionValues";

/** Stable empty lists for the optional saved-connection props. */
const NO_CONNECTIONS: SavedConnection[] = [];
const NO_FOLDERS: ConnectionFolder[] = [];

interface ConnectionSettingsFormProps {
  schema: SettingsSchema;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  /**
   * When true, a "Password saved in credential store" hint is shown below
   * password fields that are currently empty (i.e. the credential is stored
   * and will not be overwritten unless the user types a new value).
   */
  credentialSavedHint?: boolean;
  /**
   * Pre-supplied serial port names for `serialPort` fields.
   * Pass the remote agent's `availableSerialPorts` here when editing an
   * agent definition so the dropdown reflects the remote machine's ports.
   */
  availablePorts?: string[];
  /**
   * Whether `dockerContainer` fields may list the LOCAL container runtime's
   * containers (PROD-017). Pass `false` for agent-hosted connections, whose
   * containers live on the agent's machine; the field then accepts a typed
   * name/ID only. Defaults to `true`.
   */
  localContainerListing?: boolean;
  /**
   * When set, `dockerContainer` fields list the containers of this connected
   * agent's host instead (#3424) — pass the agent's id when editing an
   * agent-hosted Docker connection. An agent too old to list containers
   * degrades to the typed name/ID field. Takes precedence over
   * `localContainerListing`.
   */
  containerListingAgentId?: string;
  /**
   * The saved connections (the unified view) that `savedConnection` fields
   * list (#4194), and their folders for path labels. A picked connection's
   * host is exposed to conditions and notices as `<key>.host`.
   */
  savedConnections?: SavedConnection[];
  connectionFolders?: ConnectionFolder[];
  /**
   * Reports overall client-side validity plus a per-field error map (keyed by
   * field key) whenever validation state changes. Only currently-visible fields
   * are considered, so a required field hidden by `visibleWhen` never blocks.
   * The parent uses this to disable Save/Save & Connect on invalid input.
   */
  onValidityChange?: (valid: boolean, errors: Record<string, string>) => void;
  /**
   * Field keys to hide (and exclude from validation) regardless of the
   * schema — e.g. the password fields while a shared named credential
   * supplies the secret (#3557). Values stay in the form untouched.
   */
  hiddenFieldKeys?: readonly string[];
  /**
   * Extra content rendered right after the field with `key` while that field
   * is shown — e.g. the shared-credential picker after `authMethod` (#3557).
   */
  afterField?: { key: string; node: React.ReactNode };
}

/**
 * Generic connection settings form renderer backed by react-hook-form and zod.
 *
 * Manages field state, dirty tracking, and client-side validation internally.
 * Changes are propagated to the parent via `onChange` on every field update.
 * Backend validation in Agent.connect remains authoritative; zod is UX only.
 */
export function ConnectionSettingsForm({
  schema,
  settings,
  onChange,
  credentialSavedHint,
  availablePorts,
  localContainerListing = true,
  containerListingAgentId,
  savedConnections = NO_CONNECTIONS,
  connectionFolders = NO_FOLDERS,
  onValidityChange,
  hiddenFieldKeys,
  afterField,
}: ConnectionSettingsFormProps) {
  const zodSchema = useMemo(() => settingsSchemaToZod(schema), [schema]);

  // The shared RHF + zod scaffold (UISF2-003): `watchedValues` is a complete,
  // stable snapshot of the form, and `schemaErrors` holds every zod issue. Only
  // the visible fields' errors count towards validity (see `validity` below).
  const {
    form: { control, watch, reset, setValue, getValues },
    draft: watchedValues,
    errors: schemaErrors,
  } = useZodEditorForm<Record<string, unknown>>({ schema: zodSchema, defaultValues: settings });

  // Whether this schema has a sibling `port` field — gates the host:port split.
  const hasPortField = useMemo(
    () => schema.groups.some((g) => g.fields.some((f) => f.key === "port")),
    [schema]
  );

  // Whether this schema is FTP-shaped (has both a `tlsMode` select and a `port`
  // field) — gates the TLS-mode → port auto-adjust special-case below.
  const hasTlsAndPort = useMemo(
    () => hasPortField && schema.groups.some((g) => g.fields.some((f) => f.key === "tlsMode")),
    [schema, hasPortField]
  );

  // Whether this schema is VNC-shaped (has both a `display` field and a `port`
  // field) — gates the live display↔port interplay special-case below.
  const hasVncDisplay = useMemo(
    () => hasPortField && schema.groups.some((g) => g.fields.some((f) => f.key === "display")),
    [schema, hasPortField]
  );

  // VNC display↔port interplay (#1716): a VNC server listens on `5900 + display`,
  // so editing the display number auto-fills the port, and editing the port
  // directly clears the display (the concept's rule — the explicit port then
  // wins). Wired into the field `onChange` rather than a `watch` effect so it
  // fires only on genuine user edits: `setValue` below updates the sibling
  // field's value without re-invoking its `onChange`, so there is no feedback
  // loop and no spurious change on mount/reset. Auto-fill never overwrites an
  // intentional port with an invalid/cleared display (see `vncPortForDisplay`).
  const syncDisplayPort = useCallback(
    (fieldKey: string, value: unknown) => {
      if (!hasVncDisplay) return;
      if (fieldKey === "display") {
        const port = vncPortForDisplay(value);
        if (port !== null && getValues("port") !== port) {
          setValue("port", port, { shouldValidate: true, shouldDirty: true });
        }
      } else if (fieldKey === "port") {
        const currentDisplay = getValues("display");
        if (currentDisplay !== undefined && currentDisplay !== null && currentDisplay !== "") {
          // Clear to `null` rather than `undefined`: react-hook-form's Controller
          // does not re-render a controlled input when a value is set back to
          // `undefined`, so the numeric widget would keep showing the stale
          // display. `null` clears the widget (NumberField treats it as empty)
          // and, unlike `""`, deserializes cleanly to the backend's
          // `display: Option<u16>` as "no display" — the explicit port then wins.
          setValue("display", null, { shouldValidate: true, shouldDirty: true });
        }
      }
    },
    [hasVncDisplay, getValues, setValue]
  );

  // Auto-extract `host:port` typed into the Host field on blur (PR #195 / #895).
  // `192.168.0.2:2222` → host `192.168.0.2` + port `2222`; `[::1]:22` → IPv6
  // host + port; a bare host or bare IPv6 is left untouched.
  const handleFieldBlur = useCallback(
    (fieldKey: string, value: unknown) => {
      if (fieldKey !== "host" || !hasPortField) return;
      if (typeof value !== "string") return;
      const { host, port } = parseHostPort(value);
      if (port === null) return;
      setValue("host", host, { shouldValidate: true, shouldDirty: true });
      setValue("port", port, { shouldValidate: true, shouldDirty: true });
    },
    [hasPortField, setValue]
  );

  // Snapshot of the values most recently seeded into the form or propagated to
  // the parent. The `watch` propagation below skips an emission whose values
  // match this snapshot, which suppresses the no-op `onChange` that `reset`
  // echoes on a type switch — WITHOUT a sticky "am I resetting?" flag.
  //
  // A flag was the previous approach and was unsafe (FEC-019): it was set before
  // `reset`, expecting the synchronous watch echo to consume it, but that echo is
  // not guaranteed to reach our subscription. When the parent passes a fresh
  // `onChange` identity on the switch render, React tears the watch subscription
  // down and rebuilds it *around* the reset (effect cleanup runs before setup),
  // so the echo lands on no subscriber, the flag stays set, and it then swallows
  // the next genuine user edit. Comparing values has no such ordering hazard.
  const lastPropagatedRef = useRef<string>(JSON.stringify(settings));

  // Reset the form when the connection type changes (schema groups differ).
  //
  // Every field key in the new schema is seeded to `undefined` before the new
  // settings are layered on top. react-hook-form keeps a value cache keyed by
  // field name (shouldUnregister defaults to false), so when two connection
  // types share a field name (e.g. both local and SSH have a `shell` field) a
  // bare `reset(settings)` that omits that key leaves the *previous* type's
  // cached value in place — the local shell (`powershell` on Windows) then
  // leaks into a new SSH connection's Advanced → Shell field and cannot be
  // cleared (#1820). Explicitly clearing every current-schema key overrides the
  // stale cache so absent keys reset to empty.
  const schemaKey = schema.groups.map((g) => g.key).join("|");
  const prevSchemaKey = useRef(schemaKey);
  useEffect(() => {
    if (prevSchemaKey.current !== schemaKey) {
      prevSchemaKey.current = schemaKey;
      const cleared: Record<string, unknown> = {};
      for (const group of schema.groups) {
        for (const field of group.fields) {
          // Clear to `null`, not `undefined`: react-hook-form's `reset` ignores
          // keys whose value is `undefined` and falls back to its per-name value
          // cache, which is exactly what leaks the previous type's shared-name
          // field (#1820). `null` is an explicit "empty" that overrides the cache
          // and renders as blank in every widget (`value ?? ""`).
          cleared[field.key] = null;
        }
      }
      const resetValues = { ...cleared, ...settings };
      // Seed the snapshot *before* reset so the reset's watch echo is recognised
      // as a no-op and not forwarded to the parent as a spurious change.
      lastPropagatedRef.current = JSON.stringify(resetValues);
      reset(resetValues);
    }
    // Only trigger on schema change, not on every settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // Propagate every genuine form value change to the parent. Skip an emission
  // whose serialized values equal the last snapshot: that only ever happens for
  // the reset echo (values just seeded) — a real edit necessarily differs. A
  // mismatched key order can at worst cause one harmless redundant propagation;
  // it can never falsely suppress a genuine edit, since equal strings require
  // equal content.
  useEffect(() => {
    const subscription = watch((values) => {
      const snapshot = JSON.stringify(values);
      if (snapshot === lastPropagatedRef.current) return;
      lastPropagatedRef.current = snapshot;
      onChange(values as Record<string, unknown>);
    });
    return () => subscription.unsubscribe();
  }, [watch, onChange]);

  // `visibilityValues` overlays the live form values on the schema defaults so a
  // key the saved config omits evaluates `visibleWhen` as its default (the value
  // the field itself renders), plus the values derived from picked saved
  // connections (`<key>.host`, #4194).
  const visibilityValues = useMemo(
    () => ({
      ...withSchemaDefaults(schema, watchedValues),
      ...savedConnectionValues(schema, watchedValues, savedConnections),
    }),
    [schema, watchedValues, savedConnections]
  );
  const isShown = useCallback(
    (field: SettingsGroup["fields"][number]) =>
      isFieldVisible(field, visibilityValues) && !hiddenFieldKeys?.includes(field.key),
    [visibilityValues, hiddenFieldKeys]
  );

  // Port auto-adjust special-case (FTP): the schema `Condition` is `equals`-only
  // and cannot mutate a value, so when the user switches TLS Mode we snap the
  // control port to the mode's default (990 for implicit FTPS, 21 otherwise) —
  // but only when it still sits on a standard port, preserving a custom one.
  const tlsMode = watchedValues?.tlsMode as string | undefined;
  const prevTlsMode = useRef(tlsMode);
  useEffect(() => {
    const previous = prevTlsMode.current;
    prevTlsMode.current = tlsMode;
    if (!hasTlsAndPort || previous === undefined || tlsMode === previous) return;
    const currentPort = watchedValues?.port as number | undefined;
    const nextPort = ftpPortForTlsMode(tlsMode, currentPort);
    if (nextPort !== null) {
      setValue("port", nextPort, { shouldValidate: true, shouldDirty: true });
    }
    // Only react to a TLS-mode change; `watchedValues.port` is read as a live
    // snapshot and intentionally excluded to avoid re-running on port edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tlsMode, hasTlsAndPort, setValue]);

  // Overall validity + per-field error map for currently-visible fields, from
  // the hook's synchronous schema check (not react-hook-form's async error
  // proxy), so the signal is deterministic and recomputes on every value change.
  // Issues are folded onto their top-level field key. A required field hidden by
  // `visibleWhen` is excluded, so it never blocks the parent's Save.
  const validity = useMemo(() => {
    const errorMap: Record<string, string> = {};
    for (const [path, message] of Object.entries(schemaErrors)) {
      const key = path.split(".")[0];
      if (!(key in errorMap)) errorMap[key] = message;
    }
    const visibleErrors: Record<string, string> = {};
    for (const group of schema.groups) {
      for (const field of group.fields) {
        if (isShown(field) && errorMap[field.key]) {
          visibleErrors[field.key] = errorMap[field.key];
        }
      }
    }
    return { valid: Object.keys(visibleErrors).length === 0, errors: visibleErrors };
  }, [schemaErrors, isShown, schema]);

  // Only propagate when the reported validity actually changes, so typing more
  // characters into an already-valid (or already-invalid, same-errors) field
  // doesn't churn a fresh error object into the parent every keystroke.
  const lastReportedRef = useRef<string>("");
  useEffect(() => {
    const signal = `${validity.valid}|${JSON.stringify(validity.errors)}`;
    if (signal === lastReportedRef.current) return;
    lastReportedRef.current = signal;
    onValidityChange?.(validity.valid, validity.errors);
  }, [validity, onValidityChange]);

  return (
    <div data-testid="connection-settings-form">
      {schema.groups.map((group) => {
        const visibleFields = group.fields.filter(isShown);
        if (visibleFields.length === 0) return null;
        return (
          <FormGroupSection key={group.key} group={group}>
            {visibleFields.map((field) => (
              <React.Fragment key={field.key}>
                {
                  // Display-only notice fields carry no value, so they render
                  // standalone rather than through a react-hook-form Controller.
                  // Their message may name live values as `{{fieldKey}}` (#4198).
                  field.fieldType.type === "notice" ? (
                    <DynamicField
                      key={field.key}
                      field={
                        field.description
                          ? {
                              ...field,
                              description: interpolateSettings(field.description, visibilityValues),
                            }
                          : field
                      }
                      value={undefined}
                      onChange={() => {}}
                    />
                  ) : (
                    <Controller
                      key={field.key}
                      name={field.key}
                      control={control}
                      render={({ field: rhfField, fieldState }) => (
                        <DynamicField
                          field={field}
                          value={rhfField.value}
                          onChange={(value: unknown) => {
                            rhfField.onChange(value);
                            syncDisplayPort(field.key, value);
                          }}
                          onBlur={() => handleFieldBlur(field.key, rhfField.value)}
                          error={fieldState.error?.message}
                          credentialSaved={
                            credentialSavedHint &&
                            field.fieldType.type === "password" &&
                            !rhfField.value
                          }
                          availablePorts={availablePorts}
                          containerContext={
                            field.fieldType.type === "dockerContainer"
                              ? {
                                  runtime: visibilityValues.runtime as string | undefined,
                                  listingEnabled:
                                    containerListingAgentId !== undefined || localContainerListing,
                                  agentId: containerListingAgentId,
                                }
                              : undefined
                          }
                          savedConnectionContext={
                            field.fieldType.type === "savedConnection"
                              ? {
                                  connections: savedConnections,
                                  folders: connectionFolders,
                                  matchHost: matchHostOf(
                                    field.fieldType.matchHostField,
                                    visibilityValues
                                  ),
                                }
                              : undefined
                          }
                        />
                      )}
                    />
                  )
                }
                {afterField?.key === field.key && afterField.node}
              </React.Fragment>
            ))}
          </FormGroupSection>
        );
      })}
    </div>
  );
}

/** The string value of the field `key` names, for a picker's host match. */
function matchHostOf(key: string | undefined, values: Record<string, unknown>): string | undefined {
  const value = key === undefined ? undefined : values[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * One settings group section. A plain group renders its label as a static
 * heading with its fields below; a group flagged `collapsed` (progressive
 * disclosure, UX-008) delegates to {@link CollapsibleGroupSection}. Kept as a
 * thin switch so only genuinely-collapsible groups pay for the open/close
 * state.
 */
function FormGroupSection({
  group,
  children,
}: {
  group: SettingsGroup;
  children: React.ReactNode;
}) {
  if (group.collapsed === true) {
    return <CollapsibleGroupSection group={group}>{children}</CollapsibleGroupSection>;
  }
  return (
    <div className="settings-panel__category" data-testid={`form-group-${group.key}`}>
      <h3 className="settings-panel__category-title">{group.label}</h3>
      {children}
    </div>
  );
}

/**
 * A settings group rendered as an expander: a real `<button>` header with
 * `aria-expanded`/`aria-controls` and a rotating chevron, starting collapsed.
 * The fields always stay mounted — collapsing toggles the `hidden` attribute,
 * so react-hook-form keeps every value and validation still runs against the
 * live form values; nothing is unregistered or dropped.
 */
function CollapsibleGroupSection({
  group,
  children,
}: {
  group: SettingsGroup;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentId = `${useId()}-group-content`;

  return (
    <div
      className="settings-panel__category settings-panel__category--collapsible"
      data-testid={`form-group-${group.key}`}
    >
      <button
        type="button"
        className="settings-panel__category-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        data-testid={`form-group-${group.key}-toggle`}
      >
        <ChevronRight
          size={14}
          className="settings-panel__category-chevron"
          data-open={open || undefined}
          aria-hidden="true"
        />
        <span className="settings-panel__category-title settings-panel__category-title--button">
          {group.label}
        </span>
      </button>
      <div
        id={contentId}
        className="settings-panel__category-content"
        hidden={!open}
        data-testid={`form-group-${group.key}-content`}
      >
        {children}
      </div>
    </div>
  );
}
