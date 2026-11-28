import { useMemo, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import { Button, Field, Input, Modal, RadioGroup, Select } from "@/components/ui";
import { withoutSecrets } from "@/services/inputRecorder";
import type { RecordedTake, SaveTakeRequest } from "@/store/slices/recordingSlice";
import { recordingPreview } from "./recordingPreview";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { parseTags } from "@/utils/parseTags";
import { recordedTime, recordingName } from "@/utils/recordingText";
import "./Recording.css";
import { t, tf } from "@/i18n/catalog";

/** Props of {@link RecordingSaveDialog}. Mount it with a fresh `key` per take. */
export interface RecordingSaveDialogProps {
  take: RecordedTake;
  /** The stored automations: to add to, and to keep the default name unique. */
  automations: ReadonlyArray<{ id: string; name: string }>;
  /** It opened because a new recording was asked for. */
  startHeld: boolean;
  /** Close and keep the take. */
  onKeep: () => void;
  onDiscard: () => void;
  /** Store it. The dialog stays open, with its fields, while it rejects. */
  onSave: (request: SaveTakeRequest) => Promise<void>;
}

/** Lines of the preview shown. */
const PREVIEW_LINES = 4;

const ENDED_NOTE: Partial<Record<RecordedTake["ended"], string>> = {
  "session-ended": "Recording stopped: the session ended.",
  "tab-gone": "Recording stopped: the terminal was closed or moved to another window.",
};

/**
 * What to do with a finished recording (#5818, slice 8): a new automation, named
 * after what was typed, or another step of an existing one. Closing it keeps the
 * recording (the bar above the terminals offers it again); Discard can be undone.
 * What was typed at a password prompt is named and left out unless the user
 * chooses to store it.
 */
export function RecordingSaveDialog({
  take,
  automations,
  startHeld,
  onKeep,
  onDiscard,
  onSave,
}: RecordingSaveDialogProps) {
  const hasSecrets = take.secrets.length > 0;
  const plain = useMemo(() => withoutSecrets(take), [take]);
  const [to, setTo] = useState<SaveTakeRequest["to"]>("new");
  const [name, setName] = useState(() =>
    recordingName(
      plain,
      take.tabTitle,
      automations.map((a) => a.name)
    )
  );
  const [automationId, setAutomationId] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [keepSecrets, setKeepSecrets] = useState(false);
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const chunks = keepSecrets ? take.chunks : plain;
  const preview = useMemo(() => recordingPreview(take, keepSecrets), [take, keepSecrets]);
  // Replayed, it types its last line and stops there (C-013).
  const noEnter = chunks.length > 0 && !/[\r\n]$/.test(chunks[chunks.length - 1].data);
  const nothingLeft = chunks.length === 0;
  const nameError = to === "new" && name.trim() === "" ? "Name is required." : undefined;
  const automationError = to === "existing" && !automationId ? "Choose an automation." : undefined;
  const canSave = !nothingLeft && !nameError && !automationError;

  const handleSave = () => {
    setTried(true);
    if (!canSave) {
      if (nameError) nameRef.current?.focus();
      return;
    }
    return onSave(
      to === "new"
        ? {
            to,
            keepSecrets,
            name: name.trim(),
            description: normalizeItemDescription(description),
            tags: parseTags(tags),
          }
        : { to, keepSecrets, automationId: automationId ?? "" }
    );
  };

  // Enter in a text field saves (the primary action).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    saveRef.current?.click();
  };

  const prompts = [...new Set(take.secrets.map((s) => s.prompt))].filter((p) => p !== "");
  const note = startHeld
    ? "Save or discard this recording before you start another one."
    : ENDED_NOTE[take.ended];

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
      title="Save recording"
      description="Closing this keeps the recording until you save or discard it"
      onKeyDown={handleKeyDown}
      initialFocusRef={nameRef}
      data-testid="recording-save-dialog"
      footer={
        <>
          {/* What the X does, by name (A-009). */}
          <Button
            variant="secondary"
            className="recording-save__keep"
            onClick={onKeep}
            // Where it goes (live review 2026-11-28).
            title="It waits in a bar above the terminal until you save or discard it"
            data-testid="recording-save-keep"
          >
            Keep for later
          </Button>
          <Button
            variant="ghost"
            className="recording-save__discard"
            onClick={onDiscard}
            data-testid="recording-save-discard"
          >
            Discard recording
          </Button>
          <Button
            ref={saveRef}
            variant="primary"
            onClick={handleSave}
            aria-disabled={!canSave}
            data-invalid={!canSave || undefined}
            errorToast={false}
            data-testid="recording-save-confirm"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="recording-save">
        {note && (
          <p className="recording-save__note" data-testid="recording-save-note">
            {note}
          </p>
        )}
        <div className="recording-save__summary" data-testid="recording-save-summary">
          <span>
            Recorded in {take.tabTitle}, {recordedTime(take.durationMs)}
          </span>
          {preview.length > 0 && (
            <pre className="recording-save__preview">
              {preview.slice(0, PREVIEW_LINES).join("\n")}
              {preview.length > PREVIEW_LINES ? "\n…" : ""}
            </pre>
          )}
        </div>
        {noEnter && (
          <p className="recording-save__note" data-testid="recording-save-no-enter">
            {t("recording.noEnter")}
          </p>
        )}
        {hasSecrets && (
          <div className="recording-save__secrets" data-testid="recording-save-secrets">
            <KeyRound size={14} aria-hidden="true" />
            <div>
              <p>
                {prompts.length > 0
                  ? tf("recording.secretAt", {
                      prompts: prompts.map((p) => `“${p}”`).join(", "),
                    })
                  : t("recording.secretUnknown")}{" "}
                {t("recording.secretStored")}
              </p>
              <RadioGroup
                value={keepSecrets ? "keep" : "leave-out"}
                onValueChange={(value) => setKeepSecrets(value === "keep")}
                aria-label="What was typed at the password prompt"
                options={[
                  {
                    value: "leave-out",
                    label: t("recording.leaveOut"),
                    "data-testid": "recording-save-secrets-leave-out",
                  },
                  {
                    value: "keep",
                    label: "Store it unencrypted",
                    "data-testid": "recording-save-secrets-keep",
                  },
                ]}
              />
            </div>
          </div>
        )}
        {nothingLeft && (
          <p className="recording-save__note" data-testid="recording-save-empty">
            Nothing else was typed, so there is nothing to save.
          </p>
        )}
        {/* Both ways always show; adding is off, with why, while there is no
            automation to add to (live review 2026-11-28). */}
        <RadioGroup
          value={to}
          onValueChange={(value) => setTo(value as SaveTakeRequest["to"])}
          aria-label="Save as"
          options={[
            { value: "new", label: "New automation", "data-testid": "recording-save-to-new" },
            {
              value: "existing",
              label:
                automations.length === 0 ? (
                  <>
                    Add to an automation{" "}
                    <span className="recording-save__option-note">· No automations yet</span>
                  </>
                ) : (
                  "Add to an automation"
                ),
              disabled: automations.length === 0,
              "data-testid": "recording-save-to-existing",
            },
          ]}
        />
        {to === "new" ? (
          <>
            <Field
              label="Name"
              htmlFor="recording-save-name"
              hint="You find it under Automations. Run it there with ▷."
              error={tried ? nameError : undefined}
            >
              <Input
                ref={nameRef}
                id="recording-save-name"
                value={name}
                error={tried && nameError !== undefined}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setName(e.target.value)}
                data-testid="recording-save-name"
              />
            </Field>
            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={detailsOpen}
                icon={detailsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                onClick={() => setDetailsOpen((v) => !v)}
                data-testid="recording-save-details"
              >
                Description and tags
              </Button>
            </div>
            {detailsOpen && (
              <>
                <Field label="Description (optional)" htmlFor="recording-save-description">
                  <Input
                    id="recording-save-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
                    placeholder="What it does"
                    data-testid="recording-save-description"
                  />
                </Field>
                <Field label="Tags (optional, comma-separated)" htmlFor="recording-save-tags">
                  <Input
                    id="recording-save-tags"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="ops, release"
                    data-testid="recording-save-tags"
                  />
                </Field>
              </>
            )}
          </>
        ) : (
          <Field
            label="Automation"
            htmlFor="recording-save-automation"
            hint="The recording goes after its last step."
            error={tried ? automationError : undefined}
          >
            <Select
              id="recording-save-automation"
              value={automationId}
              onChange={setAutomationId}
              options={automations.map((a) => ({ value: a.id, label: a.name }))}
              placeholder="Choose an automation"
              data-testid="recording-save-automation"
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
