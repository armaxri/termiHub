### Fixed

- Opening a dialog no longer throws away an undo offer such as "Closed “web” · Reopen" or
  "Deleted … · Undo" (#5914). The offer hides while the dialog is open and comes back, with the
  time it had left, once the dialog closes. A tab closed from a live session's confirm dialog joins
  the hidden "Closed … tabs" toast. Plain confirmations still go away when a dialog opens.
