import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SettingsField, FieldType } from "@/types/schema";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";

interface DynamicFieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}

/**
 * Renders a single settings field based on its `fieldType`.
 *
 * Dispatches to the appropriate input widget (text, password, number,
 * boolean toggle, select, port, file path, key-value list, object list).
 */
export function DynamicField({ field, value, onChange }: DynamicFieldProps) {
  const handleChange = useCallback((v: unknown) => onChange(field.key, v), [field.key, onChange]);

  return (
    <div className="settings-form__field" data-testid={`dynamic-field-${field.key}`}>
      {renderFieldInput(field, field.fieldType, value, handleChange)}
      {field.description && <p className="settings-form__hint">{field.description}</p>}
    </div>
  );
}

function renderFieldInput(
  field: SettingsField,
  fieldType: FieldType,
  value: unknown,
  onChange: (v: unknown) => void
): React.ReactNode {
  switch (fieldType.type) {
    case "text":
      return <TextField field={field} value={value} onChange={onChange} />;
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
  }
}

// --- Individual field type components ---

interface FieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
}

function TextField({ field, value, onChange }: FieldProps) {
  return (
    <>
      <span className="settings-form__label">{field.label}</span>
      <input
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function PasswordField({ field, value, onChange }: FieldProps) {
  return (
    <>
      <span className="settings-form__label">{field.label}</span>
      <input
        type="password"
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
      <span className="settings-form__label">{field.label}</span>
      <input
        type="number"
        value={value != null ? Number(value) : ""}
        onChange={(e) => {
          const v = e.target.value === "" ? undefined : Number(e.target.value);
          onChange(v);
        }}
        min={fieldType.min}
        max={fieldType.max}
        placeholder={field.placeholder}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function BooleanField({ field, value, onChange }: FieldProps) {
  return (
    <label className="settings-form__field--checkbox" data-testid={`field-${field.key}-wrapper`}>
      <input
        type="checkbox"
        checked={(value as boolean) ?? false}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={`field-${field.key}`}
      />
      <span className="settings-form__label">{field.label}</span>
    </label>
  );
}

function SelectField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "select"; options: { value: string; label: string }[] } }) {
  return (
    <>
      <span className="settings-form__label">{field.label}</span>
      <select
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`field-${field.key}`}
      >
        {fieldType.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </>
  );
}

function PortField({ field, value, onChange }: FieldProps) {
  return (
    <>
      <span className="settings-form__label">{field.label}</span>
      <input
        type="number"
        value={value != null ? Number(value) : ""}
        onChange={(e) => {
          const v = e.target.value === "" ? undefined : Number(e.target.value);
          onChange(v);
        }}
        min={1}
        max={65535}
        placeholder={field.placeholder}
        data-testid={`field-${field.key}`}
      />
    </>
  );
}

function FilePathField({
  field,
  value,
  onChange,
  fieldType,
}: FieldProps & { fieldType: { type: "filePath"; kind: string } }) {
  // Special case: SSH key path fields use the KeyPathInput combobox
  if (field.key === "keyPath") {
    return (
      <>
        <span className="settings-form__label">{field.label}</span>
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
      <span className="settings-form__label">{field.label}</span>
      <div className="settings-form__file-row">
        <input
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={field.placeholder}
          data-testid={`field-${field.key}`}
        />
        <button
          type="button"
          className="settings-form__list-browse"
          onClick={handleBrowse}
          title="Browse"
          data-testid={`field-${field.key}-browse`}
        >
          ...
        </button>
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
      <span className="settings-form__label">{field.label}</span>
      {items.map((item, index) => (
        <div key={index} className="settings-form__list-row">
          <input
            type="text"
            value={item.key}
            onChange={(e) => handleUpdate(index, "key", e.target.value)}
            placeholder="KEY"
            className="settings-form__list-input"
            data-testid={`field-${field.key}-key-${index}`}
          />
          <input
            type="text"
            value={item.value}
            onChange={(e) => handleUpdate(index, "value", e.target.value)}
            placeholder="value"
            className="settings-form__list-input"
            data-testid={`field-${field.key}-value-${index}`}
          />
          <button
            type="button"
            className="settings-form__list-remove"
            onClick={() => handleRemove(index)}
            title="Remove"
            data-testid={`field-${field.key}-remove-${index}`}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-form__list-add"
        onClick={handleAdd}
        data-testid={`field-${field.key}-add`}
      >
        + Add
      </button>
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
      <span className="settings-form__label">{field.label}</span>
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
                  <input
                    type="checkbox"
                    checked={(item[subField.key] as boolean) ?? false}
                    onChange={(e) => handleUpdate(index, subField.key, e.target.checked)}
                    data-testid={`field-${field.key}-${subField.key}-${index}`}
                  />
                  {subField.label.length <= 3 ? subField.label : subField.label.slice(0, 2)}
                </label>
              );
            }
            if (subField.fieldType.type === "filePath" && subField.fieldType.kind === "directory") {
              return (
                <span key={subField.key} style={{ display: "contents" }}>
                  <input
                    type="text"
                    value={(item[subField.key] as string) ?? ""}
                    onChange={(e) => handleUpdate(index, subField.key, e.target.value)}
                    placeholder={subField.placeholder ?? subField.label}
                    className="settings-form__list-input"
                    data-testid={`field-${field.key}-${subField.key}-${index}`}
                  />
                  <button
                    type="button"
                    className="settings-form__list-browse"
                    onClick={() => handleBrowseDir(index, subField.key)}
                    title="Browse"
                    data-testid={`field-${field.key}-${subField.key}-browse-${index}`}
                  >
                    ...
                  </button>
                </span>
              );
            }
            return (
              <input
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
          <button
            type="button"
            className="settings-form__list-remove"
            onClick={() => handleRemove(index)}
            title="Remove"
            data-testid={`field-${field.key}-remove-${index}`}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-form__list-add"
        onClick={handleAdd}
        data-testid={`field-${field.key}-add`}
      >
        + Add
      </button>
    </>
  );
}
