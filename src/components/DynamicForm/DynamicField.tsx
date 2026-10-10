import { useEffect, useId, useState } from "react";
import { open } from "@/services/nativeDialog";
import { HelpCircle, Info, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { SettingsField, FieldType } from "@/types/schema";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { listAgentDockerContainers, listDockerContainers, listSerialPorts } from "@/services/api";
import type { DockerContainerInfo } from "@/services/api";
import {
  composeServicesFromContainers,
  groupContainersByComposeProject,
} from "./dockerContainerGroups";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, Field, Input, Modal, NumberInput, Select, Toggle } from "@/components/ui";
import { fieldPlatformLimitation } from "@/utils/platformFieldSupport";
import { SavedConnectionField, type SavedConnectionContext } from "./SavedConnectionField";
import { backendErrorMessage } from "@/utils/backendErrorCode";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import { textFieldsMatchQuery } from "@/utils/searchMatching";

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
   * Context for `dockerContainer` fields (PROD-017): the connection's selected
   * container runtime (`auto` / `docker` / `podman`) the picker lists from,
   * and whether listing is possible at all. For an agent-hosted connection the
   * local runtime is not the agent's: pass the agent's id so the picker lists
   * the agent host's containers (#3424); without one, listing is disabled and
   * the field falls back to a typed name/ID. Defaults to local listing with
   * `auto`.
   */
  containerContext?: ContainerContext;
  /**
   * Context for `savedConnection` fields (#4194): the saved connections the
   * picker lists and the host an unset picker preselects by.
   */
  savedConnectionContext?: SavedConnectionContext;
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
 * Field types whose widget has no single labelable control (a Radix switch
 * named via `aria-label`, or a list of rows), so the label renders without
 * `htmlFor`.
 */
const LABELLESS_FIELD_TYPES: ReadonlySet<FieldType["type"]> = new Set([
  "boolean",
  "keyValueList",
  "objectList",
]);

/**
 * Renders a single settings field based on its `fieldType`, inside the shared
 * {@link Field} scaffold (label row with required marker and "?" help, inline
 * error).
 *
 * Dispatches to the appropriate input widget (text, password, number,
 * boolean toggle, select, port, file path, saved connection, key-value list,
 * object list).
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
  containerContext,
  savedConnectionContext,
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
  // Platform-honesty note (audit PROD-019): a non-null result means this field's
  // backend feature does nothing on the current platform, so it is disabled and
  // annotated (e.g. RDP audio output on Linux).
  const platformNote = fieldPlatformLimitation(field.key);
  const platformNoteId = platformNote ? `${controlId}-platform-note` : undefined;
  const hasError = Boolean(error);
  const describedBy =
    [hasError ? errorId : null, descriptionId, platformNoteId].filter(Boolean).join(" ") ||
    undefined;
  const a11y: FieldA11y = { id: controlId, describedBy, invalid: hasError };

  return (
    <Field
      variant="settings"
      data-testid={`dynamic-${testIdBase}`}
      label={field.label}
      htmlFor={LABELLESS_FIELD_TYPES.has(field.fieldType.type) ? undefined : controlId}
      required={field.required}
      labelAccessory={<FieldHelp field={field} testIdBase={testIdBase} />}
      error={error || undefined}
      errorId={errorId}
      errorTestId={`${testIdBase}-error`}
    >
      {/* Fragment: each input widget wires its own id / aria-describedby (the
          error, description and platform-note ids above), so Field only renders
          the label row and the inline error. */}
      <>
        {renderFieldInput(
          field,
          field.fieldType,
          value,
          onChange,
          a11y,
          testIdBase,
          availablePorts,
          onBlur,
          platformNote != null,
          containerContext,
          savedConnectionContext
        )}
        {field.description && (
          <p id={descriptionId} className="settings-form__hint">
            {field.description}
          </p>
        )}
        {platformNote && (
          <p
            id={platformNoteId}
            className="settings-form__hint settings-form__hint--warning"
            data-testid={`${testIdBase}-platform-note`}
          >
            {platformNote}
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
      </>
    </Field>
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
  onBlur?: () => void,
  /** Force-disable the control because its feature is unavailable on this
   * platform (audit PROD-019). Currently only honoured by boolean toggles. */
  platformDisabled = false,
  containerContext?: ContainerContext,
  savedConnectionContext?: SavedConnectionContext
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
          disabled={platformDisabled}
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
    case "dockerContainer":
      return (
        <DockerContainerField
          field={field}
          value={value}
          onChange={onChange}
          context={containerContext}
          a11y={a11y}
          testIdBase={testIdBase}
        />
      );
    case "savedConnection":
      return (
        <SavedConnectionField
          field={field}
          value={value}
          onChange={onChange}
          fieldType={fieldType}
          context={savedConnectionContext}
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
  disabled = false,
}: FieldProps & { a11y: FieldA11y; testIdBase: string; disabled?: boolean }) {
  return (
    <>
      <Toggle
        id={a11y.id}
        checked={(value as boolean) ?? (field.default as boolean) ?? false}
        onCheckedChange={(checked) => onChange(checked)}
        disabled={disabled}
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

/** See {@link DynamicFieldProps.containerContext}. */
export interface ContainerContext {
  /** Selected container runtime setting (`auto` / `docker` / `podman`). */
  runtime?: string;
  /** False when the containers cannot be listed at all (agent-hosted, no agent id). */
  listingEnabled: boolean;
  /**
   * List the containers of this connected agent's host instead of the local
   * runtime (#3424). An agent too old to list containers degrades to the
   * typed name/ID field.
   */
  agentId?: string;
}

type ContainerListState =
  | { status: "loading" }
  | { status: "loaded"; containers: DockerContainerInfo[] }
  | { status: "error"; message: string }
  /** The agent predates `docker.list_containers` (#3424). */
  | { status: "unsupported" };

/** Fetch the picker's containers from the agent (when given) or the local runtime. */
async function fetchContainers(
  runtime: string | undefined,
  agentId: string | undefined
): Promise<ContainerListState> {
  if (agentId === undefined) {
    return { status: "loaded", containers: await listDockerContainers(runtime) };
  }
  const result = await listAgentDockerContainers(agentId, runtime);
  return result.supported
    ? { status: "loaded", containers: result.containers }
    : { status: "unsupported" };
}

/** The substring-searchable fields of a container (its ID is prefix-matched separately). */
function containerTextFields(c: DockerContainerInfo): ReadonlyArray<string | undefined> {
  return [c.name, c.image, c.composeProject, c.composeService];
}

/**
 * Match of the typed text against a container's name, image, compose project or
 * compose service (case- and diacritic-insensitive substring, through the shared
 * {@link itemMatchesQuery}, #4582) or its ID. The ID stays a case-insensitive
 * **prefix** match, as `docker` accepts an ID prefix: a substring hit in the
 * middle of a hex ID would only add noise.
 */
export function containerMatches(c: DockerContainerInfo, query: string): boolean {
  const q = query.trim();
  if (q === "") return true;
  return (
    itemMatchesQuery(c, containerTextFields, q) || c.id.toLowerCase().startsWith(q.toLowerCase())
  );
}

/**
 * Compose services whose value matches the typed text (case- and
 * diacritic-insensitive substring, through the shared {@link textFieldsMatchQuery},
 * #4582). An empty query keeps every service.
 */
export function filterComposeServiceGroups<G extends { services: { value: string }[] }>(
  groups: G[],
  query: string
): G[] {
  const q = query.trim();
  return groups
    .map((g) => ({
      ...g,
      services: g.services.filter((sv) => textFieldsMatchQuery([sv.value], q)),
    }))
    .filter((g) => g.services.length > 0);
}

/**
 * Container picker for the Docker connection editor (PROD-017).
 *
 * The text input stays the source of truth — the user can always type a
 * container name or ID — and doubles as the search box for the list of the
 * runtime's containers below it (running first, stopped ones marked). A
 * refresh button re-queries; an unreachable runtime shows its error and leaves
 * the typed fallback working. For an agent-hosted connection the list comes
 * from the agent's host (#3424); an agent too old for that keeps the typed
 * field only. Containers started by Docker Compose are grouped under their
 * project and show their service name (#3425).
 *
 * The `composeService` field uses the same picker in *service mode* (#3784):
 * it lists the Compose services (replicas collapsed) instead of containers and
 * stores `project/service`, which is resolved to the service's running
 * container at connect time.
 */
function DockerContainerField({
  field,
  value,
  onChange,
  context,
  a11y,
  testIdBase,
}: FieldProps & { context?: ContainerContext; a11y: FieldA11y; testIdBase: string }) {
  const listingEnabled = context?.listingEnabled ?? true;
  const serviceMode = field.key === "composeService";
  const typedFallback = serviceMode ? "the service as project/service" : "the container name or ID";
  const runtime = context?.runtime;
  const agentId = context?.agentId;
  const currentValue = (value as string) ?? "";
  const [list, setList] = useState<ContainerListState>({ status: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!listingEnabled) return;
    let cancelled = false;
    setList({ status: "loading" });
    fetchContainers(runtime, agentId)
      .then((next) => {
        if (!cancelled) setList(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setList({ status: "error", message: backendErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [listingEnabled, runtime, agentId, refreshToken]);

  const input = (
    <Input
      id={a11y.id}
      type="text"
      value={currentValue}
      onChange={(e) => onChange(e.target.value || undefined)}
      placeholder={field.placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-required={field.required || undefined}
      aria-describedby={a11y.describedBy}
      error={a11y.invalid}
      data-testid={testIdBase}
    />
  );

  if (!listingEnabled) {
    return (
      <>
        {input}
        <p className="settings-form__hint" data-testid={`${testIdBase}-listing-unavailable`}>
          Container listing is not available for agent connections — type {typedFallback}.
        </p>
      </>
    );
  }

  if (list.status === "unsupported") {
    return (
      <>
        {input}
        <p className="settings-form__hint" data-testid={`${testIdBase}-listing-unsupported`}>
          This agent version cannot list containers — update the agent, or type {typedFallback}.
        </p>
      </>
    );
  }

  const containers = list.status === "loaded" ? list.containers : [];
  const header = (
    <>
      <div className="settings-form__file-row">
        {input}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setRefreshToken((n) => n + 1)}
          disabled={list.status === "loading"}
          title="Refresh container list"
          aria-label="Refresh container list"
          data-testid={`${testIdBase}-refresh`}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>
      {list.status === "loading" && (
        <p className="settings-form__hint" role="status" data-testid={`${testIdBase}-loading`}>
          Loading containers…
        </p>
      )}
      {list.status === "error" && (
        <p
          className="settings-form__hint settings-form__hint--warning"
          data-testid={`${testIdBase}-list-error`}
        >
          Could not list containers: {list.message}. You can still type {typedFallback}.
        </p>
      )}
    </>
  );

  if (serviceMode) {
    const all = composeServicesFromContainers(containers);
    const exactService = all.some((g) => g.services.some((sv) => sv.value === currentValue));
    const shownGroups = exactService ? all : filterComposeServiceGroups(all, currentValue);
    return (
      <>
        {header}
        {list.status === "loaded" && all.length === 0 && (
          <p className="settings-form__hint" data-testid={`${testIdBase}-empty`}>
            No Docker Compose services found.
          </p>
        )}
        {list.status === "loaded" && all.length > 0 && shownGroups.length === 0 && (
          <p className="settings-form__hint" data-testid={`${testIdBase}-no-match`}>
            No listed service matches — it will be used as typed.
          </p>
        )}
        {shownGroups.length > 0 && (
          <ul
            className="settings-form__container-list"
            aria-label="Compose services"
            data-testid={`${testIdBase}-list`}
          >
            {shownGroups.map((g) => {
              const groupId = `project-${g.project}`;
              return (
                <li key={groupId} className="settings-form__container-group">
                  <div
                    className="settings-form__container-group-label"
                    id={`${a11y.id}-${groupId}`}
                    data-testid={`${testIdBase}-group-${groupId}`}
                  >
                    Compose project: {g.project}
                  </div>
                  <ul
                    className="settings-form__container-group-list"
                    aria-labelledby={`${a11y.id}-${groupId}`}
                  >
                    {g.services.map((sv) => {
                      const selected = sv.value === currentValue;
                      return (
                        <li key={sv.value}>
                          <button
                            type="button"
                            className={
                              "settings-form__container-option" +
                              (selected ? " settings-form__container-option--selected" : "") +
                              (sv.running > 0 ? "" : " settings-form__container-option--stopped")
                            }
                            aria-pressed={selected}
                            onClick={() => onChange(sv.value)}
                            data-testid={`${testIdBase}-option-${sv.value}`}
                          >
                            <span className="settings-form__container-name">{sv.service}</span>
                            <span className="settings-form__container-meta">
                              {sv.running > 0
                                ? `${sv.running} of ${sv.replicas} running`
                                : "not running"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  // An exact match means the user already picked one: show the full list so
  // they can switch, rather than filtering it down to the single match.
  const exact = containers.some((c) => c.name === currentValue || c.id === currentValue);
  const shown = exact ? containers : containers.filter((c) => containerMatches(c, currentValue));
  const groups = groupContainersByComposeProject(shown);

  const renderOption = (c: DockerContainerInfo) => {
    const selected = c.name === currentValue || c.id === currentValue;
    return (
      <li key={c.id}>
        <button
          type="button"
          className={
            "settings-form__container-option" +
            (selected ? " settings-form__container-option--selected" : "") +
            (c.running ? "" : " settings-form__container-option--stopped")
          }
          aria-pressed={selected}
          onClick={() => onChange(c.name)}
          title={c.id}
          data-testid={`${testIdBase}-option-${c.name}`}
        >
          <span className="settings-form__container-name">
            {c.name}
            {c.composeService && (
              <span
                className="settings-form__container-service"
                data-testid={`${testIdBase}-service-${c.name}`}
              >
                service: {c.composeService}
              </span>
            )}
          </span>
          <span className="settings-form__container-meta">
            {c.image}
            {c.image && " · "}
            {c.running ? c.status || "running" : `not running (${c.status || c.state})`}
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      {header}
      {list.status === "loaded" && containers.length === 0 && (
        <p className="settings-form__hint" data-testid={`${testIdBase}-empty`}>
          No containers found.
        </p>
      )}
      {list.status === "loaded" && containers.length > 0 && shown.length === 0 && (
        <p className="settings-form__hint" data-testid={`${testIdBase}-no-match`}>
          No listed container matches — it will be used as typed.
        </p>
      )}
      {shown.length > 0 && (
        <ul
          className="settings-form__container-list"
          aria-label="Containers"
          data-testid={`${testIdBase}-list`}
        >
          {groups.length === 1 && groups[0].project === null
            ? groups[0].containers.map(renderOption)
            : groups.map((g) => {
                const label = g.project ?? "Other containers";
                const groupId = g.project === null ? "other" : `project-${g.project}`;
                return (
                  <li key={groupId} className="settings-form__container-group">
                    <div
                      className="settings-form__container-group-label"
                      id={`${a11y.id}-${groupId}`}
                      data-testid={`${testIdBase}-group-${groupId}`}
                    >
                      {g.project === null ? label : `Compose project: ${label}`}
                    </div>
                    <ul
                      className="settings-form__container-group-list"
                      aria-labelledby={`${a11y.id}-${groupId}`}
                    >
                      {g.containers.map(renderOption)}
                    </ul>
                  </li>
                );
              })}
        </ul>
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

function KeyValueListField({ value, onChange, testIdBase }: FieldProps & { testIdBase: string }) {
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
