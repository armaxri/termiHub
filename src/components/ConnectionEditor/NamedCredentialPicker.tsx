import { useMemo } from "react";
import { Field, Select } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { useNamedCredentials } from "@/hooks/useNamedCredentials";
import type { NamedCredentialKind } from "@/types/generated/NamedCredentialKind";

/** Select value meaning "no shared credential — use this connection's own". */
const OWN_CREDENTIAL_VALUE = "__own__";
/** Select value shown while the reference points at a credential that is gone. */
const MISSING_VALUE = "__missing__";

interface NamedCredentialPickerProps {
  /** The connection's auth method; only `password` and `key` use a secret. */
  authMethod: string | undefined;
  /** The current `credentialRef`, or undefined for a per-connection secret. */
  value: string | undefined;
  /** Called with the chosen credential id, or undefined for "own secret". */
  onChange: (credentialRef: string | undefined) => void;
}

/** The kind of shared credential an auth method can use, if any. */
function kindFor(authMethod: string | undefined): NamedCredentialKind | null {
  if (authMethod === "password") return "password";
  if (authMethod === "key") return "key_passphrase";
  return null;
}

/**
 * Connection-editor control to use a shared named credential (#3557) instead
 * of this connection's own password / key passphrase. Offers only credentials
 * of the kind the auth method needs. Hidden when the auth method needs no
 * secret, or when no matching shared credential exists and none is selected.
 */
export function NamedCredentialPicker({ authMethod, value, onChange }: NamedCredentialPickerProps) {
  const { entries } = useNamedCredentials();
  const kind = kindFor(authMethod);

  const matching = useMemo(
    () => entries.filter((e) => e.credential.kind === kind),
    [entries, kind]
  );
  const selected = value ? matching.find((e) => e.credential.id === value) : undefined;
  const missing = Boolean(value) && !selected;

  if (!kind || (matching.length === 0 && !value)) return null;

  const ownLabel =
    kind === "password" ? "This connection's password" : "This connection's passphrase";
  const options: SelectOption[] = [
    { value: OWN_CREDENTIAL_VALUE, label: ownLabel },
    ...matching.map((e) => ({ value: e.credential.id, label: e.credential.name })),
  ];
  if (missing) {
    options.push({ value: MISSING_VALUE, label: "Missing shared credential", disabled: true });
  }

  const hint = missing
    ? "The selected shared credential no longer exists (or holds a different kind of secret). Choose another one, or use this connection's own."
    : selected
      ? "Uses the shared credential — change or rotate it once in Settings → Security for every connection that uses it."
      : undefined;

  return (
    <div data-testid="named-credential-picker">
      <Field
        label={kind === "password" ? "Password source" : "Passphrase source"}
        variant="settings"
        hint={hint}
        hintVariant={missing ? "warning" : "default"}
      >
        <Select
          value={missing ? MISSING_VALUE : (value ?? OWN_CREDENTIAL_VALUE)}
          onChange={(next) => onChange(next === OWN_CREDENTIAL_VALUE ? undefined : next)}
          options={options}
          data-testid="named-credential-select"
        />
      </Field>
    </div>
  );
}
