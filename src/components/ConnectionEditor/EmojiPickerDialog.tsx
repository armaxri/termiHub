import { EmojiPicker, type EmojiPickerListCategoryHeaderProps } from "frimousse";
import type { EmojiPickerListEmojiProps, EmojiPickerListRowProps } from "frimousse";
import { Modal, Button, Spinner } from "@/components/ui";
import { resolveBundledEmojiData } from "@/utils/emojiPickerData";
import "./EmojiPickerDialog.css";

interface EmojiPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the picked emoji (skin tone applied); the dialog then closes. */
  onEmojiSelect: (emoji: string) => void;
}

/** Sticky category header of the emoji list. */
function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div className="emoji-picker__category" {...props}>
      {category.label}
    </div>
  );
}

/** One row of emoji buttons. */
function Row({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div className="emoji-picker__row" {...props}>
      {children}
    </div>
  );
}

/** One emoji button; `data-active` marks the hovered / keyboard-active one. */
function EmojiButton({ emoji, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      type="button"
      className="emoji-picker__emoji"
      aria-label={emoji.label}
      data-testid="emoji-picker-emoji"
      {...props}
    >
      {emoji.emoji}
    </button>
  );
}

/**
 * Searchable emoji picker (#5008) built on frimousse — categories, skin tones
 * and arrow-key navigation from the search field — fed with the bundled
 * Emojibase data so it works offline. Picking an emoji applies it and closes.
 */
export function EmojiPickerDialog({ open, onOpenChange, onEmojiSelect }: EmojiPickerDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Choose Emoji"
      footer={
        <Button
          variant="secondary"
          onClick={() => onOpenChange(false)}
          data-testid="emoji-picker-cancel"
        >
          Cancel
        </Button>
      }
    >
      <EmojiPicker.Root
        className="emoji-picker"
        columns={9}
        resolveEmojiData={resolveBundledEmojiData}
        onEmojiSelect={({ emoji }) => {
          onEmojiSelect(emoji);
          onOpenChange(false);
        }}
        data-testid="emoji-picker"
      >
        <div className="emoji-picker__header">
          <EmojiPicker.Search
            className="ui-input emoji-picker__search"
            placeholder="Search emoji..."
            aria-label="Search emoji"
            autoFocus
            data-testid="emoji-picker-search"
          />
          <EmojiPicker.SkinToneSelector
            className="emoji-picker__skin-tone"
            aria-label="Change skin tone"
            title="Change skin tone"
            data-testid="emoji-picker-skin-tone"
          />
        </div>
        <EmojiPicker.Viewport className="emoji-picker__viewport">
          <EmojiPicker.Loading className="emoji-picker__status">
            <Spinner size="sm" /> Loading emoji…
          </EmojiPicker.Loading>
          <EmojiPicker.Empty className="emoji-picker__status">No emoji found.</EmojiPicker.Empty>
          <EmojiPicker.List
            className="emoji-picker__list"
            components={{ CategoryHeader, Row, Emoji: EmojiButton }}
          />
        </EmojiPicker.Viewport>
        <div className="emoji-picker__footer" aria-live="polite">
          <EmojiPicker.ActiveEmoji>
            {({ emoji }) =>
              emoji ? (
                <>
                  <span className="emoji-picker__preview">{emoji.emoji}</span>
                  <span className="emoji-picker__label">{emoji.label}</span>
                </>
              ) : (
                <span className="emoji-picker__label">
                  Type to search, use the arrow keys to move, Enter to pick.
                </span>
              )
            }
          </EmojiPicker.ActiveEmoji>
        </div>
      </EmojiPicker.Root>
    </Modal>
  );
}
