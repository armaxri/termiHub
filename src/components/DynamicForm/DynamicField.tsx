import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HelpCircle, Info, Plus, TriangleAlert, X } from "lucide-react";
import type { SettingsField, FieldType } from "@/types/schema";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { listSerialPorts } from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, Input, Modal, NumberInput, Select, Toggle } from "@/components/ui";

interface DynamicFieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (value: unknown) => void;
  /**
   * Called when the field loses focus. Currently only wired for text fields
   * (used by the connection form to auto-extract `host:port` from the Host
   * field on blur — see `ConnectionSettingsForm`).
   */
  onBlur?: () => void;
  /** Validation error message to display inline below the field. */
  error?: string;
  /** When true, shows a "Password saved in credential store" hint below password fields. */
  credentialSaved?: boolean;
  /**
   * Pre-supplied list of serial port names for `serialPort` fields.
   * When provided, the field shows these instead of querying the local system.
   * Use this to pass ports from a remote agent's capabilities.
   */
  availablePorts?: string[];
}

/**
 * Renders a single settings field based on its `fieldType`.
 *
 * Dispatches to the appropriate input widget (text, password, number,
 * boolean toggle, select, port, file path, key-value list, object list).
 * Boolean fields use the toggle-row layout; all others use the column layout.
 */
export function DynamicField({
  field,
  value,
  onChange,
  onBlur,
  error,
  credentialSaved,
  availablePorts,
}: DynamicFieldProps) {
  // Display-only callout: render the standalone banner without the label /
  // hint / error scaffolding used by input fields.
  if (field.fieldType.type === "notice") {
    return <NoticeField field={field} severity={field.fieldType.severity} />;
  }

  return (
    <div className="settings-form__field" data-testid={`dynamic-field-${field.key}`}>
      {renderFieldInput(field, field.fieldType, value, onChange, availablePorts, onBlur)}
      {error && (
        <p
          className="settings-form__hint settings-form__hint--error"
          data-testid={`field-${field.key}-error`}
        >
          {error}
        </p>
      )}
      {field.description && <p className="settings-form__hint">{field.description}</p>}
      {credentialSaved && (
        <p
          className="settings-form__hint settings-form__hint--success"
          data-testid={`field-${field.key}-credential-saved`}
        >
          Password saved in credential store
        </p>
      )}
    </div>
  );
}

function renderFieldInput(
  field: SettingsField,
  fieldType: FieldType,
  value: unknown,
  onChange: (v: unknown) => void,
  availablePorts?: string[],
  onBlur?: () => void
): React.ReactNode {
  switch (fieldType.type) {
    case "text":
      return <TextField field={field} value={value} onChange={onChange} onBlur={onBlur} />;
    case "password":
      return <PasswordField field={field} value={value} onChange={onChange} />;
    case "number":
      return <NumberField field={field} value={value} onChange={onChange} fieldType={fieldType} />;
    case "boolean":
      return <BooleanField field={field} value={value} onChange={onChange} />;
    case "select":
      return <SelectField field={field} value={value} onChange={onChange} fieldType={fieldType} />;
    case "port":
      return <PortField field={field} value={value} onChange={onChange} />;
    case "serialPort":
      return (
        <SerialPortField
          field={field}
          value={value}
          onChange={onChange}
          availablePorts={availablePorts}
        />
      );
    case "filePath":
      return (
        <FilePathField field={field} value={value} onChange={onChange} fieldType={fieldType} />
      );
    case "keyValueList":
      return <KeyValueListField field={field} value={value} onChange={onChange} />;
    case "objectList":
      return (
        <ObjectListField field={field} value={value} onChange={onChange} fieldType={fieldType} />
      );
    case "notice":
      // Notice fields are handled up-front in DynamicField and never reach here.
      return null;
  }
}

/**
 * Display-only informational or warning callout, rendered from a field's
 * `description`. Used e.g. for the plain-FTP insecure-connection warning, which
 * the schema shows only while `tlsMode === "none"` via `visibleWhen`.
 */
function NoticeField({ field, severity }: { field: SettingsField; severity: "info" | "warning" }) {
  const Icon = severity === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={`settings-form__notice settings-form__notice--${severity}`}
      role="note"
      data-testid={`field-${field.key}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{field.description}</span>
    </div>
  );
}

// --- Individual field type components ---

interface FieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
}

/**
 * Field label with a required marker for required fields. The asterisk is
 * `aria-hidden` (decorative); inputs carry `aria-required` for assistive tech.
 */
function FieldLabel({ field }: { field: SettingsField }) {
  return (
    <span className="settings-form__label">
      {field.label}
      {field.required && (
        <span className="settings-form__required" aria-hidden="true">
          {" "}
          *
        </span>
      )}
    </span>
  );
}

function TextField({ field, value, onChange, onBlur }: FieldProps & { onBlur?: () => void }) {
  return (
    <>
      <FieldLabel field={field} />
      <Input
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function PasswordField({ field, value, onChange }: FieldProps) {
  return (
    <>
      <FieldLabel field={field} />
      <PasswordInput
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function NumberField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "number"; min?: number; max?: number } }) {
  return (
    <>
      <FieldLabel field={field} />
      <NumberInput
        value={value != null ? Number(value) : ""}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        min={fieldType.min}
        max={fieldType.max}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function BooleanField({ field, value, onChange }: FieldProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <span className="settings-form__label">
        {field.label}
        {field.helpText && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="settings-form__help"
            icon={<HelpCircle size={13} />}
            onClick={(e) => {
              e.preventDefault();
              setDialogOpen(true);
            }}
            title="Learn more"
            data-testid={`field-${field.key}-help`}
          />
        )}
      </span>
      <Toggle
        checked={(value as boolean) ?? (field.default as boolean) ?? false}
        onCheckedChange={(checked) => onChange(checked)}
        aria-label={field.label}
        data-testid={`field-${field.key}`}
      />
      {field.helpText && (
        <Modal
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={field.label}
          data-testid={`field-${field.key}-help-dialog`}
        >
          {field.helpText.split("\n\n").map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </Modal>
      )}
    </>
  );
}

function SelectField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "select"; options: { value: string; label: string }[] } }) {
  const isLocked = fieldType.options.length <= 1;
  return (
    <>
      <FieldLabel field={field} />
      <Select
        value={(value as string) || undefined}
        onChange={(v) => onChange(v)}
        options={fieldType.options}
        disabled={isLocked}
        aria-label={field.label}
        placeholder={field.placeholder}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function PortField({ field, value, onChange }: FieldProps) {
  return (
    <>
      <FieldLabel field={field} />
      <NumberInput
        value={value != null ? Number(value) : ""}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        min={1}
        max={65535}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function SerialPortField({
  field,
  value,
  onChange,
  availablePorts: propPorts,
}: FieldProps & { availablePorts?: string[] }) {
  const [detectedPorts, setDetectedPorts] = useState<string[]>([]);
  const currentValue = (value as string) ?? "";

  useEffect(() => {
    if (propPorts !== undefined) return;
    listSerialPorts()
      .then(setDetectedPorts)
      .catch(() => setDetectedPorts([]));
  }, [propPorts]);

  const availablePorts = propPorts ?? detectedPorts;
  const isDisconnected = currentValue !== "" && !availablePorts.includes(currentValue);
  // An editable combobox (input + datalist) rather than a plain <select>: the
  // detected ports are offered as suggestions, but the user can still type any
  // device path the OS doesn't enumerate (a virtual/socat PTY, an uncommon
  // /dev path) — matching the field's "or type a device path directly" intent.
  const listId = `field-${field.key}-list`;

  return (
    <>
      <FieldLabel field={field} />
      <Input
        type="text"
        value={currentValue}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        list={listId}
        autoComplete="off"
        spellCheck={false}
        aria-required={field.required || undefined}
        data-testid={`field-${field.key}`}
      />
      <datalist id={listId}>
        {availablePorts.map((port) => (
          <option key={port} value={port} />
        ))}
      </datalist>
      {isDisconnected && (
        <p className="settings-form__hint" data-testid={`field-${field.key}-disconnected`}>
          {currentValue} (not connected)
        </p>
      )}
    </>
  );
}

function FilePathField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "filePath"; kind: string } }) {
  if (field.key === "keyPath") {
    return (
      <>
        <FieldLabel field={field} />
        <KeyPathInput
          value={(value as string) ?? ""}
          onChange={(v) => onChange(v || undefined)}
          placeholder={field.placeholder}
          testIdPrefix={`field-${field.key}`}
        />
      </>
    );
  }

  const handleBrowse = async () => {
    const isDirectory = fieldType.kind === "directory";
    const selected = await open({
      directory: isDirectory,
      title: `Select ${field.label}`,
    });
    if (selected) {
      onChange(selected as string);
    }
  };

  return (
    <>
      <FieldLabel field={field} />
      <div className="settings-form__file-row">
        <Input
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={field.placeholder}
          aria-required={field.required || undefined}
          data-testid={`field-${field.key}`}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleBrowse}
          title="Browse"
          data-testid={`field-${field.key}-browse`}
        >
          ...
        </Button>
      </div>
    </>
  );
}

interface KeyValuePair {
  key: string;
  value: string;
}

function KeyValueListField({ field, value, onChange }: FieldProps) {
  const items = (value as KeyValuePair[]) ?? [];

  const handleAdd = () => {
    onChange([...items, { key: "", value: "" }]);
  };

  const handleUpdate = (index: number, itemField: "key" | "value", v: string) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [itemField]: v };
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  return (
    <>
      <FieldLabel field={field} />
      {items.map((item, index) => (
        <div key={index} className="settings-form__list-row">
          <Input
            type="text"
            value={item.key}
            onChange={(e) => handleUpdate(index, "key", e.target.value)}
            placeholder="KEY"
            className="settings-form__list-input"
            data-testid={`field-${field.key}-key-${index}`}
          />
          <Input
            type="text"
            value={item.value}
            onChange={(e) => handleUpdate(index, "value", e.target.value)}
            placeholder="value"
            className="settings-form__list-input"
            data-testid={`field-${field.key}-value-${index}`}
          />
          <Button
            variant="ghost"
            size="sm"
            className="settings-form__list-remove"
            onClick={() => handleRemove(index)}
            title="Remove"
            aria-label="Remove"
            data-testid={`field-${field.key}-remove-${index}`}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={14} />}
        onClick={handleAdd}
        data-testid={`field-${field.key}-add`}
      >
        Add
      </Button>
    </>
  );
}

function ObjectListField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "objectList"; fields: SettingsField[] } }) {
  const items = (value as Record<string, unknown>[]) ?? [];

  const handleAdd = () => {
    const newItem: Record<string, unknown> = {};
    for (const subField of fieldType.fields) {
      if (subField.default !== undefined) {
        newItem[subField.key] = subField.default;
      } else if (subField.fieldType.type === "boolean") {
        newItem[subField.key] = false;
      } else {
        newItem[subField.key] = "";
      }
    }
    onChange([...items, newItem]);
  };

  const handleUpdate = (index: number, key: string, v: unknown) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [key]: v };
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const handleBrowseDir = async (index: number, key: string) => {
    const selected = await open({ directory: true, title: "Select directory" });
    if (selected) {
      handleUpdate(index, key, selected);
    }
  };

  return (
    <>
      <FieldLabel field={field} />
      {items.map((item, index) => (
        <div key={index} className="settings-form__list-row">
          {fieldType.fields.map((subField) => {
            if (subField.fieldType.type === "boolean") {
              return (
                <label
                  key={subField.key}
                  className="settings-form__list-checkbox"
                  title={subField.label}
                >
                  <Toggle
                    checked={(item[subField.key] as boolean) ?? false}
                    onCheckedChange={(checked) => handleUpdate(index, subField.key, checked)}
                    aria-label={subField.label}
                    data-testid={`field-${field.key}-${subField.key}-${index}`}
                  />
                  {subField.label.length <= 3 ? subField.label : subField.label.slice(0, 2)}
                </label>
              );
            }
            if (subField.fieldType.type === "filePath" && subField.fieldType.kind === "directory") {
              return (
                <span key={subField.key} style={{ display: "contents" }}>
                  <Input
                    type="text"
                    value={(item[subField.key] as string) ?? ""}
                    onChange={(e) => handleUpdate(index, subField.key, e.target.value)}
                    placeholder={subField.placeholder ?? subField.label}
                    className="settings-form__list-input"
                    data-testid={`field-${field.key}-${subField.key}-${index}`}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleBrowseDir(index, subField.key)}
                    title="Browse"
                    data-testid={`field-${field.key}-${subField.key}-browse-${index}`}
                  >
                    ...
                  </Button>
                </span>
              );
            }
            return (
              <Input
                key={subField.key}
                type="text"
                value={(item[subField.key] as string) ?? ""}
                onChange={(e) => handleUpdate(index, subField.key, e.target.value)}
                placeholder={subField.placeholder ?? subField.label}
                className="settings-form__list-input"
                data-testid={`field-${field.key}-${subField.key}-${index}`}
              />
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="settings-form__list-remove"
            onClick={() => handleRemove(index)}
            title="Remove"
            aria-label="Remove"
            data-testid={`field-${field.key}-remove-${index}`}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={14} />}
        onClick={handleAdd}
        data-testid={`field-${field.key}-add`}
      >
        Add
      </Button>
    </>
  );
}
