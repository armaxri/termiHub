import { useEffect, useId, useState } from "react";
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
  /**
   * Overrides the base `data-testid` for this field's control and its derived
   * ids (error, browse, list items, …). Defaults to `field-<key>`, so the same
   * schema field renders with a stable, unique test id even when the field is
   * reused across several instances (e.g. one per jump-host hop). Purely a test
   * hook — it has no user-visible or behavioural effect.
   */
  testId?: string;
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
  testId,
}: DynamicFieldProps) {
  const reactId = useId();

  // Base data-testid token for this field. Defaults to `field-<key>`; callers
  // that render the same field many times (per jump-host hop) pass a unique
  // value so the ids stay addressable and never collide.
  const testIdBase = testId ?? `field-${field.key}`;

  // Display-only callout: render the standalone banner without the label /
  // hint / error scaffolding used by input fields.
  if (field.fieldType.type === "notice") {
    return (
      <NoticeField field={field} severity={field.fieldType.severity} testIdBase={testIdBase} />
    );
  }

  // Stable, unique ids so the visible label, the control, and the inline error
  // are programmatically associated (WCAG 1.3.1 / 3.3.1 / 3.3.2 / 4.1.2). The
  // control gets `id`, the label `htmlFor={id}`, and the control points at the
  // error/description via `aria-describedby`.
  const controlId = `${reactId}-${field.key}`;
  const errorId = `${controlId}-error`;
  const descriptionId = field.description ? `${controlId}-description` : undefined;
  const hasError = Boolean(error);
  const describedBy =
    [hasError ? errorId : null, descriptionId].filter(Boolean).join(" ") || undefined;
  const a11y: FieldA11y = { id: controlId, describedBy, invalid: hasError };

  return (
    <div className="settings-form__field" data-testid={`dynamic-${testIdBase}`}>
      {renderFieldInput(
        field,
        field.fieldType,
        value,
        onChange,
        a11y,
        testIdBase,
        availablePorts,
        onBlur
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="settings-form__hint settings-form__hint--error"
          data-testid={`${testIdBase}-error`}
        >
          {error}
        </p>
      )}
      {field.description && (
        <p id={descriptionId} className="settings-form__hint">
          {field.description}
        </p>
      )}
      {credentialSaved && (
        <p
          className="settings-form__hint settings-form__hint--success"
          data-testid={`${testIdBase}-credential-saved`}
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
  a11y: FieldA11y,
  testIdBase: string,
  availablePorts?: string[],
  onBlur?: () => void
): React.ReactNode {
  switch (fieldType.type) {
    case "text":
      return (
        <TextField
          field={field}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "password":
      return (
        <PasswordField
          field={field}
          value={value}
          onChange={onChange}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "number":
      return (
        <NumberField
          field={field}
          value={value}
          onChange={onChange}
          fieldType={fieldType}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "boolean":
      return (
        <BooleanField
          field={field}
          value={value}
          onChange={onChange}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "select":
      return (
        <SelectField
          field={field}
          value={value}
          onChange={onChange}
          fieldType={fieldType}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "port":
      return (
        <PortField
          field={field}
          value={value}
          onChange={onChange}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "serialPort":
      return (
        <SerialPortField
          field={field}
          value={value}
          onChange={onChange}
          availablePorts={availablePorts}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "filePath":
      return (
        <FilePathField
          field={field}
          value={value}
          onChange={onChange}
          fieldType={fieldType}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "keyValueList":
      return (
        <KeyValueListField
          field={field}
          value={value}
          onChange={onChange}
          testIdBase={testIdBase}
        />
      );
    case "objectList":
      return (
        <ObjectListField
          field={field}
          value={value}
          onChange={onChange}
          fieldType={fieldType}
          testIdBase={testIdBase}
        />
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
function NoticeField({
  field,
  severity,
  testIdBase,
}: {
  field: SettingsField;
  severity: "info" | "warning";
  testIdBase: string;
}) {
  const Icon = severity === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={`settings-form__notice settings-form__notice--${severity}`}
      role="note"
      data-testid={testIdBase}
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
 * Accessibility wiring computed once per field in {@link DynamicField} and
 * threaded to each control: the control's `id` (matched by the label's
 * `htmlFor`), the `aria-describedby` target (error + description ids), and
 * whether the field is currently invalid.
 */
interface FieldA11y {
  /** `id` set on the control and referenced by the label's `htmlFor`. */
  id: string;
  /** Space-separated ids of the error/description nodes, or `undefined`. */
  describedBy?: string;
  /** True when a validation error is present (sets `aria-invalid`). */
  invalid: boolean;
}

/**
 * The "?" help affordance shared by every field type (UX-009). Renders a ghost
 * icon Button that opens a {@link Modal} with the field's extended `helpText`,
 * split on blank lines into paragraphs. Returns `null` when the field has no
 * `helpText`, so it costs nothing for the common case. Test hooks:
 * `${testIdBase}-help` (button) and `${testIdBase}-help-dialog` (modal).
 */
function FieldHelp({ field, testIdBase }: { field: SettingsField; testIdBase: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!field.helpText) return null;
  return (
    <>
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
        data-testid={`${testIdBase}-help`}
      />
      <Modal
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={field.label}
        data-testid={`${testIdBase}-help-dialog`}
      >
        {field.helpText.split("\n\n").map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </Modal>
    </>
  );
}

/**
 * Field label with a required marker for required fields, plus the shared "?"
 * help affordance when the field declares `helpText` (UX-009). Renders a real
 * `<label htmlFor>` so screen readers associate the visible name with the
 * control (WCAG 1.3.1 / 3.3.2); the help {@link Button} sits *beside* the label
 * (not nested inside it) so it is a separate interactive target. List/group
 * fields with no single control omit `htmlFor`. The asterisk is `aria-hidden`
 * (decorative); inputs also carry `aria-required` for assistive tech.
 */
function FieldLabel({
  field,
  htmlFor,
  testIdBase,
}: {
  field: SettingsField;
  htmlFor?: string;
  testIdBase: string;
}) {
  return (
    <div className="settings-form__label-row">
      <label className="settings-form__label" htmlFor={htmlFor}>
        {field.label}
        {field.required && (
          <span className="settings-form__required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      <FieldHelp field={field} testIdBase={testIdBase} />
    </div>
  );
}

function TextField({
  field,
  value,
  onChange,
  onBlur,
  a11y,
  testIdBase,
}: FieldProps & { onBlur?: () => void; a11y: FieldA11y; testIdBase: string }) {
  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <Input
        id={a11y.id}
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        aria-describedby={a11y.describedBy}
        error={a11y.invalid}
        data-testid={testIdBase}
      />
    </>
  );
}

function PasswordField({
  field,
  value,
  onChange,
  a11y,
  testIdBase,
}: FieldProps & { a11y: FieldA11y; testIdBase: string }) {
  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <PasswordInput
        id={a11y.id}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        aria-describedby={a11y.describedBy}
        aria-invalid={a11y.invalid}
        data-testid={testIdBase}
      />
    </>
  );
}

function NumberField({
  field,
  value,
  onChange,
  fieldType,
  a11y,
  testIdBase,
}: FieldProps & {
  fieldType: { type: "number"; min?: number; max?: number };
  a11y: FieldA11y;
  testIdBase: string;
}) {
  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <NumberInput
        id={a11y.id}
        value={value != null ? Number(value) : ""}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        min={fieldType.min}
        max={fieldType.max}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        aria-describedby={a11y.describedBy}
        error={a11y.invalid}
        data-testid={testIdBase}
      />
    </>
  );
}

function BooleanField({
  field,
  value,
  onChange,
  a11y,
  testIdBase,
}: FieldProps & { a11y: FieldA11y; testIdBase: string }) {
  return (
    <>
      <span className="settings-form__label-row">
        <span className="settings-form__label">{field.label}</span>
        <FieldHelp field={field} testIdBase={testIdBase} />
      </span>
      <Toggle
        id={a11y.id}
        checked={(value as boolean) ?? (field.default as boolean) ?? false}
        onCheckedChange={(checked) => onChange(checked)}
        aria-label={field.label}
        aria-describedby={a11y.describedBy}
        data-testid={testIdBase}
      />
    </>
  );
}

function SelectField({
  field,
  value,
  onChange,
  fieldType,
  a11y,
  testIdBase,
}: FieldProps & {
  fieldType: { type: "select"; options: { value: string; label: string }[] };
  a11y: FieldA11y;
  testIdBase: string;
}) {
  const isLocked = fieldType.options.length <= 1;
  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <Select
        id={a11y.id}
        value={(value as string) || undefined}
        onChange={(v) => onChange(v)}
        options={fieldType.options}
        disabled={isLocked}
        aria-label={field.label}
        aria-describedby={a11y.describedBy}
        aria-invalid={a11y.invalid}
        placeholder={field.placeholder}
        data-testid={testIdBase}
      />
    </>
  );
}

function PortField({
  field,
  value,
  onChange,
  a11y,
  testIdBase,
}: FieldProps & { a11y: FieldA11y; testIdBase: string }) {
  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <NumberInput
        id={a11y.id}
        aria-describedby={a11y.describedBy}
        error={a11y.invalid}
        value={value != null ? Number(value) : ""}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        min={1}
        max={65535}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        data-testid={testIdBase}
      />
    </>
  );
}

function SerialPortField({
  field,
  value,
  onChange,
  availablePorts: propPorts,
  a11y,
  testIdBase,
}: FieldProps & { availablePorts?: string[]; a11y: FieldA11y; testIdBase: string }) {
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
  const listId = `${testIdBase}-list`;

  return (
    <>
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <Input
        id={a11y.id}
        type="text"
        value={currentValue}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        list={listId}
        autoComplete="off"
        spellCheck={false}
        aria-required={field.required || undefined}
        aria-describedby={a11y.describedBy}
        error={a11y.invalid}
        data-testid={testIdBase}
      />
      <datalist id={listId}>
        {availablePorts.map((port) => (
          <option key={port} value={port} />
        ))}
      </datalist>
      {isDisconnected && (
        <p className="settings-form__hint" data-testid={`${testIdBase}-disconnected`}>
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
  a11y,
  testIdBase,
}: FieldProps & {
  fieldType: { type: "filePath"; kind: string };
  a11y: FieldA11y;
  testIdBase: string;
}) {
  if (field.key === "keyPath") {
    return (
      <>
        <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
        <KeyPathInput
          id={a11y.id}
          value={(value as string) ?? ""}
          onChange={(v) => onChange(v || undefined)}
          placeholder={field.placeholder}
          testIdPrefix={testIdBase}
          aria-describedby={a11y.describedBy}
          aria-invalid={a11y.invalid}
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
      <FieldLabel field={field} htmlFor={a11y.id} testIdBase={testIdBase} />
      <div className="settings-form__file-row">
        <Input
          id={a11y.id}
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={field.placeholder}
          aria-required={field.required || undefined}
          aria-describedby={a11y.describedBy}
          error={a11y.invalid}
          data-testid={testIdBase}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleBrowse}
          title="Browse"
          data-testid={`${testIdBase}-browse`}
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

function KeyValueListField({
  field,
  value,
  onChange,
  testIdBase,
}: FieldProps & { testIdBase: string }) {
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
      <FieldLabel field={field} testIdBase={testIdBase} />
      {items.map((item, index) => (
        <div key={index} className="settings-form__list-row">
          <Input
            type="text"
            value={item.key}
            onChange={(e) => handleUpdate(index, "key", e.target.value)}
            placeholder="KEY"
            className="settings-form__list-input"
            data-testid={`${testIdBase}-key-${index}`}
          />
          <Input
            type="text"
            value={item.value}
            onChange={(e) => handleUpdate(index, "value", e.target.value)}
            placeholder="value"
            className="settings-form__list-input"
            data-testid={`${testIdBase}-value-${index}`}
          />
          <Button
            variant="ghost"
            size="sm"
            className="settings-form__list-remove"
            onClick={() => handleRemove(index)}
            title="Remove"
            aria-label="Remove"
            data-testid={`${testIdBase}-remove-${index}`}
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
        data-testid={`${testIdBase}-add`}
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
  testIdBase,
}: FieldProps & {
  fieldType: { type: "objectList"; fields: SettingsField[] };
  testIdBase: string;
}) {
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
      <FieldLabel field={field} testIdBase={testIdBase} />
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
                    data-testid={`${testIdBase}-${subField.key}-${index}`}
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
                    data-testid={`${testIdBase}-${subField.key}-${index}`}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleBrowseDir(index, subField.key)}
                    title="Browse"
                    data-testid={`${testIdBase}-${subField.key}-browse-${index}`}
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
                data-testid={`${testIdBase}-${subField.key}-${index}`}
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
            data-testid={`${testIdBase}-remove-${index}`}
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
        data-testid={`${testIdBase}-add`}
      >
        Add
      </Button>
    </>
  );
}
