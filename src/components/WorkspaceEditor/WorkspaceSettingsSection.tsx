import { useMemo } from "react";
import { Plus, X } from "lucide-react";

import { Button, Field, Input, NumberInput, Select, Tooltip } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { customThemeSetting } from "@/themes";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  envVarRowError,
  looksLikeSecretName,
} from "@/services/workspaceSettings";
import type { WorkspaceEnvVar, WorkspaceSettings } from "@/types/workspace";

/** Select sentinel for "no override" (Radix Select rejects an empty value). */
const INHERIT = "__inherit__";

const BUILTIN_THEMES: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "system", label: "System" },
];

interface WorkspaceSettingsSectionProps {
  /** The workspace's current (unsaved) overrides. */
  value: WorkspaceSettings;
  /** Called with the edited overrides. */
  onChange: (next: WorkspaceSettings) => void;
}

/**
 * Editor for a workspace's settings overrides (PROD-052): theme, terminal font,
 * and defaults for new local shells. Every field is optional — leaving it empty
 * inherits the global setting. A connection's own values still win.
 */
export function WorkspaceSettingsSection({ value, onChange }: WorkspaceSettingsSectionProps) {
  const { customThemes } = useProjectedSettings();
  const themeOptions = useMemo<SelectOption[]>(
    () => [
      { value: INHERIT, label: "Use global setting" },
      ...BUILTIN_THEMES,
      ...(customThemes ?? []).map((t) => ({ value: customThemeSetting(t.id), label: t.name })),
    ],
    [customThemes]
  );
  const envVars = value.envVars ?? [];

  const update = (patch: Partial<WorkspaceSettings>) => onChange({ ...value, ...patch });
  const updateEnv = (next: WorkspaceEnvVar[]) => update({ envVars: next });
  const updateEnvRow = (index: number, patch: Partial<WorkspaceEnvVar>) =>
    updateEnv(envVars.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="workspace-settings" data-testid="workspace-settings-section">
      <div className="workspace-settings__header">
        <span className="workspace-editor__label">Workspace settings</span>
        <span className="workspace-settings__hint">
          Override global settings while this workspace is active. Empty fields use the global
          setting; a connection&apos;s own values still win.
        </span>
      </div>

      <div className="workspace-settings__grid">
        <Field label="Theme" htmlFor="ws-theme">
          <Select
            id="ws-theme"
            value={value.theme ?? INHERIT}
            options={themeOptions}
            onChange={(v) => update({ theme: v === INHERIT ? undefined : v })}
            data-testid="workspace-settings-theme"
          />
        </Field>
        <Field label="Terminal font family" htmlFor="ws-font-family">
          <Input
            id="ws-font-family"
            value={value.fontFamily ?? ""}
            placeholder="Use global setting"
            onChange={(e) => update({ fontFamily: e.target.value || undefined })}
            data-testid="workspace-settings-font-family"
          />
        </Field>
        <Field
          label="Terminal font size"
          htmlFor="ws-font-size"
          hint={`${MIN_FONT_SIZE}–${MAX_FONT_SIZE} pixels`}
        >
          <NumberInput
            id="ws-font-size"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={value.fontSize ?? ""}
            placeholder="Use global setting"
            onValueChange={(v) => update({ fontSize: v === "" ? undefined : v })}
            data-testid="workspace-settings-font-size"
          />
        </Field>
        <Field
          label="Default working directory"
          htmlFor="ws-default-dir"
          hint="For new local shells that do not set their own starting directory."
        >
          <Input
            id="ws-default-dir"
            value={value.defaultWorkingDirectory ?? ""}
            placeholder="e.g. ~/projects/app"
            onChange={(e) => update({ defaultWorkingDirectory: e.target.value || undefined })}
            data-testid="workspace-settings-default-dir"
          />
        </Field>
      </div>

      <div className="workspace-settings__env">
        <span className="workspace-editor__label">Environment variables</span>
        <span className="workspace-settings__hint">
          Added to new local shells only; running sessions are not changed. Stored in plain text —
          never put passwords or tokens here.
        </span>
        {envVars.map((row, index) => {
          const error = envVarRowError(envVars, index);
          const secret = !error && looksLikeSecretName(row.key);
          return (
            <div key={index} className="workspace-settings__env-row">
              <Field
                label="Name"
                error={error ?? undefined}
                hint={
                  secret
                    ? "This looks like a secret — it would be stored in plain text."
                    : undefined
                }
                hintVariant="warning"
                data-testid={`workspace-settings-env-field-${index}`}
              >
                <Input
                  value={row.key}
                  placeholder="NAME"
                  onChange={(e) => updateEnvRow(index, { key: e.target.value })}
                  data-testid={`workspace-settings-env-key-${index}`}
                />
              </Field>
              <Field label="Value">
                <Input
                  value={row.value}
                  onChange={(e) => updateEnvRow(index, { value: e.target.value })}
                  data-testid={`workspace-settings-env-value-${index}`}
                />
              </Field>
              <Tooltip content="Remove variable" side="top">
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  className="workspace-settings__env-remove"
                  aria-label="Remove variable"
                  onClick={() => updateEnv(envVars.filter((_, i) => i !== index))}
                  data-testid={`workspace-settings-env-remove-${index}`}
                >
                  <X size={12} />
                </Button>
              </Tooltip>
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => updateEnv([...envVars, { key: "", value: "" }])}
            data-testid="workspace-settings-env-add"
          >
            <Plus size={12} />
            Add variable
          </Button>
        </div>
      </div>
    </section>
  );
}
