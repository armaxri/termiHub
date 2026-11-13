# Changes

## Fixed

- Toasts no longer cover an open dialog: they move above it, or into a narrower column
  beside a tall one, so a dialog's fields and buttons stay visible (#5686).
- A connect that first has to unlock the credential store no longer shows a
  "Connecting… / Abort" toast over the unlock dialog; the toast appears once the store
  is unlocked (#5665).
- **Save and connect** no longer shows a "Saved …" toast; the new tab is the
  confirmation (#5665).
- The "Closed … / Reopen" toast goes away when a dialog opens, instead of lingering
  beside it (#5665).
- Running workflows several times in a row shows one "Ran workflow" toast that updates,
  instead of a stack; failures still stay until dismissed (#5675).
