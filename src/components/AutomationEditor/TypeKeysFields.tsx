import { useRef, useState } from "react";
import type React from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowUp, CornerDownLeft, Plus, Trash2 } from "lucide-react";
import { Button, Field, Input, NumberInput, Select } from "@/components/ui";
import { DEFAULT_FIXED_DELAY_MS, MAX_STEP_DELAY_MS } from "@/services/macroPlayback";
import type { TypingSpeed } from "@/types/generated/TypingSpeed";
import { isImeComposing } from "@/utils/imeComposition";
import { newKeyDraft, type KeyDraft, type StepDraft, type TypeKeysStep } from "./automationDraft";
import { MoreKeys } from "./MoreKeys";
import { useStepEditor } from "./stepEditorContext";
import { TYPING_SPEEDS, typingSpeedLabel } from "./stepMeta";

/** Key rows rendered before "Show all": a long recording has hundreds. */
export const SHOWN_KEY_ROWS = 50;

/** Props of {@link TypeKeysFields}. */
export interface TypeKeysFieldsProps {
  draft: StepDraft;
  step: TypeKeysStep;
  path: string;
  stepNumber: number;
  onChange: (draft: StepDraft) => void;
}

/**
 * The keys a Type keys step types (PROD-039, #5818): one row per chunk in a
 * lossless escape notation (see `keysFormat`), so control keys are visible and
 * editable, and the typing speed saved with the step (#5820). An untouched row
 * saves back byte for byte.
 */
export function TypeKeysFields({ draft, step, path, stepNumber, onChange }: TypeKeysFieldsProps) {
  const { errors } = useStepEditor();
  const [showAll, setShowAll] = useState(false);
  const [moreKeys, setMoreKeys] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const keys = draft.keys ?? [];
  const errorBase = `steps.${draft.uid}.keys`;
  const speed: TypingSpeed = step.timing ?? "recorded";
  // A delay only counts at the recorded speed, and not before the first keys:
  // those are always typed at once.
  const showDelays = speed === "recorded";
  // A row with an error to show is never hidden.
  const lastError = keys.reduce(
    (last, key, i) =>
      errors[`${errorBase}.${key.uid}.text`] || errors[`${errorBase}.${key.uid}.delayMs`]
        ? i
        : last,
    -1
  );
  const shown = showAll ? keys.length : Math.max(SHOWN_KEY_ROWS, lastError + 1);

  const setKeys = (next: KeyDraft[]) => onChange({ ...draft, keys: next });
  const update = (index: number, patch: Partial<KeyDraft>) =>
    setKeys(keys.map((k, i) => (i === index ? { ...k, ...patch } : k)));
  const move = (index: number, to: number) => {
    const next = keys.slice();
    [next[index], next[to]] = [next[to], next[index]];
    setKeys(next);
  };

  /** Change the rows, then focus the text of row `index` (from the end: -1). */
  const setKeysAndFocus = (next: KeyDraft[], index: number) => {
    flushSync(() => {
      setKeys(next);
      if (index === -1) setShowAll(true);
    });
    const inputs = Array.from(
      rootRef.current?.querySelectorAll<HTMLInputElement>(".type-keys__text") ?? []
    );
    inputs[index < 0 ? inputs.length + index : index]?.focus();
  };

  /** Where the caret was last, in which row; the end of the last row before that. */
  const caret = useRef<{ uid: string; at: number } | null>(null);
  const insertAtCaret = (text: string) => {
    const known = keys.findIndex((key) => key.uid === caret.current?.uid);
    const index = known < 0 ? keys.length - 1 : known;
    if (index < 0) return;
    const row = keys[index];
    const at = Math.min(known < 0 ? row.text.length : (caret.current?.at ?? 0), row.text.length);
    update(index, { text: `${row.text.slice(0, at)}${text}${row.text.slice(at)}` });
    caret.current = { uid: row.uid, at: at + text.length };
  };

  const setSpeed = (timing: TypingSpeed) => onChange({ ...draft, step: { ...step, timing } });

  return (
    <div
      ref={rootRef}
      className="type-keys"
      role="group"
      aria-label={`Keys of step ${stepNumber}`}
      data-testid={`automation-editor-keys-${path}`}
    >
      <p
        className="type-keys__hint"
        id={`automation-step-keys-hint-${path}`}
        data-testid={`automation-editor-keys-hint-${path}`}
      >
        Typed exactly as written; press Enter to add <code>⏎</code>.{" "}
        <Button
          variant="ghost"
          size="sm"
          className="type-keys__more"
          aria-expanded={moreKeys}
          onClick={() => setMoreKeys((v) => !v)}
          data-testid={`automation-editor-keys-more-${path}`}
        >
          More keys
        </Button>
      </p>
      {moreKeys && <MoreKeys path={path} onInsert={insertAtCaret} />}
      <div className="type-keys__rows">
        {keys.slice(0, shown).map((key, i) => (
          <KeyRow
            key={key.uid}
            draft={key}
            id={`${path}-${i}`}
            number={i + 1}
            stepNumber={stepNumber}
            last={i === keys.length - 1}
            showDelay={showDelays && i > 0}
            hintId={`automation-step-keys-hint-${path}`}
            error={
              errors[`${errorBase}.${key.uid}.text`] ?? errors[`${errorBase}.${key.uid}.delayMs`]
            }
            textInvalid={errors[`${errorBase}.${key.uid}.text`] !== undefined}
            only={keys.length === 1}
            onCaret={(at) => {
              caret.current = { uid: key.uid, at };
            }}
            onChange={(patch) => update(i, patch)}
            onMove={(direction) => move(i, i + direction)}
            onDelete={
              keys.length > 1
                ? () =>
                    setKeysAndFocus(
                      keys.filter((_, j) => j !== i),
                      Math.min(i, keys.length - 2)
                    )
                : undefined
            }
          />
        ))}
      </div>
      <div className="type-keys__actions">
        {keys.length > shown && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll(true)}
            data-testid={`automation-editor-keys-show-all-${path}`}
          >
            Show all {keys.length} rows
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={12} />}
          onClick={() => setKeysAndFocus([...keys, newKeyDraft(false)], -1)}
          data-testid={`automation-editor-keys-add-${path}`}
        >
          Add keys
        </Button>
      </div>
      {/* With one row there is nothing between rows to time (B-012). */}
      {(keys.length > 1 || speed !== "recorded") && (
        <div className="automation-step__inline">
          <Field label="Typing speed" htmlFor={`automation-step-speed-${path}`}>
            <Select
              id={`automation-step-speed-${path}`}
              value={speed}
              onChange={(value) => setSpeed(value as TypingSpeed)}
              options={TYPING_SPEEDS.map((value) => ({
                value,
                label: typingSpeedLabel(value, step.recorded === true),
              }))}
              data-testid={`automation-editor-step-speed-${path}`}
            />
          </Field>
          {speed === "fixed" && (
            <Field label="Delay (ms)" htmlFor={`automation-step-fixed-delay-${path}`}>
              <NumberInput
                id={`automation-step-fixed-delay-${path}`}
                value={step.fixedDelayMs ?? ""}
                min={0}
                max={MAX_STEP_DELAY_MS}
                step={10}
                placeholder={String(DEFAULT_FIXED_DELAY_MS)}
                onValueChange={(v) => {
                  const next = { ...step };
                  if (v === "") delete next.fixedDelayMs;
                  else next.fixedDelayMs = Math.max(0, Math.round(v));
                  onChange({ ...draft, step: next });
                }}
                data-testid={`automation-editor-step-fixed-delay-${path}`}
              />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

interface KeyRowProps {
  draft: KeyDraft;
  /** `<step path>-<row index>`, unique in the editor. */
  id: string;
  number: number;
  stepNumber: number;
  last: boolean;
  showDelay: boolean;
  /** The only row: nothing to move it past, and it cannot be deleted. */
  only: boolean;
  /** The caret moved to this place in the text. */
  onCaret: (at: number) => void;
  hintId: string;
  error?: string;
  textInvalid: boolean;
  onChange: (patch: Partial<KeyDraft>) => void;
  onMove: (direction: -1 | 1) => void;
  /** Absent for the only row. */
  onDelete?: () => void;
}

/** One row of keys: its text, the delay before it, and what can be done with it. */
function KeyRow({
  draft,
  id,
  number,
  stepNumber,
  last,
  showDelay,
  only,
  onCaret,
  hintId,
  error,
  textInvalid,
  onChange,
  onMove,
  onDelete,
}: KeyRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `automation-step-keys-error-${id}`;
  const label = `keys ${number} of step ${stepNumber}`;

  /** Replace `start`..`end` of the text with an Enter key (`⏎`). */
  const insertEnter = (start: number, end: number) => {
    flushSync(() => onChange({ text: `${draft.text.slice(0, start)}⏎${draft.text.slice(end)}` }));
    // Keep typing after it: React puts the caret at the end of a changed value.
    inputRef.current?.setSelectionRange(start + 1, start + 1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || isImeComposing(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    const { selectionStart, selectionEnd } = e.currentTarget;
    const start = selectionStart ?? draft.text.length;
    insertEnter(start, selectionEnd ?? start);
  };

  return (
    <div className="type-keys__row-group">
      <div className="type-keys__row" data-testid={`automation-editor-keys-row-${id}`}>
        <span className="type-keys__index" aria-hidden="true">
          {number}
        </span>
        <Input
          ref={inputRef}
          className="type-keys__text"
          size="sm"
          value={draft.text}
          onChange={(e) => onChange({ text: e.target.value })}
          onKeyDown={handleKeyDown}
          onSelect={(e) => onCaret(e.currentTarget.selectionStart ?? draft.text.length)}
          placeholder="e.g. ls -la⏎"
          spellCheck={false}
          autoComplete="off"
          aria-label={`Keys ${number} of step ${stepNumber}`}
          error={textInvalid}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          data-testid={`automation-editor-keys-text-${id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Add Enter to ${label}`}
          icon={<CornerDownLeft size={12} />}
          onClick={() => insertEnter(draft.text.length, draft.text.length)}
          data-testid={`automation-editor-keys-enter-${id}`}
        >
          Enter
        </Button>
        {showDelay && (
          <span className="type-keys__delay">
            <NumberInput
              size="sm"
              value={draft.delayMs}
              min={0}
              step={10}
              error={Boolean(error) && !textInvalid}
              onValueChange={(delayMs) => onChange({ delayMs })}
              aria-label={`Delay before ${label} in milliseconds`}
              data-testid={`automation-editor-keys-delay-${id}`}
            />
            <span className="type-keys__unit">ms</span>
          </span>
        )}
        {!only && (
          <span className="type-keys__row-actions">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move ${label} up`}
              disabled={number === 1}
              icon={<ArrowUp size={12} />}
              onClick={() => onMove(-1)}
              data-testid={`automation-editor-keys-up-${id}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move ${label} down`}
              disabled={last}
              icon={<ArrowDown size={12} />}
              onClick={() => onMove(1)}
              data-testid={`automation-editor-keys-down-${id}`}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Delete ${label}`}
              disabled={!onDelete}
              icon={<Trash2 size={12} />}
              onClick={() => onDelete?.()}
              data-testid={`automation-editor-keys-delete-${id}`}
            />
          </span>
        )}
      </div>
      {error && (
        <p
          className="type-keys__error"
          id={errorId}
          role="alert"
          data-testid={`automation-editor-keys-error-${id}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
