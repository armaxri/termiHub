/**
 * Shared UI primitive layer (UI Modernization, Phase 2).
 *
 * Compose app UI from these token-driven primitives rather than hand-rolling
 * buttons, inputs, dialogs, or toggles. Later phases add the async Button
 * lifecycle (Phase 3) and migrate existing call sites (Phase 4).
 */
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Input } from "./Input";
export type { InputProps } from "./Input";

export { NumberInput } from "./NumberInput";
export type { NumberInputProps } from "./NumberInput";

export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";

export { Field } from "./Field";
export type { FieldProps } from "./Field";

export { Select, SelectItem } from "./Select";
export type { SelectProps, SelectOption } from "./Select";

export { Modal, useModalPortalContainer } from "./Modal";
export type { ModalProps } from "./Modal";

export { ConfirmDialog } from "./ConfirmDialog";
export type {
  ConfirmDialogProps,
  ConfirmDialogVariant,
  ConfirmDontAskAgain,
} from "./ConfirmDialog";

export { Toggle } from "./Toggle";
export type { ToggleProps } from "./Toggle";

export { Checkbox } from "./Checkbox";
export type { CheckboxProps, CheckboxChecked } from "./Checkbox";

export { Tooltip, TooltipProvider } from "./Tooltip";
export type { TooltipProps, TooltipProviderProps } from "./Tooltip";

export { Progress } from "./Progress";
export type { ProgressProps } from "./Progress";

export { ToastProvider, toast } from "./Toast";
export type { ToastApi, ToastOptions, ToastPromiseMessages } from "./Toast";
