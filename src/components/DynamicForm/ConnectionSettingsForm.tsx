import { useCallback, useEffect, useMemo, useRef } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { SettingsSchema } from "@/types/schema";
import { isFieldVisible } from "@/utils/schemaDefaults";
import { parseHostPort } from "@/utils/parseHostPort";
import { ftpPortForTlsMode } from "@/utils/ftpSecurity";
import { vncPortForDisplay } from "@/utils/vncDisplayPort";
import { settingsSchemaToZod } from "./settingsSchemaToZod";
import { DynamicField } from "./DynamicField";

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
   * Reports overall client-side validity plus a per-field error map (keyed by
   * field key) whenever validation state changes. Only currently-visible fields
   * are considered, so a required field hidden by `visibleWhen` never blocks.
   * The parent uses this to disable Save/Save & Connect on invalid input.
   */
  onValidityChange?: (valid: boolean, errors: Record<string, string>) => void;
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
  onValidityChange,
}: ConnectionSettingsFormProps) {
  const zodSchema = useMemo(() => settingsSchemaToZod(schema), [schema]);

  const { control, watch, reset, setValue, getValues } = useForm<Record<string, unknown>>({
    defaultValues: settings,
    resolver: zodResolver(zodSchema),
    mode: "onChange",
  });

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

  // Reset the form when the connection type changes (schema groups differ).
  // isResetting suppresses the watch callback that reset fires synchronously,
  // preventing a spurious onChange call back to the parent on type switch.
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
  const isResetting = useRef(false);
  useEffect(() => {
    if (prevSchemaKey.current !== schemaKey) {
      prevSchemaKey.current = schemaKey;
      isResetting.current = true;
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
      reset({ ...cleared, ...settings });
    }
    // Only trigger on schema change, not on every settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // Propagate every form value change to the parent.
  useEffect(() => {
    const subscription = watch((values) => {
      if (isResetting.current) {
        isResetting.current = false;
        return;
      }
      onChange(values as Record<string, unknown>);
    });
    return () => subscription.unsubscribe();
  }, [watch, onChange]);

  // Live form values used for visibleWhen evaluation.
  const watchedValues = useWatch({ control });

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

  // Overall validity + per-field error map for currently-visible fields. We run
  // the zod schema directly against the watched values (rather than reading
  // react-hook-form's async error proxy) so the signal is deterministic and
  // recomputes on every value change. A required field hidden by `visibleWhen`
  // is excluded, so it never blocks the parent's Save.
  const validity = useMemo(() => {
    const errorMap: Record<string, string> = {};
    const result = zodSchema.safeParse(watchedValues);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !(key in errorMap)) {
          errorMap[key] = issue.message;
        }
      }
    }
    const visibleErrors: Record<string, string> = {};
    for (const group of schema.groups) {
      for (const field of group.fields) {
        if (isFieldVisible(field, watchedValues) && errorMap[field.key]) {
          visibleErrors[field.key] = errorMap[field.key];
        }
      }
    }
    return { valid: Object.keys(visibleErrors).length === 0, errors: visibleErrors };
  }, [zodSchema, watchedValues, schema]);

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
        const visibleFields = group.fields.filter((f) => isFieldVisible(f, watchedValues));
        if (visibleFields.length === 0) return null;
        return (
          <div
            className="settings-panel__category"
            key={group.key}
            data-testid={`form-group-${group.key}`}
          >
            <h3 className="settings-panel__category-title">{group.label}</h3>
            {visibleFields.map((field) =>
              // Display-only notice fields carry no value, so they render
              // standalone rather than through a react-hook-form Controller.
              field.fieldType.type === "notice" ? (
                <DynamicField key={field.key} field={field} value={undefined} onChange={() => {}} />
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
                    />
                  )}
                />
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
